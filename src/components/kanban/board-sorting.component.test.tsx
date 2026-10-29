import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { KanbanBoardState } from "@/features/kanban/model/types";
import type { TaskType } from "./Card";

const control = vi.hoisted(() => ({
  state: null as KanbanBoardState | null,
  moveTask: vi.fn(), onCreateTask: vi.fn(), onOpenTask: vi.fn(),
  dragStart: vi.fn(), dragMove: vi.fn(), dragOver: vi.fn(), dragEnd: vi.fn(),
  providerHandlers: {} as Record<string, (event: unknown) => unknown>,
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: () => null, closestCorners: () => [],
  PointerSensor: class {}, KeyboardSensor: class {}, useSensor: vi.fn(), useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({ sortableKeyboardCoordinates: vi.fn() }));
vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
    control.providerHandlers = props as typeof control.providerHandlers;
    return children;
  },
  DragOverlay: () => null,
}));
vi.mock("@/features/kanban/dnd/use-kanban-dnd", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/features/kanban/dnd/use-kanban-dnd")>();
  return { ...original, useKanbanDnd: ({ snapshot }: { snapshot: KanbanBoardState }) => ({
    state: control.state ?? snapshot, activeTaskId: null, pendingTaskIds: new Set<string>(),
    hasPendingMoves: false, isDragging: false, moveTask: control.moveTask,
    handlers: { onDragStart: control.dragStart, onDragMove: control.dragMove, onDragOver: control.dragOver, onDragEnd: control.dragEnd },
  }) };
});
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useProjectBoard", () => ({ useProjectBoard: () => ({ socket: null, isJoined: false }) }));
vi.mock("./FilterBar", () => ({ FilterBar: () => null }));
vi.mock("./Card", () => ({ KanbanCardView: () => null }));
vi.mock("@/features/kanban/dnd/KanbanCardOverlay", () => ({ KanbanCardOverlay: () => null }));
vi.mock("@/components/bulk/BulkActionsBar", () => ({ BulkActionsBar: () => null }));
vi.mock("./Column", () => {
  function Column({ id, tasks, reorderEnabled }: { id: string; tasks: TaskType[]; reorderEnabled?: boolean }) {
    return <section aria-label={id} data-reorder-enabled={reorderEnabled === undefined ? "legacy" : String(reorderEnabled)}>
      {tasks.map(task => <div key={task.id} data-testid="sorted-task" data-task-id={task.id}>{task.title}</div>)}
    </section>;
  }
  return { KanbanColumn: Column, KanbanDndColumn: Column };
});

// Isolate presentation: this suite verifies Board data/transport, while the
// real four-stage demo rendering has its own component coverage.
vi.mock("./RequestBoardPresentation", () => ({ RequestBoardPresentation: ({ tasks }: { tasks: { id: string; title: string; columnId?: string | null }[] }) => <div role="region" aria-label="Колонки канбан-доски" tabIndex={0}>
  {!tasks.length && <p>На доске пока нет задач</p>}
  {["one", "two", "todo", "review"].map(id => <section key={id} aria-label={id} data-reorder-enabled="false">{tasks.filter(task => task.columnId === id).map(task => <div key={task.id} data-testid="sorted-task" data-task-id={task.id}>{task.title}</div>)}</section>)}
</div> }));
import { KanbanBoard } from "./Board";
import { KanbanDndBoard } from "@/features/kanban/dnd/KanbanDndBoard";
import { normalizeBoard } from "@/features/kanban/model/normalize-board";

