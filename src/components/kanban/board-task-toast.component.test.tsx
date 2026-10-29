import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const transport = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  const acknowledgements: Listener[] = [];
  const socket = {
    connected: false,
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return socket;
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return socket;
    },
    once(event: string, listener: Listener) {
      const once: Listener = (...args: unknown[]) => {
        socket.off(event, once);
        listener(...args);
      };
      return socket.on(event, once);
    },
    emit(event: string, _payload: unknown, ack?: Listener) {
      if (event === "project:join" && ack) acknowledgements.push(ack);
      return socket;
    },
  };
  return {
    socket,
    listeners,
    acknowledgements,
    receive(event: string, payload?: unknown) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
  };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => transport.socket }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "me", name: "Me", email: "me@example.com" } } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { children: ReactNode }) => props.children,
  DragOverlay: () => null,
  PointerSensor: class {},
  KeyboardSensor: class {},
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({ sortableKeyboardCoordinates: vi.fn() }));
vi.mock("./FilterBar", () => ({ FilterBar: () => null }));
vi.mock("./Column", () => ({
  KanbanColumn: ({ id, tasks }: { id: string; tasks: { id: string; title: string }[] }) => (
    <section aria-label={id}>{tasks.map((task) => <div key={task.id}>{task.title}</div>)}</section>
  ),
}));
vi.mock("./Card", () => ({ KanbanCardView: () => null }));
vi.mock("@/components/bulk/BulkActionsBar", () => ({ BulkActionsBar: () => null }));
vi.mock("@/features/kanban/dnd/KanbanDndBoard", () => ({ KanbanDndBoard: () => null }));

// Isolate presentation: this suite verifies Board data/transport, while the
// real four-stage demo rendering has its own component coverage.
vi.mock("./RequestBoardPresentation", () => ({ RequestBoardPresentation: ({ tasks }: { tasks: { id: string; title: string; columnId?: string | null }[] }) => <div role="region" aria-label="Колонки канбан-доски" tabIndex={0}>
  {!tasks.length && <p>На доске пока нет задач</p>}
  {["one", "two", "todo", "review"].map(id => <section key={id} aria-label={id} data-reorder-enabled="false">{tasks.filter(task => task.columnId === id).map(task => <div key={task.id} data-testid="sorted-task" data-task-id={task.id}>{task.title}</div>)}</section>)}
</div> }));
import { KanbanBoard } from "./Board";

const timestamps = { createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" };
const existingTask = {
  id: "existing", title: "Existing", projectId: "p", columnId: "todo", priority: "MEDIUM",
  status: "TODO", position: 1024, version: 1, assignees: [], tags: [], _count: { messages: 0 },
  ...timestamps,
};

function stubBoard(columns: Record<string, unknown>[], tasks = [existingTask]) {
  vi.stubGlobal("fetch", async (url: string) => {
    const data = url.startsWith("/api/tasks?") ? tasks
      : url.endsWith("/columns") ? columns
        : [];
    return Response.json({ success: true, data });
  });
}

async function setup(columnId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={client}><KanbanBoard projectId="p" dndV2Enabled={false} /></QueryClientProvider>);
  await screen.findByLabelText(columnId);
  await act(async () => {
    transport.socket.connected = true;
    transport.receive("connect");
    transport.acknowledgements.shift()!({ ok: true });
  });
  return client;
}

beforeEach(() => {
  transport.acknowledgements.length = 0;
  transport.socket.connected = false;
});

afterEach(() => {
  cleanup();
  transport.listeners.clear();
  vi.unstubAllGlobals();
});

it("names the localized column in the task-created toast by workflowKey, not by its display name", async () => {
  // Column names are localized, so the status identifier must come from workflowKey.
  stubBoard([
    { id: "todo", projectId: "p", name: "К выполнению", color: "#3b82f6", position: 0, workflowKey: "TODO", ...timestamps },
  ]);
  await setup("todo");

  await act(async () => {
    transport.receive("task:created", {
      id: "new", title: "Новая задача", projectId: "p", columnId: "todo", priority: "MEDIUM",
      status: "TODO", position: 2048, version: 1, createdById: "other", request: null, ...timestamps,
    });
  });

  expect(toast.success).toHaveBeenCalledWith("Добавлена новая задача", {
    description: "\"Новая задача\" добавлена другим пользователем в К выполнению",
  });
});

