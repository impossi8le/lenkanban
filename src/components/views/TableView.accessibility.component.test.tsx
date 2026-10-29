import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/views/BulkActionsToolbar", () => ({ BulkActionsToolbar: () => <p>Выбранные задачи</p> }));
import { TableView } from "./TableView";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  document.querySelectorAll('aside[role="dialog"]').forEach(node => node.remove());
  clients.splice(0).forEach(client => client.clear());
  mocks.apiFetch.mockReset();
});

const task: TaskType = { id: "task-1", title: "Проверить отчёт", projectId: "project-1", priority: "MEDIUM", columnId: "todo", position: 0, assignees: [], tags: [] };

function clientFor(tasks?: TaskType[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  if (tasks) client.setQueryData(["tasks", "project-1"], tasks);
  client.setQueryData(["columns", "project-1"], [{ id: "todo", name: "Входящие" }]);
  client.setQueryData(["project-members", "project-1"], []);
  client.setQueryData(["tags", "project-1"], []);
  return client;
}

it("opens a task by keyboard with focus on its opener before the callback, without opening from a checkbox", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<QueryClientProvider client={clientFor([task])}><TableView projectId="project-1" onTaskClick={onOpen} /></QueryClientProvider>);
  await user.click(screen.getByRole("checkbox", { name: "Выбрать строку" }));
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "Выбрать строку" })).toBeChecked();
  const opener = screen.getByRole("button", { name: task.title });
  onOpen.mockImplementation(() => expect(opener).toHaveFocus());
  opener.focus();
  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(task);
  await user.keyboard(" ");
  expect(onOpen).toHaveBeenCalledTimes(2);
});

it("reaches the task title with Tab and opens it once with Enter or Space without selecting the row", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<QueryClientProvider client={clientFor([task])}><TableView projectId="project-1" onTaskClick={onOpen} /></QueryClientProvider>);
  const checkbox = screen.getByRole("checkbox", { name: "Выбрать строку" });
  const opener = screen.getByRole("button", { name: task.title });

  checkbox.focus();
  expect(checkbox).toHaveFocus();
  await user.tab();
  expect(opener).toHaveFocus();

  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(task);
  await user.keyboard(" ");
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(checkbox).not.toBeChecked();

  // A pointer activation of the title is also a single open, while the
  // checkbox stays a separate selection action.
  await user.click(opener);
  expect(onOpen).toHaveBeenCalledTimes(3);
  await user.click(checkbox);
  expect(onOpen).toHaveBeenCalledTimes(3);
  expect(checkbox).toBeChecked();
  checkbox.focus();
  await user.keyboard(" ");
  expect(onOpen).toHaveBeenCalledTimes(3);
  expect(checkbox).not.toBeChecked();
});

it("returns focus to the table title after its routed task panel closes", async () => {
  const user = userEvent.setup();
  let panel: HTMLElement | null = null;
  const onOpen = vi.fn(() => {
    panel = document.createElement("aside");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Детали задачи");
    panel.setAttribute("aria-modal", "true");
    const close = document.createElement("button");
    close.textContent = "Закрыть";
    panel.append(close);
    document.body.append(panel);
    close.focus();
  });
  render(<QueryClientProvider client={clientFor([task])}><TableView projectId="project-1" onTaskClick={onOpen} /></QueryClientProvider>);
  const opener = screen.getByRole("button", { name: task.title });

  await user.click(opener);
  expect(onOpen).toHaveBeenCalledWith(task);
  expect(panel!.contains(document.activeElement)).toBe(true);

  panel!.remove();
  await waitFor(() => expect(opener).toHaveFocus());
});

it.each([
  { label: "first", removedIndex: 0, nextIndex: 1 },
  { label: "middle", removedIndex: 1, nextIndex: 2 },
  { label: "last", removedIndex: 2, nextIndex: 1 },
])("focuses the nearest remaining row after deleting the $label focused row", async ({ removedIndex, nextIndex }) => {
  const tasks = [task, { ...task, id: "task-2", title: "Вторая" }, { ...task, id: "task-3", title: "Третья" }];
  const client = clientFor(tasks);
  const onOpen = vi.fn();
  render(<QueryClientProvider client={client}><TableView projectId="project-1" onTaskClick={onOpen} /></QueryClientProvider>);
  screen.getByRole("button", { name: tasks[removedIndex].title }).focus();
  act(() => client.setQueryData(["tasks", "project-1"], tasks.filter((_, index) => index !== removedIndex)));
  await waitFor(() => expect(screen.getByRole("button", { name: tasks[nextIndex].title })).toHaveFocus());
  expect(screen.getByRole("table").contains(document.activeElement)).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
});

