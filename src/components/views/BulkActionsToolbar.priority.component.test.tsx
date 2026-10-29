import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BulkActionsToolbar } from "./BulkActionsToolbar";
import { TASK_PRIORITY_OPTIONS } from "@/lib/task-priority";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));
const clients: QueryClient[] = [];
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.clearAllMocks(); mocks.apiFetch.mockResolvedValue({ updated: 2 });
  // jsdom has no layout/scroll API; Radix still uses it for keyboard focus.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it.each(TASK_PRIORITY_OPTIONS)("offers $label and sends its original $value through the existing bulk protocol", async ({ value, label }) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  clients.push(client);
  const clear = vi.fn();
  const tasks = ["first", "second"].map(id => ({
    id, projectId: "project", columnId: "column", title: id, priority: "LOW", position: 1024,
  }));
  render(<QueryClientProvider client={client}><BulkActionsToolbar
    selectedTasks={tasks} projectId="project" columns={[]} onClearSelection={clear}
  /></QueryClientProvider>);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Изменить приоритет" }), { key: "Enter" });
  const options = await screen.findAllByRole("option");
  expect(options.map(option => option.textContent)).toEqual(TASK_PRIORITY_OPTIONS.map(option => option.label));
  fireEvent.click(screen.getByRole("option", { name: label }));
  await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
  const [url, request] = mocks.apiFetch.mock.calls[0];
  expect(url).toBe("/api/tasks/bulk");
  expect(request.method).toBe("PATCH");
  expect(JSON.parse(request.body)).toEqual({ taskIds: ["first", "second"], updates: { priority: value } });
  await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  expect(tasks.map(task => task.priority)).toEqual(["LOW", "LOW"]);
});