it("matches the REVIEW workflow key against the derived IN_REVIEW task status", async () => {
  stubBoard([
    { id: "review", projectId: "p", name: "На проверке", color: "#f59e0b", position: 0, workflowKey: "REVIEW", ...timestamps },
  ]);
  await setup("review");

  await act(async () => {
    transport.receive("task:created", {
      id: "new", title: "На проверку", projectId: "p", columnId: "review", priority: "MEDIUM",
      status: "IN_REVIEW", position: 2048, version: 1, createdById: "other", request: null, ...timestamps,
    });
  });

  expect(toast.success).toHaveBeenCalledWith("Добавлена новая задача", {
    description: "\"На проверку\" добавлена другим пользователем в На проверке",
  });
});

it("shows another author's newly submitted request on task:updated although its private draft was never visible", async () => {
  const tasks = [existingTask];
  stubBoard([{ id: "todo", projectId: "p", name: "Новые", color: "#3b82f6", position: 0, workflowKey: "TODO", ...timestamps }], tasks);
  await setup("todo");
  const submitted = { ...existingTask, id: "submitted", title: "New request from applicant", version: 1, createdById: "applicant", request: { state: "SUBMITTED", executorId: null } };
  expect(screen.queryByText(submitted.title)).not.toBeInTheDocument();
  tasks.push(submitted);
  await act(async () => { transport.receive("task:updated", submitted); });
  expect(await screen.findByText(submitted.title)).toBeInTheDocument();
  await act(async () => { transport.receive("task:updated", submitted); });
  expect(screen.getAllByText(submitted.title)).toHaveLength(1);
  await act(async () => { transport.receive("task:created", submitted); });
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("Новая заявка в очереди", { description: "Откройте обращение, чтобы взять его в работу." });
  await act(async () => { transport.receive("task:updated", { ...submitted, projectId: "other", title: "Other board" }); });
  expect(screen.queryByText("Other board")).not.toBeInTheDocument();
  await act(async () => { transport.receive("task:updated", { ...submitted, version: 0, title: "Old event" }); });
  expect(screen.queryByText("Old event")).not.toBeInTheDocument();
});

it('never appends a missing-marker create or private DRAFT update; it hydrates the canonical HTTP list instead', async () => {
  const tasks = [existingTask];
  stubBoard([{ id: 'todo', projectId: 'p', name: 'Новые', color: '#3b82f6', position: 0, workflowKey: 'TODO', ...timestamps }], tasks);
  const client = await setup('todo');
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const draft = { ...existingTask, id: 'private-draft', title: 'Synthetic private draft', createdById: 'me' };
  await act(async () => transport.receive('task:created', draft));
  expect(screen.queryByText(draft.title)).not.toBeInTheDocument();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks', 'p'] });
  const cached = client.getQueriesData({ queryKey: ['tasks', 'p'] }).flatMap(([, rows]) => Array.isArray(rows) ? rows : []);
  expect(cached).toContainEqual(existingTask);
  expect(cached.some(row => row.id === draft.id)).toBe(false);
  await act(async () => transport.receive('task:updated', { ...draft, request: { state: 'DRAFT' } }));
  expect(screen.queryByText(draft.title)).not.toBeInTheDocument();
  expect(screen.getByText(existingTask.title)).toBeVisible();
  expect(toast.success).not.toHaveBeenCalled();
  const legacy = { ...existingTask, id: 'hydrated-legacy', title: 'Hydrated ordinary legacy', request: null };
  await act(async () => transport.receive('task:created', legacy));
  expect(screen.getByText(legacy.title)).toBeVisible();
});