const date = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
const columns = [
  { id: "one", projectId: "p", name: "One", color: "#123456", position: 0, workflowKey: "TODO", createdAt: date(1), updatedAt: date(1) },
  { id: "two", projectId: "p", name: "Two", color: "#654321", position: 1, workflowKey: "IN_PROGRESS", createdAt: date(1), updatedAt: date(1) },
];
function makeTask(id: string, title: string, columnId: string, position: number, priority: string, created: number, updated: number, deadline: Date | null, keep: boolean, userId: string): TaskType {
  return { id, title, columnId, position, priority, projectId: "p", version: 1,
    createdAt: date(created), updatedAt: date(updated), deadline,
    tags: keep ? [{ id: `${id}-tag`, tag: { id: "keep", name: "Keep", color: "#123456" } }] : [],
    assignees: [{ id: `${id}-assignment`, user: { id: userId, name: null, email: "synthetic@example.invalid" } }],
  };
}
const tasks = [
  makeTask("a", "Bravo", "one", 30, "LOW", 3, 1, new Date(date(2)), true, "user-x"),
  makeTask("d", "Charlie", "one", 40, "HIGH", 1, 3, new Date("invalid"), false, "user-y"),
  makeTask("c", "Delta", "one", 20, "URGENT", 2, 2, new Date(date(1)), false, "user-x"),
  makeTask("b", "Alpha", "one", 10, "CRITICAL", 1, 4, null, true, "user-y"),
  makeTask("e", "Echo", "two", 20, "MEDIUM", 2, 4, new Date(date(3)), true, "user-x"),
  makeTask("f", "Foxtrot", "two", 10, "CRITICAL", 1, 1, new Date(date(1)), true, "user-y"),
];
const initialTasks = JSON.stringify(tasks);
const sortCases = [
  ["position", ["b", "c", "a", "d"], ["f", "e"]],
  ["created-asc", ["b", "d", "c", "a"], ["f", "e"]],
  ["created-desc", ["a", "c", "b", "d"], ["e", "f"]],
  ["updated-asc", ["a", "c", "d", "b"], ["f", "e"]],
  ["updated-desc", ["b", "d", "c", "a"], ["e", "f"]],
  ["deadline-asc", ["c", "a", "b", "d"], ["f", "e"]],
  ["deadline-desc", ["a", "c", "b", "d"], ["e", "f"]],
  ["priority-asc", ["a", "d", "c", "b"], ["e", "f"]],
  ["priority-desc", ["b", "c", "d", "a"], ["f", "e"]],
  ["title-asc", ["b", "a", "d", "c"], ["e", "f"]],
  ["title-desc", ["c", "d", "a", "b"], ["f", "e"]],
] as const;
const clients: QueryClient[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  control.state = null;
  vi.clearAllMocks();
  fetchMock.mockRejectedValue(Error("Unexpected network request"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals();
  expect(JSON.stringify(tasks)).toBe(initialTasks);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(control.moveTask).not.toHaveBeenCalled();
  expect(control.onCreateTask).not.toHaveBeenCalled();
  expect(control.onOpenTask).not.toHaveBeenCalled();
  expect(control.dragStart).not.toHaveBeenCalled();
  expect(control.dragMove).not.toHaveBeenCalled();
  expect(control.dragOver).not.toHaveBeenCalled();
});

function ids(columnId: string) {
  return within(screen.getByRole("region", { name: columnId })).queryAllByTestId("sorted-task").map(node => node.getAttribute("data-task-id"));
}
async function setupBoard(dndV2Enabled: boolean, props: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["tasks", "p", undefined, false], tasks);
  client.setQueryData(["columns", "p"], columns);
  client.setQueryData(["project-members", "p"], []);
  client.setQueryData(["tags", "p"], []);
  const change = vi.fn();
  const element = (extra: typeof props = {}) => <QueryClientProvider client={client}><KanbanBoard projectId="p" dndV2Enabled={dndV2Enabled} onSortByChange={change} {...props} {...extra} /></QueryClientProvider>;
  const view = render(element());
  await screen.findByRole("region", { name: "one" });
  await waitFor(() => expect(screen.queryAllByTestId("sorted-task").length).toBeGreaterThan(0));
  return { client, change, rerender: (extra: typeof props) => view.rerender(element(extra)) };
}

describe.each([false, true])("actual Board with V2=%s", (v2) => {
  it.each(sortCases)("renders %s per column with deterministic ties, dates and CRITICAL", async (sortBy, one, two) => {
    const { change } = await setupBoard(v2, { sortBy });
    expect(ids("one")).toEqual(one); expect(ids("two")).toEqual(two);
    expect(change).not.toHaveBeenCalled();
    if (v2) expect(screen.getByRole("region", { name: "one" })).toHaveAttribute("data-reorder-enabled", "false");
  });

  it("combines tag/assignee filters across two columns and restores canonical order", async () => {
    const view = await setupBoard(v2, { sortBy: "title-asc", tagsFilter: ["keep"] });
    expect(ids("one")).toEqual(["b", "a"]); expect(ids("two")).toEqual(["e", "f"]);
    view.rerender({ sortBy: "title-desc", assigneeFilter: "user-x" });
    expect(ids("one")).toEqual(["a"]); expect(ids("two")).toEqual(["e"]);
    view.rerender({ sortBy: "position", assigneeFilter: null, tagsFilter: null });
    expect(ids("one")).toEqual(["b", "c", "a", "d"]); expect(ids("two")).toEqual(["f", "e"]);
    expect(view.change).not.toHaveBeenCalled();
  });
});

