const {
  test, expect, tasks, taskByTitle, details, openTask,
  openProjectView, expectOrder, scalarResponse,
} = require("./fixtures/regression.cjs");
const { createIsolatedProject } = require("./fixtures/isolated-project.cjs");
const { withOrdinaryResponsibleGroup } = require("./fixtures/design.cjs");
const { randomUUID } = require("node:crypto");

async function expectViewCommandsHidden(page) {
  await expect(page.getByRole("button", { name: "Новая задача", exact: true })
    .and(page.locator("[data-create-task]"))).toBeEnabled();
  await expect(page.getByRole("group", { name: "Представление проекта" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Дополнительно", exact: true })).toHaveCount(0);
}
async function expectChecklistHidden(panel) {
  await expect(panel.getByRole("button", { name: "Добавить пункт", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("checkbox", { name: /^Отметить пункт:/ })).toHaveCount(0);
  await expect(panel.getByText("Чек-лист", { exact: true })).toHaveCount(0);
}

require("./fixtures/request-regression.cjs");

// Configure each spec explicitly; a cached helper cannot configure later files.
// Login inputs, cookies and private canaries must not enter browser artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("#59 core regression — isolated PostgreSQL required", () => {
  test.describe.configure({ timeout: 60_000 });
  test("UI create → edit → reload preserves fields and exactly one task", async ({ page, project }) => {
    await project.openBoard(page);
    const title = `E2E created ${project.runId}`;
    const description = `Synthetic description ${project.runId}`;
    await page.getByRole("button", { name: "Новая задача", exact: true })
      .and(page.locator("[data-create-task]")).click();
    const dialog = page.getByRole("dialog", { name: "Новая задача", exact: true });
    await dialog.getByLabel("Название", { exact: true }).fill(title);
    await dialog.getByLabel("Описание", { exact: true }).fill(description);
    const created = page.waitForResponse(res =>
      new URL(res.url()).pathname === "/api/tasks" && res.request().method() === "POST");
    await dialog.getByRole("button", { name: "Создать задачу", exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(dialog).toHaveCount(0);
    const task = await taskByTitle(page, project, title);
    expect((await details(page, task.id)).description).toBe(description);
    const panel = await openTask(page, project, title);
    const updatedTitle = `${title} edited`;
    const saved = scalarResponse(page, task.id);
    await panel.getByLabel("Название задачи", { exact: true }).fill(updatedTitle);
    expect((await saved).status()).toBe(200);
    await expect(panel.getByRole("status", { name: "Название сохранено" })).toBeVisible();
    await page.reload();
    const persisted = await details(page, task.id);
    expect(persisted.title).toBe(updatedTitle);
    expect(persisted.description).toBe(description);
    expect((await tasks(page, project)).length).toBe(5);
    await expect(page.getByLabel("Название задачи", { exact: true })).toHaveValue(updatedTitle);
  });

  test("supported view URLs persist while view commands remain hidden", async ({ page, project }) => {
    await project.openBoard(page);
    await expectViewCommandsHidden(page);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await openProjectView(page, project, "table");
    await expect(page.getByRole("table", { name: "Задачи проекта" })).toBeVisible();
    await expect(page.getByRole("table").getByRole("row").filter({ hasText: "Task A" })).toHaveCount(1);
    await page.reload();
    await expect(page).toHaveURL(url => url.searchParams.get("view") === "table");
    await expect(page.getByRole("table", { name: "Задачи проекта" })).toBeVisible();
    await expectViewCommandsHidden(page);
    await openProjectView(page, project, "calendar");
    await expect(page.getByRole("status").filter({ hasText: "Нет задач с дедлайнами" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Вперёд", exact: true })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(url => url.searchParams.get("view") === "calendar");
    await expectViewCommandsHidden(page);
    await openProjectView(page, project, "board");
    await expectOrder(page, project, "К выполнению", ["Task A", "Task B", "Task C"]);
    await expectViewCommandsHidden(page);
    await expect(page.getByRole("combobox")).toHaveCount(0);
  });

  for (const input of ["pointer", "keyboard"]) {
    test(`${input} reorder persists exact order, task identity and status`, async ({ page, project }, info) => {
      test.skip(!project.dndV2Enabled, "This regression requires modern DnD; legacy RED checks remain in the existing suite.");
      test.skip(input === "pointer" && Boolean(info.project.use.isMobile), "Pointer drag requires desktop; keyboard/menu coverage is separate.");

    await withOrdinaryResponsibleGroup(project, async () => {
        await project.openBoard(page);
        const before = await taskByTitle(page, project, "Task B");
        const moved = page.waitForResponse(res =>
          new URL(res.url()).pathname === `/api/tasks/${before.id}/move` && res.request().method() === "POST");
        if (input === "pointer") {
          await project.dragTask(page, "Task B", { column: "К выполнению", before: "Task A" });
        } else {
          const handle = project.card(page, "Task B").getByRole("button", { name: "Переместить задачу «Task B»" });
          await handle.focus();
          await handle.press("Space");
          await expect(page.getByRole("status").filter({ hasText: /Поднята задача «Task B»/ })).toBeAttached();
          await page.keyboard.press("ArrowUp");
          await expectOrder(page, project, "К выполнению", ["Task B", "Task A", "Task C"]);
          await page.keyboard.press("Space");
        }
        expect((await moved).status()).toBe(200);
        await expectOrder(page, project, "К выполнению", ["Task B", "Task A", "Task C"]);
        await page.reload();
        await expectOrder(page, project, "К выполнению", ["Task B", "Task A", "Task C"]);
        const persisted = (await tasks(page, project)).filter(task => task.columnId === before.columnId)
          .sort((a, b) => a.rank.localeCompare(b.rank));
        expect(persisted.map(task => task.title)).toEqual(["Task B", "Task A", "Task C"]);
        expect(persisted.find(task => task.id === before.id).status).toBe("TODO");
        expect(new Set((await tasks(page, project)).map(task => task.id)).size).toBe(4);
    });
  });
  }

  test("move menu persists canonical column and status after reload", async ({ page, project }) => {

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      const task = await taskByTitle(page, project);
      const moved = page.waitForResponse(res => new URL(res.url()).pathname === `/api/tasks/${task.id}/move` && res.request().method() === "POST");
      await project.moveWithMenu(page, "Task A", "В колонку «В работе»");
      expect((await moved).status()).toBe(200);
      await page.reload();
      await expectOrder(page, project, "В работе", ["Task D", "Task A"]);
      const persisted = await details(page, task.id);
      expect(persisted.columnId).toBe(project.columns["В работе"]);
      expect(persisted.status).toBe("IN_PROGRESS");
    });
  });

  test("stored checklist API changes persist while checklist UI remains hidden after reload", async ({ page, project }) => {
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const text = `Synthetic checklist ${project.runId}`;
    const headers = { Origin: new URL(page.url()).origin };
    const created = await page.request.post(`/api/tasks/${task.id}/checklist`, { headers, data: { text } });
    expect(created.status()).toBe(201);
    const item = (await created.json()).data;
    const operationId = randomUUID();
    const update = () => page.request.patch(`/api/tasks/${task.id}/checklist/${item.id}`, {
      headers: { ...headers, "X-Operation-Id": operationId }, data: { completed: true },
    });
    expect((await update()).status()).toBe(200);
    expect((await update()).status()).toBe(200);
    const panel = await openTask(page, project);
    await expectChecklistHidden(panel);
    await page.reload();
    const reloadedPanel = page.getByRole("dialog", { name: "Детали задачи" });
    await expect(reloadedPanel).toBeVisible();
    await expect(reloadedPanel.getByLabel("Название задачи", { exact: true })).toHaveValue(task.title);
    await expectChecklistHidden(reloadedPanel);
    const matching = (await details(page, task.id)).checklistItems.filter(item => item.text === text);
    expect(matching.length).toBe(1);
    expect(matching[0].completed).toBe(true);
  });

  test("authenticated outsider cannot read or mutate another fixture's task", async ({ browser, page, project }) => {
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const other = await createIsolatedProject();
    let context;
    try {
      context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      const outsider = await context.newPage();
      await other.fixture.openBoard(outsider);
      const read = await outsider.request.get(`/api/tasks/${task.id}?view=details`);
      expect(read.status()).toBe(404); // Deliberate concealment in detailsGET, not a missing feature.
      expect((await read.json()).success).toBe(false);
      const write = await outsider.request.patch(`/api/tasks/${task.id}`, {
        headers: { Origin: new URL(outsider.url()).origin },
        data: { operationId: require("node:crypto").randomUUID(), expectedVersion: task.version, changes: { title: "Unauthorized synthetic change" } },
      });
      expect(write.status()).toBe(404);
      expect((await write.json()).success).toBe(false);
      expect((await details(page, task.id)).title).toBe("Task A");
      expect((await details(page, task.id)).version).toBe(task.version);
    } finally {
      try { await context?.close(); } finally { await other.cleanup(); }
    }
  });

  test("upload rejects an empty synthetic file without a network request", async ({ page, project }) => {
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const panel = await openTask(page, project);
    let uploads = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/uploads/direct") uploads++; });
    await panel.getByRole("region", { name: "Описание и свойства задачи", exact: true }).locator('input[type="file"]').setInputFiles({ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
    await expect(panel.getByText("Пустой файл загрузить нельзя", { exact: true })).toBeVisible();
    expect(uploads).toBe(0);
    await page.reload();
    expect((await details(page, task.id)).attachments).toEqual([]);
  });

  test("saved view API persists preferences while saved-view UI remains hidden after reload", async ({ page, project }) => {
    await project.openBoard(page);
    const name = `Synthetic view ${project.runId}`;
    const saved = await page.request.post("/api/saved-views", {
      headers: { Origin: new URL(page.url()).origin },
      data: { name, projectId: project.projectId, viewType: "board", filters: { status: project.columns["К выполнению"] } },
    });
    expect(saved.status()).toBe(201);
    await expectViewCommandsHidden(page);
    await page.reload();
    await expectViewCommandsHidden(page);
    await expect(page.getByRole("dialog", { name: "Сохраненные представления" })).toHaveCount(0);
    const response = await page.request.get(`/api/saved-views?projectId=${project.projectId}`);
    expect(response.status()).toBe(200);
    const matching = (await response.json()).data.filter(view => view.name === name);
    expect(matching.length).toBe(1);
    expect(matching[0].filters.status).toBe(project.columns["К выполнению"]);
  });

  test("table bulk priority persists for selected tasks only", async ({ page, project }) => {
    await project.openBoard(page);
    await openProjectView(page, project, "table");
    await expectViewCommandsHidden(page);
    const table = page.getByRole("table", { name: "Задачи проекта" });
    for (const title of ["Task A", "Task B"]) {
      await table.getByRole("row").filter({ hasText: title }).getByRole("checkbox", { name: "Выбрать строку" }).check();
    }
    const toolbar = page.getByRole("region", { name: "Действия с выбранными задачами" });
    await toolbar.getByRole("combobox", { name: "Изменить приоритет" }).click();
    const updated = page.waitForResponse(res => new URL(res.url()).pathname === "/api/tasks/bulk" && res.request().method() === "PATCH");
    await page.getByRole("option", { name: "Высокий", exact: true }).click();
    expect((await updated).status()).toBe(200);
    await expect(toolbar).toHaveCount(0);
    await page.reload();
    await expect(table).toBeVisible();
    const persisted = await tasks(page, project);
    expect(persisted.length).toBe(4);
    expect(persisted.filter(task => ["Task A", "Task B"].includes(task.title)).map(task => task.priority)).toEqual(["HIGH", "HIGH"]);
    expect(persisted.find(task => task.title === "Task D").priority).toBe("URGENT");
  });

  test("template API create/use persists a new task while template UI remains hidden after reload", async ({ page, project }) => {
    await project.openBoard(page);
    const source = await taskByTitle(page, project);
    const panel = await openTask(page, project);
    await expect(panel.getByRole("button", { name: "Сохранить как шаблон", exact: true })).toHaveCount(0);
    const name = `Synthetic template ${project.runId}`;
    const headers = { Origin: new URL(page.url()).origin };
    const created = await page.request.post("/api/templates", { headers, data: {
      projectId: project.projectId, name, templateTitle: source.title,
      templateDescription: source.description, priority: source.priority,
    } });
    expect(created.status()).toBe(201);
    const template = (await created.json()).data;
    const used = await page.request.post(`/api/templates/${template.id}/use`, { headers });
    expect(used.status()).toBe(201);
    await page.reload();
    const reloadedPanel = page.getByRole("dialog", { name: "Детали задачи" });
    await expect(reloadedPanel).toBeVisible();
    await expect(reloadedPanel.getByLabel("Название задачи", { exact: true })).toHaveValue(source.title);
    await expect(page.getByRole("button", { name: "Сохранить как шаблон", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Шаблоны задач", exact: true })).toHaveCount(0);
    await reloadedPanel.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expectViewCommandsHidden(page);
    const persisted = await tasks(page, project);
    expect(persisted.length).toBe(5);
    const clones = persisted.filter(task => task.title === source.title && task.id !== source.id);
    expect(clones.length).toBe(1);
    expect(clones[0].description).toBe(source.description);
    expect(clones[0].priority).toBe(source.priority);
  });
});
