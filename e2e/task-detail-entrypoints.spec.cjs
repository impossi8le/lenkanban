const { test, expect, taskByTitle, details } = require("./fixtures/regression.cjs");

async function expectTaskPanel(page, task) {
  const panel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
  await expect(panel).toBeVisible();
  const title = panel.getByLabel("Название задачи", { exact: true });
  await expect(title).toBeVisible();
  await expect(title).toBeEnabled();
  await expect(title).toHaveValue(task.title);
  await expect(panel.getByRole("region", { name: "Описание и свойства задачи", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Закрыть", exact: true })).toBeVisible();
  return panel;
}

test.describe("TaskDetailPanel real route entrypoints (#46)", () => {
  for (const entry of ["board-card", "direct-link", "modal-query"]) {
    test(`${entry} opens the persisted task details`, async ({ page, project }) => {
      await project.openBoard(page);
      const task = await details(page, (await taskByTitle(page, project)).id);
      const taskPath = `/projects/${project.projectId}/tasks/${task.id}`;

      if (entry === "board-card") {
        // Client navigation from the board uses the intercepted @modal route.
        await project.card(page, task.title).getByText(task.title, { exact: true }).click();
      } else if (entry === "direct-link") {
        // A document navigation must render the standalone task page.
        await page.goto(taskPath);
      } else {
        // The supported board deep link opens the intercepted modal via replace.
        await page.goto(`/projects/${project.projectId}/board?view=board&task=${encodeURIComponent(task.id)}`);
      }

      await expect(page).toHaveURL(url => url.pathname === taskPath);
      const panel = await expectTaskPanel(page, task);
      const board = page.getByRole("heading", { name: "Канбан-доска", exact: true });
      if (entry === "direct-link") {
        await expect(board).toHaveCount(0);
      } else {
        // Distinguish a real modal over the board from the standalone fallback.
        await expect(board).toBeAttached();
      }
      await panel.getByRole("button", { name: "Закрыть", exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === `/projects/${project.projectId}/board`);
      await expect(panel).toHaveCount(0);
      await expect(project.card(page, task.title)).toBeVisible();
    });
  }
});
