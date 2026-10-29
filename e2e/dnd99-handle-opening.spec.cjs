// @ts-check
const { createHash } = require("node:crypto");
const { test, expect, loadPrismaClient } = require("./fixtures/isolated-project.cjs");

// Canonical dedicated-test-DB guard keeps this durable spec portable to CI.
// The work execution runner additionally pins the locally approved host/port.
// Validation/collection itself does not connect or instantiate Prisma.
const { parseTestDatabaseUrl } = require("./fixtures/safety.cjs");
parseTestDatabaseUrl(process.env.E2E_DATABASE_URL);

// Real credential entry must not enter traces, videos or failure screenshots.
test.use({ trace: "off", video: "off", screenshot: "off" });

async function cleanupOrdinaryGroup(db, project, groupId) {
  if (!groupId) return;
  await db.project.updateMany({ where: { id: project.projectId, ownerId: project.userId,
    description: `[${project.runMarker}] isolated browser fixture`, responsibleGroupId: groupId },
    data: { responsibleGroupId: null } });
  await db.responsibleGroup.deleteMany({ where: { id: groupId, name: project.runMarker } });
}

async function prepare(project, globalRole, lifecycle = false) {
  expect(project.dndV2Enabled).toBe(true);
  if (lifecycle) await project.configureLifecycle({ memberIds: [project.userId] });
  const db = loadPrismaClient(process.env.E2E_DATABASE_URL);
  let ordinaryGroupId = null;
  try {
    // Global USER is a real active support-group member, not a global admin.
    // ADMIN setup changes only this run's synthetic actor, before real login.
    expect(await db.project.count({ where: { id: project.projectId, ownerId: project.userId,
      description: `[${project.runMarker}] isolated browser fixture` } })).toBe(1);
    expect(await db.user.count({ where: { id: project.userId, email: project.email,
      globalRole: "USER", isBlocked: false, blockedAt: null } })).toBe(1);
    if (!lifecycle) {
      // Explicit support membership grants real status permission without
      // lifecycle configuration. Do not add/remove a lifecycle map to get a handle.
      const ordinary = await db.project.findUniqueOrThrow({ where: { id: project.projectId },
        select: { lifecycleColumnMap: true, responsibleGroupId: true } });
      expect(ordinary).toEqual({ lifecycleColumnMap: null, responsibleGroupId: null });
      ordinaryGroupId = await db.$transaction(async tx => {
        const group = await tx.responsibleGroup.create({ data: { name: project.runMarker,
          members: { create: { userId: project.userId } } } });
        const linked = await tx.project.updateMany({ where: { id: project.projectId, ownerId: project.userId,
          description: `[${project.runMarker}] isolated browser fixture`, responsibleGroupId: null },
          data: { responsibleGroupId: group.id } });
        expect(linked.count).toBe(1);
        return group.id;
      });
    }
    if (globalRole === "ADMIN") {
      const updated = await db.user.updateMany({ where: { id: project.userId, email: project.email,
        globalRole: "USER", isBlocked: false, blockedAt: null }, data: { globalRole: "ADMIN" } });
      expect(updated.count).toBe(1);
    }
    expect(await db.user.count({ where: { id: project.userId, email: project.email, globalRole } })).toBe(1);
    expect(await db.taskRequest.count({ where: { task: { projectId: project.projectId } } })).toBe(0);
    const task = await db.task.findFirstOrThrow({ where: { projectId: project.projectId, title: "Task C" },
      select: { id: true, columnId: true, rank: true, version: true, status: true } });
    return { db, task, ordinaryGroupId };
  } catch (error) {
    try { await cleanupOrdinaryGroup(db, project, ordinaryGroupId); }
    finally { await db.$disconnect(); }
    throw error;
  }
}

async function handlePoint(project, page) {
  const handle = project.card(page, "Task C").getByRole("button", {
    name: "Переместить задачу «Task C»", exact: true,
  });
  await expect(handle).toBeVisible();
  await expect(handle).toBeEnabled();
  await expect(handle).not.toHaveAttribute("aria-disabled", "true");
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw Error("Synthetic drag handle has no viewport geometry");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (point.x < 0 || point.y < 0 || point.x >= viewport.width - 16 || point.y >= viewport.height - 16) {
    throw Error("Synthetic drag handle is outside the bounded input viewport");
  }
  return point;
}

