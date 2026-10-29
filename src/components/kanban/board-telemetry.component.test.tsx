import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TaskType } from "./Card";

const bridge = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/telemetry/client", async () => ({
  ...await vi.importActual("@/lib/telemetry/client"),
  getBrowserTelemetryClient: () => bridge.current,
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: () => null, closestCorners: () => [],
  PointerSensor: class {}, KeyboardSensor: class {}, useSensor: vi.fn(), useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({ sortableKeyboardCoordinates: vi.fn() }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useProjectBoard", () => ({ useProjectBoard: () => ({ socket: null, isJoined: false }) }));
vi.mock("./Card", () => ({ KanbanCardView: () => null }));
vi.mock("@/components/bulk/BulkActionsBar", () => ({ BulkActionsBar: () => null }));
vi.mock("./Column", () => ({
  KanbanColumn: ({ id, tasks }: { id: string; tasks: TaskType[] }) => (
    <section aria-label={id}>{tasks.map(task => <div key={task.id} data-testid="board-task">{task.title}</div>)}</section>
  ),
}));
// The real FilterBar opens Radix selects; the spy surfaces the callbacks instead.
vi.mock("./FilterBar", () => ({
  FilterBar: ({ onStatusChange, onPriorityChange, onAssigneeChange, onTagsChange, onSortChange }: {
    onStatusChange: (value: string | null) => void;
    onPriorityChange: (value: string | null) => void;
    onAssigneeChange: (value: string | null) => void;
    onTagsChange: (value: string[] | null) => void;
    onSortChange: (value: string) => void;
  }) => <div>
    <button onClick={() => onStatusChange("PRIVATE-COLUMN-VALUE")}>filter-status</button>
    <button onClick={() => onPriorityChange("PRIVATE-PRIORITY-VALUE")}>filter-priority</button>
    <button onClick={() => onAssigneeChange("PRIVATE-ASSIGNEE-VALUE")}>filter-assignee</button>
    <button onClick={() => onTagsChange(["PRIVATE-TAG-VALUE"])}>filter-tags</button>
    <button onClick={() => onSortChange("PRIVATE-SORT-VALUE")}>filter-sort</button>
  </div>,
}));

import { TelemetryClient } from "@/lib/telemetry/client";
// Isolate presentation: this suite verifies Board data/transport, while the
// real four-stage demo rendering has its own component coverage.
vi.mock("./RequestBoardPresentation", () => ({ RequestBoardPresentation: ({ tasks }: { tasks: { id: string; title: string; columnId?: string | null }[] }) => <div role="region" aria-label="Колонки канбан-доски" tabIndex={0}>
  {!tasks.length && <p>На доске пока нет задач</p>}
  {["one", "two", "todo", "review"].map(id => <section key={id} aria-label={id} data-reorder-enabled="false">{tasks.filter(task => task.columnId === id).map(task => <div key={task.id} data-testid="sorted-task" data-task-id={task.id}>{task.title}</div>)}</section>)}
</div> }));
import { KanbanBoard } from "./Board";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const PROOF = `v1.${NOW.getTime() + 3_600_000}.${"a".repeat(64)}`;
const date = "2026-01-01T00:00:00.000Z";
const columns = [
  { id: "one", projectId: "p", name: "One", color: "#123456", position: 0, workflowKey: "TODO", createdAt: date, updatedAt: date },
];
const tasks: TaskType[] = [
  { id: "task-a", title: "PRIVATE-TASK-TITLE", columnId: "one", position: 10, priority: "LOW", projectId: "p", version: 1 },
];

const queues: TelemetryClient[] = [];
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { kind?: string; sessionId?: string; events?: Array<{ eventId: string }> };
    if (body.kind === "session.start") {
      return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() } });
    }
    return Response.json({ success: true, data: { accepted: (body.events ?? []).map(event => event.eventId) } });
  });
});

afterEach(() => {
  cleanup();
  queues.splice(0).forEach(queue => queue.dispose());
  clients.splice(0).forEach(client => client.clear());
  bridge.current = null;
});

function telemetryEvents() {
  return fetchMock.mock.calls
    .filter(([url, options]) => String(url) === "/api/telemetry" && !String(options?.body).includes('"kind":"session.start"'))
    .flatMap(([, options]) => (JSON.parse(String(options?.body)) as { events: Array<Record<string, unknown>> }).events);
}

async function setup() {
  let seq = 0;
  const queue = new TelemetryClient({
    fetch: fetchMock,
    wallClock: () => NOW,
    clock: () => 0,
    uuid: () => `${(++seq).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
  });
  queues.push(queue);
  bridge.current = queue;
  await queue.setIdentity("synthetic-actor");

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(["tasks", "p", undefined, false], tasks);
  client.setQueryData(["columns", "p"], columns);
  client.setQueryData(["project-members", "p"], []);
  client.setQueryData(["tags", "p"], []);
  const element = () => <QueryClientProvider client={client}><KanbanBoard projectId="p" dndV2Enabled={false} /></QueryClientProvider>;
  const view = render(element());
  await screen.findByRole("region", { name: "one" });
  return { queue, rerender: () => view.rerender(element()) };
}

describe("simplified board telemetry", () => {
  it("does not expose removed filters or collect their values, including after rerenders", async () => {
    const { queue, rerender } = await setup();
    for (const label of ["filter-status", "filter-priority", "filter-assignee", "filter-tags", "filter-sort"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    rerender(); rerender();
    await queue.flush();
    expect(telemetryEvents()).toEqual([]);
    expect(screen.getByText("PRIVATE-TASK-TITLE")).toBeInTheDocument();
  });
});
