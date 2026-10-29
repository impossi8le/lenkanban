import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import { TableView } from "./TableView";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));

afterEach(() => {
  cleanup();
  mocks.apiFetch.mockReset();
});

function task(id: string, title: string, overrides: Partial<TaskType> = {}): TaskType {
  return {
    id,
    title,
    status: "TODO",
    columnId: "column-1",
    column: { id: "column-1", name: "Триаж", color: "#3B82F6" },
    priority: "MEDIUM",
    position: 1024,
    projectId: "project-1",
    assignees: [],
    tags: [],
    ...overrides,
  };
}

function renderTable(
  tasks: TaskType[],
  props: Partial<React.ComponentProps<typeof TableView>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(["tasks", "project-1"], tasks);
  queryClient.setQueryData(["columns", "project-1"], [
    { id: "column-1", name: "Триаж" },
    { id: "column-2", name: "Готово" },
  ]);
  queryClient.setQueryData(["project-members", "project-1"], []);
  queryClient.setQueryData(["tags", "project-1"], [
    { id: "t1", name: "Баг", color: "#ef4444" },
    { id: "t2", name: "Фича", color: "#22c55e" },
  ]);
  render(
    <QueryClientProvider client={queryClient}>
      <TableView projectId="project-1" onTaskClick={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("TableView saved view synchronization", () => {
  it("saves and restores nonempty shared search together with descending title sort", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["tasks", "project-1"], [task("a", "Match Alpha"), task("b", "Match Beta"), task("c", "Other")]);
    client.setQueryData(["columns", "project-1"], []);
    client.setQueryData(["project-members", "project-1"], []);
    client.setQueryData(["tags", "project-1"], []);
    function SharedView() {
      const [search, setSearch] = useState("");
      const [sortBy, setSortBy] = useState("position");
      const [saved, setSaved] = useState<{ search: string; sortBy: string } | null>(null);
      return <>
        <button onClick={() => setSaved({ search, sortBy })}>Save view</button>
        <button onClick={() => { setSearch(""); setSortBy("position"); }}>Reset view</button>
        <button onClick={() => { if (saved) { setSearch(saved.search); setSortBy(saved.sortBy); } }}>Restore view</button>
        <output data-testid="saved-state">{JSON.stringify(saved)}</output>
        <TableView projectId="project-1" onTaskClick={vi.fn()} search={search} onSearchChange={setSearch} sortBy={sortBy} onSortByChange={setSortBy} />
      </>;
    }
    render(<QueryClientProvider client={client}><SharedView /></QueryClientProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск задач в таблице" }), { target: { value: "Match" } });
    fireEvent.click(screen.getByRole("button", { name: "Название" }));
    fireEvent.click(screen.getByRole("button", { name: "Название" }));
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    expect(screen.getByTestId("saved-state")).toHaveTextContent(JSON.stringify({ search: "Match", sortBy: "title-desc" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(screen.getByText("Other")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore view" }));
    expect(screen.getByRole("textbox", { name: "Поиск задач в таблице" })).toHaveValue("Match");
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(rows[1]).getByRole("button", { name: "Match Beta" })).toBeInTheDocument();
    expect(within(rows[2]).getByRole("button", { name: "Match Alpha" })).toBeInTheDocument();
    client.clear();
  });

  it("updates shared search and sort state, then restores a saved state", () => {
    const tasks = [task("a", "Alpha"), task("b", "Beta")];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["tasks", "project-1"], tasks);
    client.setQueryData(["columns", "project-1"], []);
    client.setQueryData(["project-members", "project-1"], []);
    client.setQueryData(["tags", "project-1"], []);
    function SharedView() {
      const [search, setSearch] = useState("");
      const [sortBy, setSortBy] = useState("position");
      return <>
        <output data-testid="shared-sort">{sortBy}</output>
        <output data-testid="shared-search">{search}</output>
        <button onClick={() => { setSearch(""); setSortBy("title-desc"); }}>Load saved view</button>
        <button onClick={() => { setSearch("Alpha"); setSortBy("position"); }}>Load searched view</button>
        <TableView projectId="project-1" onTaskClick={vi.fn()} search={search} onSearchChange={setSearch} sortBy={sortBy} onSortByChange={setSortBy} />
      </>;
    }
    render(<QueryClientProvider client={client}><SharedView /></QueryClientProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Поиск задач в таблице" }), { target: { value: "Beta" } });
    expect(screen.getByTestId("shared-search")).toHaveTextContent("Beta");
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Название" }));
    expect(screen.getByTestId("shared-sort")).toHaveTextContent("title-asc");
    fireEvent.click(screen.getByRole("button", { name: "Load saved view" }));
    expect(screen.getByRole("textbox", { name: "Поиск задач в таблице" })).toHaveValue("");
    expect(within(screen.getAllByRole("row")[1]).getByText("Beta")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Название" }));
    expect(screen.getByTestId("shared-sort")).toHaveTextContent("title-asc");
    expect(within(screen.getAllByRole("row")[1]).getByText("Alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load searched view" }));
    expect(screen.getByRole("textbox", { name: "Поиск задач в таблице" })).toHaveValue("Alpha");
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    client.clear();
  });

  it("applies lifted status and priority filters from props", () => {
    const tasks = [
      task("a", "High triage", { priority: "HIGH" }),
      task("b", "Medium done", { priority: "MEDIUM", columnId: "column-2" }),
    ];
    renderTable(tasks, { statusFilter: "column-1", priorityFilter: "HIGH" });
    expect(screen.getByText("High triage")).toBeInTheDocument();
    expect(screen.queryByText("Medium done")).not.toBeInTheDocument();
  });

  it("requires all selected tags to match a task", () => {
    const tasks = [
      task("a", "Bug feature", {
        tags: [
          { id: "x", tag: { id: "t1", name: "Баг", color: "#ef4444" } },
          { id: "y", tag: { id: "t2", name: "Фича", color: "#22c55e" } },
        ],
      }),
      task("b", "Bug only", {
        tags: [{ id: "z", tag: { id: "t1", name: "Баг", color: "#ef4444" } }],
      }),
    ];
    renderTable(tasks, { tagsFilter: ["t1", "t2"] });
    expect(screen.getByText("Bug feature")).toBeInTheDocument();
    expect(screen.queryByText("Bug only")).not.toBeInTheDocument();
  });

  it("orders rows by the shared sortBy prop", () => {
    const tasks = [task("b", "Beta"), task("a", "Alpha")];
    renderTable(tasks, { sortBy: "title-asc" });
    const rows = screen.getAllByRole("row").slice(1); // skip header
    expect(rows.length).toBe(2);
    expect(within(rows[0] as HTMLTableRowElement).getByText("Alpha")).toBeInTheDocument();
    expect(within(rows[1] as HTMLTableRowElement).getByText("Beta")).toBeInTheDocument();
  });
});
