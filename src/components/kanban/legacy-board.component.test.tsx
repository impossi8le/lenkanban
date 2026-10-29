import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const control = vi.hoisted(() => ({ props: {} as Record<string, (event?: unknown) => unknown>, requests: [] as { url: string; body: unknown }[], reorderEnabled: true }));
const notice = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: notice }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { children: ReactNode }) => { control.props = props as unknown as typeof control.props; return props.children; },
  DragOverlay: () => null, closestCorners: () => [],
  PointerSensor: class {}, KeyboardSensor: class {}, useSensor: vi.fn(), useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({ sortableKeyboardCoordinates: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useProjectBoard", () => ({ useProjectBoard: () => ({ socket: null, isJoined: false }) }));
vi.mock("./FilterBar", () => ({ FilterBar: () => null }));
vi.mock("./Column", () => ({ KanbanColumn: ({ id, tasks }: { id: string; tasks: { id: string; title: string }[] }) => <section aria-label={id}>{tasks.map(task => <div key={task.id}>{task.title}</div>)}</section> }));
vi.mock("./Card", () => ({ KanbanCardView: () => null }));
vi.mock("@/components/bulk/BulkActionsBar", () => ({ BulkActionsBar: () => null }));
vi.mock("@/features/kanban/dnd/KanbanDndBoard", () => ({ KanbanDndBoard: () => null }));
vi.mock("@/features/kanban/dnd/use-kanban-dnd", () => ({ isTaskReorderEnabled: () => control.reorderEnabled }));
// Isolate presentation: this suite verifies Board data/transport, while the
// real four-stage demo rendering has its own component coverage.
vi.mock("./RequestBoardPresentation", () => ({ RequestBoardPresentation: ({ tasks }: { tasks: { id: string; title: string; columnId?: string | null }[] }) => <div role="region" aria-label="Колонки канбан-доски" tabIndex={0}>
  {!tasks.length && <p>На доске пока нет задач</p>}
  {["one", "two", "todo", "review"].map(id => <section key={id} aria-label={id} data-reorder-enabled="false">{tasks.filter(task => task.columnId === id).map(task => <div key={task.id} data-testid="sorted-task" data-task-id={task.id}>{task.title}</div>)}</section>)}
</div> }));
import { KanbanBoard } from "./Board";

const tasks = [
  { id: "a", title: "Alpha", projectId: "p", columnId: "one", position: 1024, version: 2 },
  { id: "b", title: "Beta", projectId: "p", columnId: "one", position: 2048, version: 0 },
  { id: "c", title: "Gamma", projectId: "p", columnId: "one", position: 3072, version: 0 },
];
beforeEach(() => {
  notice.error.mockReset();notice.success.mockReset();notice.info.mockReset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, right: 630, top: 0, bottom: 600, width: 630, height: 600, x: 0, y: 0, toJSON: () => ({}),
  });
  control.requests = [];
  control.reorderEnabled = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST" || options?.method === "PATCH") {
      control.requests.push({ url, body: JSON.parse(String(options.body)) });
      return Response.json({ success: true, data: { boardRevision: 1, task: { id: "a", columnId: "one", version: 3, status: "TODO" } } });
    }
    return Response.json({ success: true, data: url.startsWith("/api/tasks?") ? tasks : url.endsWith("/columns") ? [
      { id: "one", name: "One", position: 0, workflowKey: "TODO" },
      { id: "two", name: "Two", position: 1, workflowKey: "IN_PROGRESS" },
    ] : [] });
  }));
});
async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={client}><KanbanBoard projectId="p" dndV2Enabled={false} /></QueryClientProvider>);
  await screen.findByText("Alpha");
  await act(async () => {});
}
it.each([true, false])("does not mount legacy DnD or send drag mutations (reorder flag=%s)", async reorderEnabled => {
  control.props = {}; control.reorderEnabled = reorderEnabled;
  await setup();
  expect(control.props.onDragStart).toBeUndefined();
  expect(control.props.onDragEnd).toBeUndefined();
  expect(control.props.collisionDetection).toBeUndefined();
  const card = screen.getByText("Alpha");
  fireEvent.dragStart(card); fireEvent.dragOver(screen.getByRole("region", { name: "two" })); fireEvent.drop(card); fireEvent.dragEnd(card);
  expect(screen.getByRole("region", { name: "one" })).toHaveTextContent("AlphaBetaGamma");
  expect(screen.getByRole("region", { name: "two" })).not.toHaveTextContent("Alpha");
  expect(screen.queryByLabelText("Место вставки задачи")).not.toBeInTheDocument();
  expect(control.requests).toEqual([]);
});

it("shows no manual drag handles, move menus or stale drag instructions", async () => {
  control.props = {}; await setup();
  expect(screen.queryByRole("button", { name: /Переместить задачу|Действия задачи/ })).not.toBeInTheDocument();
  expect(control.props.accessibility).toBeUndefined();
  expect(screen.queryByText(/Нажмите пробел, чтобы взять/)).not.toBeInTheDocument();
  expect(control.requests).toEqual([]);
});
