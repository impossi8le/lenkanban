const { test, expect, capture, accessible, controlsFit, openTask, activeRequestBoard } = require("./fixtures/design.cjs");
const { openProjectView } = require("./fixtures/regression.cjs");

// The board requests `/api/tasks?projectId=…&limit=…`; match the route and its
// parameters, not a literal query string, so added parameters cannot bypass the stub.
const matchesTaskList = (projectId) => (url) =>
  url.pathname === "/api/tasks" && url.searchParams.get("projectId") === projectId;
const matchesMyTasks = (url) =>
  url.pathname === "/api/tasks" && url.searchParams.get("assignedToMe") === "true";

test.describe("#60 controlled visual states", () => {
  test.describe.configure({ timeout: 90_000 });
  // Each view renders its own task-query state. Keep the selected view's actual
  // announcement, rather than accepting another view's loader or chunk fallback.
  const announcements = {
    board: { loading: "Загрузка задач...", error: "Не удалось загрузить задачи" },
    table: { loading: "Загрузка таблицы...", error: "Не удалось загрузить таблицу задач" },
    calendar: { loading: "Загрузка календаря...", error: "Не удалось загрузить календарь" },
  };
  for (const view of ["board", "table", "calendar"]) {
    for (const state of ["loading", "error"]) {
      test(`${view} ${state}`, async ({ page, project }, info) => {
        let release;
        let intercepted = 0;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route(matchesTaskList(project.projectId), async route => {
          intercepted++;
          if (state === "loading") await gate;
          await route.fulfill({ status: 503, json: { success: false, error: { code: "VISUAL_UNAVAILABLE", message: "Synthetic unavailable" } } });
        });
        try {
          await openProjectView(page, project, view);
          await expect.poll(() => intercepted, "The selected view must request the controlled task list").toBeGreaterThan(0);
          const status = page.getByRole(state === "loading" ? "status" : "alert").filter({ hasText: announcements[view][state] });
          await expect(status).toBeAttached(); // Board loading announcement is intentionally sr-only.
          if (view !== "board" || state !== "loading") await expect(status).toBeVisible();
          await capture(page, info, `${view}-${state}`);
          await accessible(page);
        } finally { release(); }
      });
    }
  }

  for (const state of ["loading", "empty", "error"]) {
    test(`chat ${state}`, async ({ page, project }, info) => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route("**/api/tasks/*/messages?limit=50", async route => {
        if (state === "loading") await gate;
        await route.fulfill(state === "error"
          ? { status: 503, json: { success: false, error: { code: "VISUAL_UNAVAILABLE", message: "Synthetic unavailable" } } }
          : { json: { success: true, data: { items: [], nextCursor: null, canReadInternal: false } } });
      });
      try {
        const panel = await openTask(page, project);
        await expect(panel.getByText(/^Чат задачи · офлайн(?: \(.+\))?$/)).toBeAttached();
        const discussion = panel.getByRole("region", { name: "Обсуждение", exact: true });
        await discussion.scrollIntoViewIfNeeded();
        await expect(discussion.getByText({ loading: "Загрузка...", empty: "Пока нет сообщений", error: "Не удалось загрузить сообщения." }[state], { exact: true })).toBeVisible();
        await capture(page, info, `chat-${state}`);
        await accessible(page);
      } finally { release(); }
    });
  }

  for (const state of ["loading", "empty", "error"]) {
    test(`my tasks ${state}`, async ({ page }, info) => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route(matchesMyTasks, async route => {
        if (state === "loading") await gate;
        await route.fulfill(state === "error"
          ? { status: 503, json: { success: false, error: { code: "VISUAL_UNAVAILABLE", message: "Synthetic unavailable" } } }
          : { json: { success: true, data: [] } });
      });
      try {
        await page.goto("/my-tasks");
        if (state === "loading") await expect(page.getByRole("status").filter({ hasText: "Загрузка..." })).toBeVisible();
        if (state === "empty") {
          await expect(page.getByRole("heading", { name: "Назначено мне", exact: true })).toBeVisible();
          await activeRequestBoard(page, { empty: true });
        }
        if (state === "error") {
          await expect(page.getByRole("alert").filter({ hasText: "Не удалось обновить список обращений" })).toBeVisible();
          await controlsFit(page, page.getByRole("button", { name: "Повторить загрузку задач", exact: true }));
        }
        await capture(page, info, `my-tasks-${state}`);
        await accessible(page);
      } finally { release(); }
    });
  }

  test("board, table and calendar empty", async ({ page, project }, info) => {
    // Exact project list only; authentication/details/mutations are not intercepted.
    await page.route(matchesTaskList(project.projectId), route => route.fulfill({ json: { success: true, data: [] } }));
    await page.reload();
    await expect(project.card(page, "Task A")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: project.projectName })).toBeVisible();
    await activeRequestBoard(page, { empty: true });
    await expect(page.getByRole("status").filter({ hasText: "Загрузка задач..." })).toHaveCount(0);
    for (const name of ["board", "table", "calendar"]) {
      await openProjectView(page, project, name);
      if (name === "table") await expect(page.getByRole("table", { name: "Задачи проекта" })).toBeVisible();
      if (name === "calendar") await expect(page.getByRole("status").filter({ hasText: "Нет задач с дедлайнами" })).toBeVisible();
      await capture(page, info, `${name}-empty`);
      await accessible(page);
    }
  });
});
