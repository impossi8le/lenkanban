const { test, expect, capture, accessible, controlsFit, openTask, activeRequestBoard, LONG_TITLE } = require("./fixtures/design.cjs");
const { openProjectView } = require("./fixtures/regression.cjs");

test.describe("#60 visual screens", () => {
  test.describe.configure({ timeout: 90_000 });

  test("board with long data", async ({ page, project }, info) => {
    await expect(project.card(page, LONG_TITLE)).toBeAttached();
    await expect(page.locator("button[data-create-task]")).toBeVisible();
    await controlsFit(page, page.locator("button[data-create-task]"));
    if (process.env.E2E_VISUAL_MUTATION_CHECK === "1") {
      if (info.config.updateSnapshots !== "none") throw new Error("Never update baselines during the mutation check");
      await page.addStyleTag({ content: "html { filter: invert(1) !important; }" });
    }
    await capture(page, info, "board-long");
    await accessible(page);
  });

  test("table with long data", async ({ page, project }, info) => {
    await openProjectView(page, project, "table");
    const table = page.getByRole("table", { name: "Задачи проекта" });
    await expect(table.getByRole("row").filter({ hasText: LONG_TITLE })).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Поиск задач в таблице", exact: true })).toBeVisible();
    await controlsFit(page, page.getByRole("textbox", { name: "Поиск задач в таблице", exact: true }));
    await capture(page, info, "table-long");
    await accessible(page);
  });

  test("calendar with fixed deadlines", async ({ page, project }, info) => {
    await openProjectView(page, project, "calendar");
    await expect(page.getByRole("button", { name: "Вперёд", exact: true })).toBeVisible();
    // Check navigation before revealing the event: controlsFit scrolls its
    // target into view and can scroll a reachable agenda event out again.
    await controlsFit(page, page.getByRole("button", { name: "Вперёд", exact: true }));
    if (page.viewportSize().width >= 640) {
      await expect(page.getByRole("table", { name: "Month View", exact: true })).toBeVisible();
      // Month cells collapse events. The overflow link drills into a timed day slot,
      // which intentionally truncates long titles. Use the real list control
      // to reach the complete, wrapped event, as compact calendars already do.
      await page.getByRole("button", { name: "Список", exact: true }).click();
    }
    const longEvent = page.getByRole("button", { name: `Открыть задачу: ${LONG_TITLE}`, exact: true });
    await expect(longEvent).toBeVisible();
    await controlsFit(page, longEvent);
    await expect(longEvent).toBeInViewport({ ratio: 1 });
    await capture(page, info, "calendar");
    await accessible(page);
  });

  test("my tasks with assigned long data", async ({ page }, info) => {
    await page.goto("/my-tasks");
    await expect(page.getByRole("heading", { name: "Назначено мне", exact: true })).toBeVisible();
    await activeRequestBoard(page);
    await expect(page.getByRole("button", { name: `Открыть задачу «${LONG_TITLE}»`, exact: true })).toBeVisible();
    await controlsFit(page, page.getByRole("textbox", { name: "Поиск обращений", exact: true }));
    await controlsFit(page, page.getByRole("combobox", { name: "Категория", exact: true }));
    await capture(page, info, "my-tasks-long");
    await accessible(page);
  });

  test("task details and offline chat with synthetic history", async ({ page, project }, info) => {
    // Controlled offline transport; this is visual coverage, not realtime acceptance.
    const panel = await openTask(page, project);
    // Discussion is inline on every width; await its real HTTP read before capture.
    await expect(panel.getByText("Синтетическое обсуждение. " + LONG_TITLE, { exact: true })).toBeAttached();
    // The parenthetical transport detail appears only after a socket error.
    await expect(panel.getByText(/^Чат задачи · офлайн(?: \(.+\))?$/)).toBeAttached();
    await controlsFit(page, panel.getByRole("button", { name: "Закрыть", exact: true }));
    await capture(page, info, "task-details");
    await accessible(page);
    const discussion = panel.getByRole("region", { name: "Обсуждение", exact: true });
    await discussion.scrollIntoViewIfNeeded();
    await expect(discussion.getByText("Синтетическое обсуждение. " + LONG_TITLE, { exact: true })).toBeVisible();
    await expect(discussion.getByText(/Чат задачи.*офлайн/)).toBeVisible();
    await controlsFit(page, discussion.getByRole("button", { name: "Отправить сообщение", exact: true }));
    await capture(page, info, "task-chat-offline-long");
    await accessible(page);
  });

  test("removed additional and view controls stay absent", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Дополнительно", exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Представление проекта" })).toHaveCount(0);
    await accessible(page);
  });

  for (const menu of ["theme", "user"]) {
    test(`${menu} menu and keyboard focus`, async ({ page }, info) => {
      const exerciseMenu = async () => {
        const trigger = page.getByRole("banner").getByRole("button", { name: { theme: "Выбрать тему", user: "Открыть меню пользователя" }[menu], exact: true });
        await trigger.focus();
        await trigger.press("Enter");
        await expect(page.getByRole("menu")).toBeVisible();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("menuitem").and(page.locator(":focus"))).toHaveCount(1);
        await expect(page.getByRole("menuitem").and(page.locator(":focus"))).toBeEnabled();
        await controlsFit(page, page.getByRole("menuitem"));
        await capture(page, info, `menu-${menu}`);
        await accessible(page);
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      };
      await exerciseMenu();
    });
  }

  test("request archive and keyboard return", async ({ page, project }, info) => {
    await activeRequestBoard(page);
    await expect(project.card(page, "Task A").getByRole("button", { name: "Действия задачи «Task A»" })).toHaveCount(0);
    const trigger = page.locator(".request-archive-button");
    await trigger.focus();
    await trigger.press("Enter");
    const archive = page.getByRole("region", { name: "Колонки обращений", exact: true });
    await expect(archive.locator("[data-request-stage]")).toHaveCount(3);
    for (const state of ["CLOSED", "CANCELLED", "DRAFT"]) {
      await expect(archive.locator(`[data-request-stage="${state}"]`).getByRole("heading")).toBeVisible();
    }
    await expect(project.card(page, "Task A")).toHaveCount(0);
    await controlsFit(page, trigger);
    await capture(page, info, "board-archive");
    await accessible(page);
    await trigger.press("Enter");
    await activeRequestBoard(page);
    await expect(project.card(page, "Task A")).toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("new task dialog and focus return", async ({ page }, info) => {
    const trigger = page.locator("button[data-create-task]");
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Обращение в Техподдержку", exact: true });
    const title = panel.getByLabel("Кратко о проблеме", { exact: true });
    const longInput = LONG_TITLE.slice(0, 200);
    await title.fill(longInput);
    await expect(title).toHaveValue(longInput);
    await expect(title).toHaveAttribute("maxlength", "200");
    await controlsFit(page, panel.getByRole("button", { name: "Отправить обращение", exact: true }));
    await capture(page, info, "new-task-dialog-long");
    await accessible(page);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
