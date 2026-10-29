import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: () => null,
  PointerSensor: class {}, KeyboardSensor: class {}, useSensor: vi.fn(), useSensors: vi.fn(),
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useProjectBoard", () => ({ useProjectBoard: () => ({ socket: null, isJoined: false }) }));
vi.mock("./FilterBar", () => ({ FilterBar: () => null }));
vi.mock("./Column", async () => {
  const { ContextualTaskMoveMenu } = await import("@/features/kanban/components/TaskMoveMenu");
  return { KanbanColumn: ({ id, tasks }: { id: string; tasks: { id: string; title: string }[] }) => (
    <section aria-label={id}>{tasks.map(task => <div key={task.id}><span>{task.title}</span><ContextualTaskMoveMenu taskId={task.id} taskTitle={task.title} /></div>)}</section>
  ) };
});
vi.mock("./Card", () => ({ KanbanCardView: () => null }));
vi.mock("@/components/bulk/BulkActionsBar", () => ({ BulkActionsBar: () => null }));
vi.mock("@/features/kanban/dnd/KanbanDndBoard", () => ({ KanbanDndBoard: () => null }));
// Isolate presentation: this suite verifies Board data/transport, while the
// real four-stage demo rendering has its own component coverage.
vi.mock("./RequestBoardPresentation", () => ({ RequestBoardPresentation: ({ tasks, readError }: { tasks: { id: string; title: string; columnId?: string | null }[]; readError?: boolean }) => readError ? <div role="alert">Не удалось загрузить задачи</div> : <div role="region" aria-label="Колонки канбан-доски" tabIndex={0}>
  {!tasks.length && <p>На доске пока нет задач</p>}
  {["one", "two", "todo", "review"].map(id => <section key={id} aria-label={id} data-reorder-enabled="false">{tasks.filter(task => task.columnId === id).map(task => <div key={task.id} data-testid="sorted-task" data-task-id={task.id}>{task.title}</div>)}</section>)}
</div> }));
import { KanbanBoard } from "./Board";

const clients: QueryClient[] = [];
const initialTasks = [
  { id: "a", title: "Alpha", projectId: "p", columnId: "one", position: 1024, version: 2, priority: "MEDIUM" },
  { id: "b", title: "Beta", projectId: "p", columnId: "one", position: 2048, version: 1, priority: "HIGH" },
  { id: "c", title: "Gamma", projectId: "p", columnId: "two", position: 1024, version: 1, priority: "LOW" },
];
const initialColumns = [
  { id: "one", name: "One", position: 0, workflowKey: "TODO" },
  { id: "two", name: "Two", position: 1, workflowKey: "IN_PROGRESS" },
];
let tasks = initialTasks.map(task => ({ ...task }));
let columns = [...initialColumns];
let failedQuery: "tasks" | "columns" | null = null;
let failMove = false;
const requests: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  tasks = initialTasks.map(task => ({ ...task })); columns = [...initialColumns];
  failedQuery = null; failMove = false; requests.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (failMove) return Response.json({ success: false, error: { code: "CONFLICT", message: "Конфликт версии" } }, { status: 409 });
      const id = url.split("/").at(-2)!;
      tasks = tasks.map(task => task.id === id ? { ...task, columnId: String(body.toColumnId), version: task.version + 1, position: 4096 } : task);
      return Response.json({ success: true, data: { boardRevision: 3, task: tasks.find(task => task.id === id) } });
    }
    if ((failedQuery === "tasks" && url.startsWith("/api/tasks?")) || (failedQuery === "columns" && url.endsWith("/columns"))) {
      return Response.json({ success: false, error: { code: "UNAVAILABLE", message: "Недоступно" } }, { status: 503 });
    }
    return Response.json({ success: true, data: url.startsWith("/api/tasks?") ? tasks : url.endsWith("/columns") ? columns : [] });
  }));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><KanbanBoard projectId="p" dndV2Enabled={false} /></QueryClientProvider>);
  return client;
}

it.each(["tasks", "columns"] as const)("shows a %s request error and recovers through the visible retry control", async kind => {
  failedQuery = kind; mount();
  expect(await screen.findByRole("alert")).toHaveTextContent(kind === "tasks" ? "Не удалось загрузить задачи" : "Не удалось загрузить колонки доски");
  expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  failedQuery = null;
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await waitFor(() => expect(screen.getByText("Alpha")).toBeVisible());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("shows a successful zero-column board as empty instead of an endless loader", async () => {
  columns = []; tasks = []; mount();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("На доске пока нет колонок"));
  expect(screen.queryByText("Загрузка задач...")).not.toBeInTheDocument();
});

it("keeps known tasks visible without manual move commands when a task has an unknown column", async () => {
  tasks.push({ ...initialTasks[0], id: "orphan", title: "Orphan", columnId: "removed-column" });
  mount();
  expect(await screen.findByText("Alpha")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Действия задачи/ })).not.toBeInTheDocument();
  expect(screen.queryByText("Orphan")).not.toBeInTheDocument();
  expect(requests).toEqual([]);
});

it("keeps the columns region available on a successful board with no tasks", async () => {
  tasks = []; mount();
  expect(await screen.findByText("На доске пока нет задач")).toBeVisible();
  expect(screen.getByRole("region", { name: "Колонки канбан-доски" })).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("region", { name: "one" })).toBeInTheDocument();
});

it("never exposes legacy menu movement or sends a mutation while canonical task data remains visible", async () => {
  mount();
  expect(await screen.findByText("Alpha")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Действия задачи/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /В колонку/ })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "one" })).toHaveTextContent("AlphaBeta");
  expect(screen.getByRole("region", { name: "two" })).toHaveTextContent("Gamma");
  expect(requests).toEqual([]);
});

it.each(["tasks", "columns"] as const)("hides cached board data when a %s refetch fails", async kind => {
  const client = mount();
  await waitFor(() => expect(screen.getByText("Alpha")).toBeVisible());
  expect(screen.getByRole("region", { name: "Колонки канбан-доски" })).toHaveAttribute("tabindex", "0");
  failedQuery = kind;
  await client.invalidateQueries({ queryKey: kind === "tasks" ? ["tasks", "p"] : ["columns", "p"] });
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить");
  expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Колонки канбан-доски" })).not.toBeInTheDocument();
});

it("does not enter the legacy move transport even when that transport would reject", async () => {
  failMove = true; mount();
  expect(await screen.findByText("Alpha")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Действия задачи/ })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "one" })).toHaveTextContent("Alpha");
  expect(screen.getByRole("region", { name: "two" })).not.toHaveTextContent("Alpha");
  expect(requests).toEqual([]);
});
