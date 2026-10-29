const { randomUUID } = require("node:crypto");
const { test, expect, taskByTitle, details } = require("./regression.cjs");
const { createIsolatedProject, loadPrismaClient, runBestEffortCleanup } = require("./isolated-project.cjs");

async function actorId(page) {
  const response = await page.request.get("/api/auth/session");
  expect(response.status()).toBe(200);
  const id = (await response.json()).user?.id;
  expect(typeof id).toBe("string");
  return id;
}

async function snapshot(page, taskId) {
  const response = await page.request.get(`/api/tasks/${taskId}/lifecycle`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

function command(page, taskId, data) {
  return page.request.post(`/api/tasks/${taskId}`, {
    headers: { Origin: new URL(page.url()).origin }, data,
  });
}

async function transition(page, taskId, action, extra = {}) {
  const before = await snapshot(page, taskId);
  const response = await command(page, taskId, {
    operationId: randomUUID(), expectedVersion: before.version, action, ...extra,
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  return body.data;
}

// Registered from core-regression so the existing root config selects these
// cases too. No skip/fixme or success-on-503 fallback is used here.
test.describe("#59 request lifecycle", () => {
  test.describe.configure({ timeout: 90_000 });
  test("#89 submit retry → take → clarification → answer → solve → executor close → author reopen", async ({ page, browser, project }) => {
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const worker = await createIsolatedProject();
    const db = loadPrismaClient(process.env.E2E_DATABASE_URL);
    let context;
    try {
      context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      const executor = await context.newPage();
      await worker.fixture.openBoard(executor);
      const executorId = await actorId(executor);
      expect(executorId).toBe(worker.fixture.userId);
      const { lifecycleColumnMap: map } = await project.configureLifecycle({ memberIds: [executorId] });
      expect(new Set([map.submittedColumnId, map.inProgressColumnId, map.needsInfoColumnId, map.completedColumnId, map.closedColumnId]).size).toBe(5);
      await page.reload();
      const submit = { operationId: randomUUID(), expectedVersion: task.version, action: "submit" };
      const sent = await command(page, task.id, submit);
      expect(sent.status()).toBe(200);
      const submitted = (await sent.json()).data;
      expect(submitted.state).toBe("SUBMITTED");
      const retry = await command(page, task.id, submit);
      expect(retry.status()).toBe(200);
      expect((await retry.json()).data).toMatchObject({ state: "SUBMITTED", version: submitted.version, replayed: true });
      expect(await db.taskRequest.count({ where: { taskId: task.id } })).toBe(1);
      expect(await db.activity.count({ where: { taskId: task.id, action: "request_submitted" } })).toBe(1);
      expect(await details(page, task.id)).toMatchObject({ columnId: map.submittedColumnId, status: "TODO" });
      const stale = await command(page, task.id, {
        operationId: randomUUID(), expectedVersion: task.version, action: "cancel",
      });
      expect(stale.status()).toBe(409);
      expect(await snapshot(page, task.id)).toMatchObject({ state: "SUBMITTED", version: submitted.version });
      expect(await transition(executor, task.id, "take")).toMatchObject({ state: "IN_PROGRESS", executorId });
      expect(await details(page, task.id)).toMatchObject({ columnId: map.inProgressColumnId, status: "IN_PROGRESS" });

      const denied = await command(page, task.id, {
        operationId: randomUUID(), expectedVersion: (await snapshot(page, task.id)).version, action: "cancel",
      });
      expect(denied.status()).toBe(403);
      expect((await snapshot(page, task.id)).state).toBe("IN_PROGRESS");
      await transition(executor, task.id, "request_info", { reason: "Synthetic clarification" });
      expect(await details(page, task.id)).toMatchObject({ columnId: map.needsInfoColumnId, status: `COLUMN_${map.needsInfoColumnId}` });
      const paused = await db.taskRequest.findUniqueOrThrow({ where: { taskId: task.id }, select: { needsInfoSince: true } });
      const comment = await page.request.post(`/api/tasks/${task.id}/messages`, {
        data: { clientId: randomUUID(), contentText: "Synthetic answer", visibility: "PUBLIC" },
      });
      expect(comment.status()).toBe(201);
      const commentId = (await comment.json()).data.id;
      expect(typeof commentId).toBe("string");
      expect((await snapshot(page, task.id)).state).toBe("NEEDS_INFO");
      expect((await db.taskRequest.findUniqueOrThrow({ where: { taskId: task.id } })).needsInfoSince).toEqual(paused.needsInfoSince);
      const empty = await command(page, task.id, {
        operationId: randomUUID(), expectedVersion: (await snapshot(page, task.id)).version, action: "answer_info",
      });
      expect(empty.status()).toBe(400);
      expect((await snapshot(page, task.id)).state).toBe("NEEDS_INFO");
      expect(await transition(page, task.id, "answer_info", { response: { commentId } })).toMatchObject({ state: "IN_PROGRESS", executorId });
      expect(await details(page, task.id)).toMatchObject({ columnId: map.inProgressColumnId, status: "IN_PROGRESS" });
      expect(await transition(executor, task.id, "complete")).toMatchObject({ state: "COMPLETED", executorId });
      expect(await details(page, task.id)).toMatchObject({ columnId: map.completedColumnId, status: "IN_REVIEW" });
      const close = { operationId: randomUUID(), expectedVersion: (await snapshot(page, task.id)).version, action: "close" };
      expect((await command(page, task.id, close)).status()).toBe(403);
      expect(await db.activity.count({ where: { taskId: task.id, action: "request_closed" } })).toBe(0);
      expect((await command(executor, task.id, close)).status()).toBe(200);
      const closeRetry = await command(executor, task.id, close);
      expect(closeRetry.status()).toBe(200);
      expect((await closeRetry.json()).data).toMatchObject({ state: "CLOSED", executorId, replayed: true });
      expect(await details(page, task.id)).toMatchObject({ columnId: map.closedColumnId, status: "DONE" });
      expect(await db.activity.count({ where: { taskId: task.id, action: "request_closed" } })).toBe(1);
      expect(await transition(page, task.id, "reopen", { reason: "Synthetic reopening reason" })).toMatchObject({ state: "IN_PROGRESS", executorId });
      await page.reload();
      expect(await snapshot(page, task.id)).toMatchObject({ state: "IN_PROGRESS", executorId });
      expect((await details(page, task.id)).projectId).toBe(project.projectId);
      expect(await details(page, task.id)).toMatchObject({ columnId: map.inProgressColumnId, status: "IN_PROGRESS" });
    } finally {
      await runBestEffortCleanup([
        { label: "close executor context", run: async () => { await context?.close(); } },
        // TaskRequest uses Restrict FKs; remove only this run's marker before
        // the existing project fixture tears down its synthetic rows.
        { label: "remove exact request marker", run: () => db.taskRequest.deleteMany({ where: { taskId: task.id, task: { projectId: project.projectId } } }) },
        { label: "cleanup worker", run: () => worker.cleanup() },
        { label: "disconnect request fixture", run: () => db.$disconnect() },
      ]);
    }
  });
  test("#89 active responsible-group leader closes through UI; author reopens CLOSED with required reason", async ({ page, browser, project }) => {
    let worker, leader, db, task;
    const contexts = [];
    try {
      worker = await createIsolatedProject(); leader = await createIsolatedProject();
      db = loadPrismaClient(process.env.E2E_DATABASE_URL);
      const { lifecycleColumnMap: map } = await project.configureLifecycle({ memberIds: [worker.fixture.userId, leader.fixture.userId], leaderId: leader.fixture.userId });
      await project.openBoard(page); task = await taskByTitle(page, project);
      const executorContext = await browser.newContext({ baseURL: test.info().project.use.baseURL }); contexts.push(executorContext);
      const leaderContext = await browser.newContext({ baseURL: test.info().project.use.baseURL }); contexts.push(leaderContext);
      const executor = await executorContext.newPage(), groupLeader = await leaderContext.newPage();
      await worker.fixture.openBoard(executor); await leader.fixture.openBoard(groupLeader);
      await transition(page, task.id, "submit");
      await transition(executor, task.id, "take");
      await transition(executor, task.id, "complete");
      expect(await details(page, task.id)).toMatchObject({ columnId: map.completedColumnId, status: "IN_REVIEW" });
      expect((await snapshot(groupLeader, task.id)).permissions).toMatchObject({ isLeader: false, isResponsibleGroupLeader: true, canClose: true });
      await groupLeader.goto(`/projects/${project.projectId}/tasks/${task.id}`);
      await expect(groupLeader.getByRole("button", { name: "Закрыть заявку", exact: true })).toBeVisible();
      const closed = groupLeader.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${task.id}` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "close");
      await groupLeader.getByRole("button", { name: "Закрыть заявку", exact: true }).click();
      expect((await closed).status()).toBe(200);
      await expect(groupLeader.getByText("Заявка закрыта", { exact: true })).toBeVisible();
      await expect(groupLeader.getByRole("button", { name: "Закрыть заявку", exact: true })).toHaveCount(0);
      expect(await snapshot(groupLeader, task.id)).toMatchObject({ state: "CLOSED" });
      expect(await details(groupLeader, task.id)).toMatchObject({ columnId: map.closedColumnId, status: "DONE" });
      expect(await db.activity.count({ where: { taskId: task.id, userId: leader.fixture.userId, action: "request_closed" } })).toBe(1);
      await page.goto(`/projects/${project.projectId}/tasks/${task.id}`);
      await page.getByRole("button", { name: "Переоткрыть", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Переоткрыть заявку", exact: true });
      const confirm = dialog.getByRole("button", { name: "Переоткрыть", exact: true });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel("Причина", { exact: true }).fill("Synthetic author reopening after group leader close");
      const reopened = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${task.id}` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "reopen");
      await confirm.click(); expect((await reopened).status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      await page.reload();
      expect(await snapshot(page, task.id)).toMatchObject({ state: "IN_PROGRESS", executorId: worker.fixture.userId });
      expect(await details(page, task.id)).toMatchObject({ columnId: map.inProgressColumnId, status: "IN_PROGRESS" });
    } finally {
      await runBestEffortCleanup([
        { label: "close lifecycle actor contexts", run: async () => { for (const context of contexts) await context.close(); } },
        { label: "remove exact UI lifecycle marker", run: async () => { if (db && task) await db.taskRequest.deleteMany({ where: { taskId: task.id, task: { projectId: project.projectId } } }); } },
        { label: "cleanup lifecycle executor", run: async () => { await worker?.cleanup(); } },
        { label: "cleanup lifecycle group leader", run: async () => { await leader?.cleanup(); } },
        { label: "disconnect UI lifecycle fixture", run: async () => { await db?.$disconnect(); } },
      ]);
    }
  });
});

module.exports = { actorId };