it("focuses the table container after deleting the only focused row", async () => {
  const client = clientFor([task]);
  render(<QueryClientProvider client={client}><TableView projectId="project-1" onTaskClick={vi.fn()} /></QueryClientProvider>);
  screen.getByRole("button", { name: task.title }).focus();
  act(() => client.setQueryData(["tasks", "project-1"], []));
  await waitFor(() => expect(screen.getByRole("region", { name: "Таблица задач, горизонтальная прокрутка" })).toHaveFocus());
  expect(document.body).not.toHaveFocus();
});

it("keeps focus inside the table when a focused row is filtered out", async () => {
  const client = clientFor([task, { ...task, id: "task-2", title: "Вторая" }]);
  const view = (search: string) => <QueryClientProvider client={client}><TableView projectId="project-1" onTaskClick={vi.fn()} search={search} /></QueryClientProvider>;
  const { rerender } = render(view(""));
  screen.getByRole("button", { name: task.title }).focus();
  rerender(view("Вторая"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Вторая" })).toHaveFocus());
  rerender(view("Нет совпадений"));
  await waitFor(() => expect(screen.getByRole("region")).toHaveFocus());
});

it("does not move focus from search when filtering removes a previously focused row", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={clientFor([task])}><TableView projectId="project-1" onTaskClick={vi.fn()} /></QueryClientProvider>);
  screen.getByRole("button", { name: task.title }).focus();
  const search = screen.getByRole("textbox", { name: "Поиск задач в таблице" });
  await user.type(search, "Нет совпадений");
  await waitFor(() => expect(screen.queryByRole("button", { name: task.title })).not.toBeInTheDocument());
  expect(search).toHaveFocus();
});

it("restores a neighbour when the task opener disappears while its panel is open", async () => {
  const user = userEvent.setup();
  const client = clientFor([task, { ...task, id: "task-2", title: "Вторая" }]);
  const panel = document.createElement("aside");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Детали задачи");
  panel.setAttribute("aria-modal", "true");
  const close = document.createElement("button");
  panel.append(close);
  const onOpen = vi.fn(() => { document.body.append(panel); close.focus(); });
  render(<QueryClientProvider client={client}><TableView projectId="project-1" onTaskClick={onOpen} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: task.title }));
  act(() => client.setQueryData(["tasks", "project-1"], [{ ...task, id: "task-2", title: "Вторая" }]));
  await waitFor(() => expect(screen.queryByRole("button", { name: task.title })).not.toBeInTheDocument());
  expect(close).toHaveFocus();
  panel.remove();
  await waitFor(() => expect(screen.getByRole("button", { name: "Вторая" })).toHaveFocus());
});

it("shows a visible loading state while tasks are pending", () => {
  mocks.apiFetch.mockImplementation(() => new Promise(() => {}));
  render(<QueryClientProvider client={clientFor()}><TableView projectId="project-1" onTaskClick={vi.fn()} /></QueryClientProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("Загрузка таблицы");
  expect(screen.queryByText("Задачи не найдены")).not.toBeInTheDocument();
});

it("distinguishes a failed task request from an empty result and offers retry", async () => {
  mocks.apiFetch.mockRejectedValue(new Error("Synthetic unavailable"));
  render(<QueryClientProvider client={clientFor()}><TableView projectId="project-1" onTaskClick={vi.fn()} /></QueryClientProvider>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить таблицу задач");
  expect(screen.getByRole("button", { name: "Повторить" })).toBeEnabled();
  expect(screen.queryByText("Задачи не найдены")).not.toBeInTheDocument();
});

it("labels the table and search and reports an empty successful result", () => {
  render(<QueryClientProvider client={clientFor([])}><TableView projectId="project-1" onTaskClick={vi.fn()} /></QueryClientProvider>);
  expect(screen.getByRole("table", { name: "Задачи проекта" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Поиск задач в таблице" })).toBeInTheDocument();
  expect(screen.getByText("Задачи не найдены")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("has no serious or critical axe violations with a task row", async () => {
  const { container } = render(<QueryClientProvider client={clientFor([task])}><TableView projectId="project-1" onTaskClick={vi.fn()} /></QueryClientProvider>);
  await screen.findByRole("button", { name: task.title });
  const results = await axe(container);
  expect(
    results.violations.filter((violation) =>
      violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
});