async function expectFirstClickOpens(project, page, taskId, input) {
  const taskPath = `/projects/${project.projectId}/tasks/${taskId}`;
  const boardPath = `/projects/${project.projectId}/board`;
  const expectedUrl = new URL(taskPath, page.url()).href;
  let redirectedToBoardOrCatalog = false;
  const observeNavigation = frame => {
    if (frame !== page.mainFrame()) return;
    const pathname = new URL(frame.url()).pathname;
    if ([boardPath, "/projects", "/sign-in"].includes(pathname)) redirectedToBoardOrCatalog = true;
  };
  page.on("framenavigated", observeNavigation);
  try {
    // Exactly one completed native click/tap. Never retry the click if no route
    // change occurs; URL/dialog expectations fail rather than issuing a second.
    const title = page.getByRole("button", { name: "Открыть задачу «Task C»", exact: true })
      .or(page.locator('[data-priority][role="button"]').getByText("Task C", { exact: true }));
    if (input === "touch") await title.tap();
    else await title.click();
    await expect(page).toHaveURL(expectedUrl, { timeout: 10_000 });
    const dialog = page.getByRole("dialog", { name: "Детали задачи", exact: true });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("textbox", { name: "Название задачи", exact: true })).toHaveValue("Task C");
    expect(redirectedToBoardOrCatalog, "First click must not redirect to the board/catalog/login").toBe(false);
  } finally { page.off("framenavigated", observeNavigation); }
}

async function exercise({ page, project }, globalRole, gesture) {
  const { db, task, ordinaryGroupId } = await prepare(project, globalRole);
  let moveRequests = 0;
  const observeMove = request => {
    if (request.method() === "POST" && /^\/api\/tasks\/[^/]+\/move$/.test(new URL(request.url()).pathname)) moveRequests += 1;
  };
  page.on("request", observeMove);
  try {
    await project.openBoard(page); // Existing real auth; no auth/route intercepts.
    const sessionResponse = await page.request.get("/api/auth/session");
    expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json();
    expect(session.user?.id === project.userId).toBe(true);
    const permission = await page.request.get(`/api/projects/${project.projectId}/task-permissions`);
    expect(permission.status()).toBe(200);
    expect((await permission.json()).data.canChangeStatus).toBe(true);
    const projectMetadata = await page.request.get(`/api/projects/${project.projectId}`);
    expect(projectMetadata.status()).toBe(200);
    expect((await projectMetadata.json()).data.lifecycleColumnMap).toBeNull();
    const point = await handlePoint(project, page);
    if (gesture === "touch-release") {
      await page.touchscreen.tap(point.x, point.y);
    } else {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      try {
        if (gesture === "escape-cancel") {
          await page.mouse.move(point.x + 12, point.y + 12, { steps: 4 });
          // Prove the real sensor activated, not merely that a no-op click ended.
          await expect(page.getByRole("status").filter({
            hasText: /Поднята задача «Task C» из колонки/,
          })).toBeAttached();
          await page.keyboard.press("Escape");
        }
      } finally { await page.mouse.up(); }
    }
    // No sleep, reload, task-route warmup, extra click or transport mock here.
    await expectFirstClickOpens(project, page, task.id, gesture === "touch-release" ? "touch" : "mouse");
    expect(moveRequests, "Stationary release/cancel must not send a move command").toBe(0);
    const after = await db.task.findUniqueOrThrow({ where: { id: task.id },
      select: { id: true, columnId: true, rank: true, version: true, status: true } });
    expect(after).toEqual(task);
  } finally {
    page.off("request", observeMove);
    try {
      // NextAuth also creates a per-identity limiter row; remove only this
      // fresh synthetic email's exact key, not a shared IP or whole table.
      const emailHash = createHash("sha256").update(project.email, "utf8").digest("hex").slice(0, 32);
      await db.rateLimit.deleteMany({ where: { key: `auth:login:email:${emailHash}` } });
    } finally {
      try { await cleanupOrdinaryGroup(db, project, ordinaryGroupId); }
      finally { await db.$disconnect(); }
    }
    // Existing project fixture finally deletes only its unique run project,
    // group and synthetic actor, including the temporary ADMIN identity.
  }
}