function snapshot(): KanbanBoardState {
  return normalizeBoard({ columns, tasks: tasks.map(task => ({ ...task, columnId: task.columnId!, version: task.version! })) });
}
function directV2(state: KanbanBoardState, sortBy?: string, visibleTaskIds?: ReadonlySet<string>) {
  return <KanbanDndBoard columns={columns} snapshot={state} snapshotRevision={1} reorderEnabled={true} sortBy={sortBy} visibleTaskIds={visibleTaskIds} onCreateTask={control.onCreateTask} onOpenTask={control.onOpenTask} />;
}

it("V2 preserves fresh controller canonical arrays for position and unknown modes despite stale scalar positions", () => {
  const originalSnapshot = snapshot();
  const live = snapshot();
  live.taskIdsByColumn.one = ["d", "a", "b", "c"];
  live.taskIdsByColumn.two = ["e", "f"];
  control.state = live;
  const before = JSON.stringify(live);
  const view = render(directV2(originalSnapshot, "title-asc"));
  expect(ids("one")).toEqual(["b", "a", "d", "c"]);
  expect(screen.getByRole("region", { name: "one" })).toHaveAttribute("data-reorder-enabled", "false");
  view.rerender(directV2(originalSnapshot, "position"));
  expect(ids("one")).toEqual(["d", "a", "b", "c"]); expect(ids("two")).toEqual(["e", "f"]);
  expect(screen.getByRole("region", { name: "one" })).toHaveAttribute("data-reorder-enabled", "true");
  view.rerender(directV2(originalSnapshot, "future-sort-value"));
  expect(ids("one")).toEqual(["d", "a", "b", "c"]);
  view.rerender(directV2(originalSnapshot));
  expect(ids("one")).toEqual(["d", "a", "b", "c"]);
  expect(JSON.stringify(live)).toBe(before);
});

it("V2 sorts current controller task values and columns rather than stale incoming snapshot data", () => {
  const incoming = snapshot();
  const first = snapshot(); control.state = first;
  const view = render(directV2(incoming, "priority-desc"));
  expect(ids("one")).toEqual(["b", "c", "d", "a"]);
  const fresh = snapshot();
  fresh.tasksById.a = { ...fresh.tasksById.a, priority: "CRITICAL", position: 5 };
  fresh.tasksById.b = { ...fresh.tasksById.b, priority: "LOW" };
  fresh.tasksById.c = { ...fresh.tasksById.c, columnId: "two" };
  fresh.taskIdsByColumn.one = ["b", "a", "d"];
  fresh.taskIdsByColumn.two = ["f", "e", "c"];
  control.state = fresh;
  const before = JSON.stringify(fresh);
  view.rerender(directV2(incoming, "priority-desc", new Set(["a", "b", "c", "d", "e", "f"])));
  expect(ids("one")).toEqual(["a", "d", "b"]); expect(ids("two")).toEqual(["f", "c", "e"]);
  expect(JSON.stringify(fresh)).toBe(before);
  expect(incoming.tasksById.a.priority).toBe("LOW");
  expect(incoming.taskIdsByColumn.one).toEqual(["b", "c", "a", "d"]);
});

it("V2 blocks positional provider callbacks under alternate sorting and forwards drag end as cancelled", async () => {
  render(directV2(snapshot(), "priority-desc"));
  const event = { canceled: false, operation: { source: { id: "a" }, target: { id: "c" } } };
  await act(async () => {
    control.providerHandlers.onDragStart(event);
    control.providerHandlers.onDragMove(event);
    control.providerHandlers.onDragOver(event);
    control.providerHandlers.onDragEnd(event);
  });
  expect(control.dragStart).not.toHaveBeenCalled();
  expect(control.dragMove).not.toHaveBeenCalled();
  expect(control.dragOver).not.toHaveBeenCalled();
  expect(control.dragEnd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ canceled: true }), undefined);
  expect(event.canceled).toBe(false);
});
