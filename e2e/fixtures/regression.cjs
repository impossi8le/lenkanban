const { test, expect } = require("./isolated-project.cjs");

async function tasks(page, project) {
  const response = await page.request.get(`/api/tasks?projectId=${project.projectId}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
  return body.data;
}

async function taskByTitle(page, project, title = "Task A") {
  const matches = (await tasks(page, project)).filter(task => task.title === title);
  expect(matches.length, "Exactly one persisted task with this title").toBe(1);
  return matches[0];
}

async function details(page, taskId) {
  const response = await page.request.get(`/api/tasks/${taskId}?view=details`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  return body.data;
}

async function openTask(page, project, title = "Task A") {
  const card = project.card(page, title);
  const visibleTitle = card.getByText(title, { exact: true });
  await expect(visibleTitle).toBeVisible();
  await visibleTitle.click();
  const panel = page.getByRole("dialog", { name: "Детали задачи" });
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Название задачи", { exact: true })).toBeEnabled();
  return panel;
}

async function openProjectView(page, project, view) {
  if (!["board", "table", "calendar"].includes(view)) throw new Error("Unsupported project view");
  await page.goto(`/projects/${encodeURIComponent(project.projectId)}/board?view=${view}`);
  await expect(page).toHaveURL(url => url.pathname === `/projects/${encodeURIComponent(project.projectId)}/board` && url.searchParams.get("view") === view);
  await expect(page.getByRole("heading", { name: project.projectName, exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Представление проекта" })).toHaveCount(0);
}

async function addChecklistItem(page, panel, text) {
  await panel.getByRole("button", { name: "Добавить пункт", exact: true }).click();
  await panel.getByLabel("Новый пункт чек-листа").fill(text);
  const response = page.waitForResponse(res =>
    /\/api\/tasks\/[^/]+\/checklist$/.test(new URL(res.url()).pathname) &&
    res.request().method() === "POST");
  await panel.getByRole("button", { name: "Добавить элемент", exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(panel.getByRole("checkbox", { name: `Отметить пункт: ${text}`, exact: true })).toBeVisible();
}

async function expectOrder(page, project, column, expected) {
  await expect.poll(() => project.taskTitles(page, column)).toEqual(expected);
}

function scalarResponse(page, taskId) {
  return page.waitForResponse(res =>
    new URL(res.url()).pathname === `/api/tasks/${taskId}` &&
    res.request().method() === "PATCH");
}

module.exports = { test, expect, tasks, taskByTitle, details, openTask, openProjectView, addChecklistItem, expectOrder, scalarResponse };
