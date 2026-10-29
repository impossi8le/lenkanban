// Highlight marks may split text nodes; assert the exact visible combined text,
// including negative privacy/cache assertions, without depending on markup.
const exactText=(text:string)=>(_:string,node:Element|null)=>Boolean(node&&node.textContent===text&&!Array.from(node.children).some(child=>child.textContent===text));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: mocks.apiFetch,
}));
vi.mock("@/components/kanban/FilterBar", () => ({
  FilterBar: ({ showSort }: { showSort?: boolean }) =>
    showSort === false ? null : <div>Сортировка</div>,
}));
vi.mock("@/components/views/BulkActionsToolbar", () => ({
  BulkActionsToolbar: ({
    selectedTasks,
  }: {
    selectedTasks: TaskType[];
  }) => (
    <output data-testid="selected-task-ids">
      {selectedTasks.map((task) => task.id).join(",")}
    </output>
  ),
}));

import { TableView } from "./TableView";

afterEach(cleanup);

function task(id: string, title: string): TaskType {
  return {
    id,
    title,
    status: "TODO",
    columnId: "column-1",
    column: {
      id: "column-1",
      name: "Триаж",
      color: "#3B82F6",
    },
    priority: "MEDIUM",
    position: 1024,
    projectId: "project-1",
    assignees: [],
    tags: [],
  };
}

function renderTable(tasks: TaskType[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(["tasks", "project-1"], tasks);
  queryClient.setQueryData(["columns", "project-1"], [
    { id: "column-1", name: "Триаж" },
  ]);
  queryClient.setQueryData(["project-members", "project-1"], []);
  queryClient.setQueryData(["tags", "project-1"], []);
  render(
    <QueryClientProvider client={queryClient}>
      <TableView projectId="project-1" onTaskClick={vi.fn()} />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("TableView workflow contracts", () => {
  it("keeps selection bound to task id across filtering, sorting and data reorder", async () => {
    const user = userEvent.setup();
    const alpha = task("task-alpha", "Alpha");
    const beta = task("task-beta", "Beta");
    const queryClient = renderTable([alpha, beta]);

    await user.type(
      screen.getByPlaceholderText("Поиск задач..."),
      "a",
    );
    await user.click(screen.getByRole("button", { name: /Название/ }));
    const betaRow = screen.getByText(exactText("Beta")).closest("tr");
    expect(betaRow).not.toBeNull();
    await user.click(
      within(betaRow as HTMLTableRowElement).getByRole("checkbox"),
    );
    expect(screen.getByTestId("selected-task-ids")).toHaveTextContent(
      "task-beta",
    );

    queryClient.setQueryData(["tasks", "project-1"], [
      task("task-beta", "Beta refreshed"),
      task("task-alpha", "Alpha refreshed"),
    ]);

    await waitFor(() => {
      expect(screen.getByText(exactText("Beta refreshed"))).toBeInTheDocument();
      expect(screen.getByTestId("selected-task-ids")).toHaveTextContent(
        "task-beta",
      );
    });
  });

  it("does not show a sort selector whose callback is disconnected", () => {
    renderTable([task("task-alpha", "Alpha")]);

    expect(screen.queryByText(exactText("Сортировка"))).toBeNull();
  });
});
