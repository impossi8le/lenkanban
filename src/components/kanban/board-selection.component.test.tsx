import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { KanbanBoardState } from "@/features/kanban/model/types";
import type { TaskType } from "./Card";

const controls = vi.hoisted(() => ({ push: vi.fn(), actor: "actor-a" }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: () => null, PointerSensor: class {}, KeyboardSensor: class {},
  useSensor: vi.fn(), useSensors: vi.fn(), useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({ setNodeRef: vi.fn(), setActivatorNodeRef: vi.fn(), attributes: {}, listeners: {}, transform: null,
    isDragging: false, rect: { current: null }, active: null }),
}));
vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: ({ children }: { children: ReactNode }) => children,
  DragOverlay: () => null, useDroppable: () => ({ ref: vi.fn(), isDropTarget: false }),
}));
vi.mock("@dnd-kit/react/sortable", () => ({ useSortable: () => ({ ref: vi.fn(), handleRef: vi.fn(), isDragging: false }) }));
vi.mock("@/features/kanban/dnd/use-kanban-dnd", async importOriginal => {
  const original = await importOriginal<typeof import("@/features/kanban/dnd/use-kanban-dnd")>();
  return { ...original, useKanbanDnd: ({ snapshot }: { snapshot: KanbanBoardState }) => ({
    state: snapshot, activeTaskId: null, pendingTaskIds: new Set<string>(), hasPendingMoves: false, isDragging: false,
    moveTask: vi.fn(), handlers: { onDragStart: vi.fn(), onDragMove: vi.fn(), onDragOver: vi.fn(), onDragEnd: vi.fn() },
  }) };
});
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: controls.actor } } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));
vi.mock("@/hooks/useProjectBoard", () => ({ useProjectBoard: () => ({ socket: null, isJoined: false }) }));
vi.mock("./FilterBar", () => ({ FilterBar: () => null }));
import { KanbanBoard } from "./Board";

const clients: QueryClient[] = [];
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
let tasks: TaskType[];
const requests: { url: string; method: string }[] = [];

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  tasks = [
    { id: "a", title: "Alpha", projectId: "p", columnId: "one", position: 1024, priority: "LOW", version: 1 },
    { id: "b", title: "Beta", projectId: "p", columnId: "one", position: 2048, priority: "LOW", version: 1 },
    { id: "c", title: "Gamma", projectId: "p", columnId: "one", position: 3072, priority: "MEDIUM", version: 1 },
  ];
  controls.actor = "actor-a"; controls.push.mockReset();
  requests.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    if (method !== "GET") {
      requests.push({ url, method });
      throw new Error("Simplified board must not submit a bulk mutation");
    }
    const projectId = url.startsWith("/api/tasks?") ? new URL(url, "http://localhost").searchParams.get("projectId")! : "p";
    return Response.json({ success: true, data: url.startsWith("/api/tasks?") ? tasks.map(task => ({ ...task, projectId }))
      : url.endsWith("/columns") ? [
        { id: "one", name: "One", color: "#123456", position: 0, workflowKey: "TODO" },
        { id: "two", name: "Two", color: "#654321", position: 1, workflowKey: "IN_PROGRESS" },
      ] : [] });
  }));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

async function mount(v2: boolean, manualTaskMovesEnabled = true, statusPermission = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const ui = (projectId = "p", priorityFilter: string | null = null) => <QueryClientProvider client={client}>
    <KanbanBoard projectId={projectId} priorityFilter={priorityFilter} dndV2Enabled={v2} manualTaskMovesEnabled={manualTaskMovesEnabled} canChangeStatus={statusPermission} canManage />
  </QueryClientProvider>;
  const view = render(ui());
  await screen.findByText("Alpha");
  return { ...view, ui, client };
}
describe.each([false, true])("simplified board v2=%s", v2 => {
  it("shows tasks without selection or bulk controls and opens a task without writing", async () => {
    await mount(v2);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Выбрано:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Выберите действие" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Alpha"));
    expect(controls.push).toHaveBeenCalledWith("/projects/p/tasks/a", { scroll: false });
    expect(requests).toEqual([]);
  });
  it("hides manual moves for lifecycle boards even for administrators while preserving task opening", async () => {
    await mount(v2, false);
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Действия задачи/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Alpha"));
    expect(controls.push).toHaveBeenCalledWith("/projects/p/tasks/a", { scroll: false });
    expect(requests).toEqual([]);
  });
  it("does not expose drag handles or manual move menus after the approved redesign", async () => {
    await mount(v2, true);
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Действия задачи «Alpha»" })).not.toBeInTheDocument();
  });
  it("does not grant ordinary-board movement when the actor lacks status permission", async () => {
    await mount(v2, true, false);
    expect(screen.queryByRole("button", { name: /Переместить задачу/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Действия задачи/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Alpha"));
    expect(controls.push).toHaveBeenCalledWith("/projects/p/tasks/a", { scroll: false });
    expect(requests).toEqual([]);
  });
  it("does not restore selection after a parent filter or actor change", async () => {
    const view = await mount(v2);
    view.rerender(view.ui("p", "LOW"));
    controls.actor = "actor-b";
    view.rerender(view.ui());
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Выбрано:/)).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});