for (const globalRole of ["USER", "ADMIN"]) {
  test.describe(`#99 ${globalRole}: native mouse`, () => {
    // Capability modifier runs before the project/auth fixture: a skipped
    // platform must not create disposable users/projects just to report skip.
    test.skip(({ hasTouch }) => Boolean(hasTouch), "Mouse scenario is desktop-only; native touch is separate");
    for (const gesture of ["stationary-release", "escape-cancel"]) {
      test(`${gesture} then FIRST card click opens exact task`, async ({ page, project }) => {
        await exercise({ page, project }, globalRole, gesture);
      });
    }
  });
  test.describe(`#99 ${globalRole}: native touch`, () => {
    test.skip(({ hasTouch }) => !hasTouch, "Requires a real Playwright hasTouch project; no DOM-dispatched touch events");
    test("stationary touch then FIRST card tap opens exact task", async ({ page, project }) => {
      await exercise({ page, project }, globalRole, "touch-release");
    });
  });
}

// #106 is in this already-discovered spec so collection needs no config change.
async function lifecycleSnapshot(db, project) {
  const [metadata, tasks, activities, commands, moves, requests] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: project.projectId },
      select: { boardRevision: true, lifecycleColumnMap: true, responsibleGroupId: true } }),
    db.task.findMany({ where: { projectId: project.projectId }, orderBy: { id: "asc" },
      select: { id: true, columnId: true, rank: true, position: true, version: true, status: true, updatedAt: true } }),
    db.activity.count({ where: { task: { projectId: project.projectId } } }),
    db.taskCommandOperation.count({ where: { projectId: project.projectId } }),
    db.taskMoveOperation.count({ where: { projectId: project.projectId } }),
    db.taskRequest.count({ where: { task: { projectId: project.projectId } } }),
  ]);
  return { metadata, tasks, activities, commands, moves, requests };
}

for (const globalRole of ["USER", "ADMIN"]) {
  test(`#106 ${globalRole}: lifecycle hides manual moves and repeated FIRST opens survive close/reload`, async ({ page, project, hasTouch }) => {
    const { db, task } = await prepare(project, globalRole, true);
    let moveRequests = 0;
    const observeMove = request => {
      if (request.method() === "POST" && /^\/api\/tasks\/[^/]+\/move$/.test(new URL(request.url()).pathname)) moveRequests += 1;
    };
    page.on("request", observeMove);
    try {
      const before = await lifecycleSnapshot(db, project);
      expect(before.metadata.lifecycleColumnMap).toEqual(project.lifecycleColumnMap);
      await project.openBoard(page);
      const sessionResponse = await page.request.get("/api/auth/session");
      expect(sessionResponse.status()).toBe(200);
      expect((await sessionResponse.json()).user?.id === project.userId).toBe(true);
      const permission = await page.request.get(`/api/projects/${project.projectId}/task-permissions`);
      expect(permission.status()).toBe(200);
      expect((await permission.json()).data.canChangeStatus).toBe(true);
      const boardPath = `/projects/${project.projectId}/board`;
      const taskPath = `/projects/${project.projectId}/tasks/${task.id}`;
      const assertBoard = async () => {
        await expect(page).toHaveURL(url => url.pathname === boardPath);
        await expect(page.getByRole("heading", { name: project.projectName, exact: true })).toBeVisible();
        await expect(project.card(page, "Task C").getByText("Task C", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /Переместить задачу/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Действия задачи/ })).toHaveCount(0);
      };
      const close = async () => {
        await page.getByRole("dialog", { name: "Детали задачи", exact: true })
          .getByRole("button", { name: "Закрыть", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Детали задачи", exact: true })).toHaveCount(0);
        await assertBoard();
      };
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await assertBoard();
        await expectFirstClickOpens(project, page, task.id, hasTouch ? "touch" : "mouse");
        await close(); // Actual intercepted modal close, without direct navigation.
        await expectFirstClickOpens(project, page, task.id, hasTouch ? "touch" : "mouse");
        await page.reload(); // Direct task render must also survive refresh.
        await expect(page).toHaveURL(url => url.pathname === taskPath);
        const panel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("textbox", { name: "Название задачи", exact: true })).toHaveValue("Task C");
        await close();
        await page.reload(); // Fresh board must preserve lifecycle suppression.
      }
      await assertBoard();
      expect(moveRequests, "Opening/closing/reloading lifecycle cards must never attempt arbitrary moves").toBe(0);
      expect(await lifecycleSnapshot(db, project)).toEqual(before);
    } finally {
      page.off("request", observeMove);
      try {
        const emailHash = createHash("sha256").update(project.email, "utf8").digest("hex").slice(0, 32);
        await db.rateLimit.deleteMany({ where: { key: `auth:login:email:${emailHash}` } });
      } finally { await db.$disconnect(); }
    }
  });
}
