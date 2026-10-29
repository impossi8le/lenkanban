import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const page = vi.hoisted(() => ({ pathname: "/projects/PRIVATE_PROJECT/board", actor: "synthetic-actor" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => page.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({
  status: page.actor ? "authenticated" : "unauthenticated",
  data: page.actor ? { user: { id: page.actor } } : null,
}) }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: () => null, closestCorners: () => [],
  PointerSensor: class {}, KeyboardSensor: class {}, useSensor: vi.fn(), useSensors: vi.fn(),
}));
vi.mock("@dnd-kit/sortable", () => ({ sortableKeyboardCoordinates: vi.fn() }));
vi.mock("@/hooks/useProjectBoard", () => ({ useProjectBoard: () => ({ socket: null, isJoined: false }) }));
// Queue polling is tested separately; this fixture's fetch collector represents
// only telemetry requests, including the assertion that disabled emits none.
vi.mock("@/hooks/useRequestQueueUnseenCounts", () => ({ useRequestQueueUnseenCounts: () => ({
  total: 0, byProject: {}, isLoading: false, isError: false,
}) }));
// Notification aggregate polling has its own actor/cache suite; this collector
// observes telemetry only, including the strict disabled-no-traffic assertion.
vi.mock("@/hooks/useNotificationSummary", () => ({ useNotificationSummary: () => ({
  actorId: page.actor, data: page.actor ? { actorId: page.actor, count: 0, byProject: {}, byTask: {}, unscopedCount: 0 } : undefined,
  count: page.actor ? 0 : undefined, byProject: page.actor ? {} : undefined, byTask: page.actor ? {} : undefined,
  isLoading: false, isError: false,
}) }));
// Change-summary polling has its own actor/ACL suites; isolate it from this telemetry collector.
vi.mock("@/hooks/useTaskChanges", () => ({ useTaskChanges: () => ({ data: undefined }) }));
vi.mock("@/components/kanban/Card", () => ({ KanbanCardView: () => null }));
vi.mock("@/components/bulk/BulkActionsBar", () => ({ BulkActionsBar: () => null }));
vi.mock("@/components/kanban/Column", () => ({
  KanbanColumn: ({ id, tasks }: { id: string; tasks: { id: string; title: string }[] }) =>
    <section aria-label={id}>{tasks.map(task => <div key={task.id}>{task.title}</div>)}</section>,
}));
import { KanbanBoard } from "@/components/kanban/Board";
import { TelemetryProvider } from "@/providers/telemetry-provider";
import { getBrowserTelemetryClient, resetTelemetrySessionDisable } from "@/lib/telemetry/client";

const fetchMock = vi.fn<typeof fetch>();
let events: Array<Record<string, unknown>> = [];
let initializations = 0;
let release: (() => void) | undefined;
let clock = 0;
let query: QueryClient;
beforeEach(() => {
  page.pathname = "/projects/PRIVATE_PROJECT/board";
  page.actor = "synthetic-actor";
  events = [];
  initializations = 0;
  release = undefined;
  clock = 0;
  window.sessionStorage.clear();
  resetTelemetrySessionDisable();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  query.setQueryData(["tasks", "PRIVATE_PROJECT", page.actor, false], [{ id: "PRIVATE_TASK", title: "PRIVATE_TASK_TITLE", projectId: "PRIVATE_PROJECT", columnId: "one", priority: "LOW", position: 10, version: 1 }]);
  query.setQueryData(["columns", "PRIVATE_PROJECT"], [{ id: "one", projectId: "PRIVATE_PROJECT", name: "One", color: "#123456", position: 0, workflowKey: "TODO" }]);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  query.clear();
  getBrowserTelemetryClient()?.dispose();
  resetTelemetrySessionDisable();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function collector(delayed = false) {
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.kind === "session.start") {
      initializations++;
      if (delayed) await new Promise<void>(resolve => { release = resolve; });
      const expiry = Date.now() + 3_600_000;
      return Response.json({ success: true, data: {
        sessionId: body.sessionId,
        sessionToken: `v1.${expiry}.${"0".repeat(64)}`,
        expiresAt: new Date(expiry).toISOString(),
      } });
    }
    events.push(...body.events);
    return Response.json({ success: true, data: { accepted: body.events.map((event: { eventId: string }) => event.eventId) } });
  });
}
function tree(enabled = true) {
  return <TelemetryProvider enabled={enabled}><QueryClientProvider client={query}><KanbanBoard projectId="PRIVATE_PROJECT" dndV2Enabled={false} /></QueryClientProvider></TelemetryProvider>;
}
async function ready() {
  const client = getBrowserTelemetryClient()!;
  await waitFor(() => expect(client.getDiagnosticContext().endsWith(":unready")).toBe(false));
  return client;
}
const boards = () => events.filter(event => event.event === "ui.action" && event.screen === "board");

it("records the actual board route after delayed identity initialization without private route data", async () => {
  collector(true);
  const view = render(tree());
  await waitFor(() => expect(initializations).toBe(1));
  expect(boards()).toHaveLength(0);
  await act(async () => { release?.(); });
  const client = await ready();
  await client.flush();
  expect(boards()).toHaveLength(1);
  view.rerender(tree());
  await client.flush();
  expect(boards()).toHaveLength(1);
  client.captureRenderFailure("11111111-1111-4111-8111-111111111111");
  await client.flush();
  expect(events.filter(event => event.event === "client.breadcrumb" && event.kind === "navigation" && event.name === "board")).toHaveLength(1);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_PROJECT|PRIVATE_TASK|\/projects\/|synthetic-actor/);
});

it("records later board navigation while retaining one actor session and respecting route departure", async () => {
  collector();
  const view = render(tree());
  const client = await ready();
  await client.flush();
  const identity = vi.spyOn(client, "setIdentity");
  page.pathname = "/projects/PRIVATE_PROJECT/tasks/PRIVATE_TASK";
  view.rerender(tree());
  clock = 2_000;
  page.pathname = "/projects/PRIVATE_PROJECT/board";
  view.rerender(tree());
  await client.flush();
  expect(boards()).toHaveLength(2);
  expect(initializations).toBe(1);
  expect(identity).not.toHaveBeenCalled();
  expect(new Set(boards().map(event => event.sessionId)).size).toBe(1);
});

it("does not emit a stale board path when navigation changes during initialization", async () => {
  collector(true);
  const view = render(tree());
  await waitFor(() => expect(initializations).toBe(1));
  page.pathname = "/my-tasks";
  view.rerender(tree());
  await act(async () => { release?.(); });
  const client = await ready();
  await client.flush();
  expect(boards()).toHaveLength(0);
  expect(initializations).toBe(1);
});

it("cancels a pending board observation on logout without reviving the old identity", async () => {
  collector(true);
  const view = render(tree());
  await waitFor(() => expect(initializations).toBe(1));
  const client = getBrowserTelemetryClient()!;
  page.actor = null;
  view.rerender(tree());
  await act(async () => { release?.(); });
  await client.flush();
  expect(boards()).toHaveLength(0);
  expect(client.getDiagnosticContext().endsWith(":unready")).toBe(true);
  expect(client.recordScreen("board")).toBe(false);
});

it("never constructs a session when disabled or publishes a board screen for a non-board route", async () => {
  collector();
  const view = render(tree(false));
  expect(fetchMock).not.toHaveBeenCalled();
  page.pathname = "/messages";
  view.rerender(tree(true));
  const client = await ready();
  await client.flush();
  expect(boards()).toHaveLength(0);
});
