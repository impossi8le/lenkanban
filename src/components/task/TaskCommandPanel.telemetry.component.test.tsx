import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskType } from "@/components/kanban/Card";
import type { TaskSaveCallbacks } from "@/components/task/TaskDetailPanel";

const bridge = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/telemetry/client", async () => ({
  ...await vi.importActual("@/lib/telemetry/client"),
  getBrowserTelemetryClient: () => bridge.current,
}));
const api = vi.hoisted(() => ({ patch: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiPatch: api.patch, apiFetch: api.get }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "actor" } } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("@/hooks/useTaskDetailRealtime", () => ({ useTaskDetailRealtime: () => {} }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/task/TaskDetailPanel", () => ({
  TaskDetailPanel: ({ task, onSave, onClose, saveStatus }: {
    task: TaskType;
    saveStatus?: import("react").ReactNode;
    onSave: (id: string, data: Record<string, unknown>, callbacks?: TaskSaveCallbacks) => void;
    onClose: () => void;
  }) => <div>{saveStatus}
    <p>Карточка: {task.title}</p>
    <button onClick={() => onSave(task.id, { title: "PRIVATE-NEW-TITLE" })}>Save intent</button>
    <button onClick={() => onSave(task.id, { title: task.title, columnId: "column-next", expectedVersion: task.version })}>Move intent</button>
    <button onClick={() => onSave(task.id, { title: task.title })}>No-op intent</button>
    <button onClick={() => onSave(task.id, { title: "" })}>Invalid intent</button>
    <button onClick={onClose}>Close editor</button>
  </div>,
}));

import { TelemetryClient } from "@/lib/telemetry/client";
import { TaskCommandPanel } from "@/components/task/TaskCommandPanel";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const PROOF = `v1.${NOW.getTime() + 3_600_000}.${"a".repeat(64)}`;
const task: TaskType = {
  id: "task-one", projectId: "project-one", title: "PRIVATE-TASK-TITLE", description: "PRIVATE-DESCRIPTION",
  priority: "HIGH", columnId: "column-one", position: 10, version: 7,
};

const queues: TelemetryClient[] = [];
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  api.patch.mockReset();
  api.get.mockReset();
  api.patch.mockResolvedValue({ taskId: task.id, projectId: task.projectId, version: 8, changed: true, replayed: false });
  api.get.mockResolvedValue({ ...task, title: "Актуальное", version: 8 });
  let sequence = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
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
  vi.unstubAllGlobals();
});

function telemetryEvents() {
  return fetchMock.mock.calls
    .filter(([url, options]) => String(url) === "/api/telemetry" && !String(options?.body).includes('"kind":"session.start"'))
    .flatMap(([, options]) => (JSON.parse(String(options?.body)) as { events: Array<Record<string, unknown>> }).events);
}
function canonicalReads() { return api.get.mock.calls.filter(([url]) => String(url).includes("?view=details")); }

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

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const element = () => <QueryClientProvider client={client}>
    <TaskCommandPanel projectId={task.projectId} taskId={task.id} task={task} onClose={vi.fn()} />
  </QueryClientProvider>;
  const view = render(element());
  await screen.findByText("Карточка: PRIVATE-TASK-TITLE");
  return { queue, rerender: () => view.rerender(element()) };
}

describe("task card telemetry", () => {
  it("records one screen.view for the card and not one per rerender", async () => {
    const { queue, rerender } = await setup();
    rerender();
    rerender();
    await queue.flush();
    const events = telemetryEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "ui.action", action: "screen.view", screen: "task.detail" });
  });

  it("records a scalar edit as task.update and never carries the edited text", async () => {
    const { queue } = await setup();
    fireEvent.click(screen.getByText("Save intent"));
    await screen.findByText("Карточка: Актуальное");
    await queue.flush();
    const events = telemetryEvents().filter(event => event.action === "task.update");
    expect(events.map(event => event.event)).toEqual(["ui.action"]);
    expect(Object.keys(events[0]).sort()).toEqual([
      "action", "actionId", "event", "eventId", "occurredAt", "schemaVersion", "seq", "sessionId", "traceId",
    ]);
    const serialized = JSON.stringify(fetchMock.mock.calls);
    expect(serialized).not.toContain("PRIVATE-NEW-TITLE");
    expect(serialized).not.toContain("PRIVATE-TASK-TITLE");
    expect(serialized).not.toContain("PRIVATE-DESCRIPTION");
  });

  it("records a column change as task.move rather than task.update", async () => {
    const { queue } = await setup();
    fireEvent.click(screen.getByText("Move intent"));
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await queue.flush();
    const actions = telemetryEvents().map(event => [event.event, event.action]);
    expect(actions).toEqual([
      ["ui.action", "screen.view"],
      ["ui.action", "task.move"],
    ]);
  });

  it("keeps the card and its edit working when telemetry has no session", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    bridge.current = null;
    render(<QueryClientProvider client={client}><TaskCommandPanel projectId={task.projectId} taskId={task.id} task={task} onClose={vi.fn()} /></QueryClientProvider>);
    await screen.findByText("Карточка: PRIVATE-TASK-TITLE");
    fireEvent.click(screen.getByText("Save intent"));
    await screen.findByText("Карточка: Актуальное");
    expect(telemetryEvents()).toHaveLength(0);
  });
  it("preserves the UI intention actionId in scalar PATCH and canonical read", async () => {
    const { queue } = await setup();
    fireEvent.click(screen.getByText("Save intent"));
    await screen.findByText("Карточка: Актуальное");
    await queue.flush();
    const action = telemetryEvents().find(event => event.event === "ui.action" && event.action === "task.update");
    expect(action).toBeDefined();
    expect(api.patch.mock.calls[0][2].actionId).toBe(action?.actionId);
    expect(canonicalReads()[0][2].actionId).toBe(action?.actionId);
  });
  it("connects the actual scalar PATCH result to the telemetry completion boundary", async () => {
    await setup();
    fireEvent.click(screen.getByText("Save intent"));
    await screen.findByText("Карточка: Актуальное");
    expect(typeof api.patch.mock.calls[0][2].onResult).toBe("function");
  });

  it("keeps one intention and frozen operation on retry with one truthful write completion", async () => {
    const { queue } = await setup();
    api.patch.mockImplementationOnce(async (_path, _body, context) => {
      context.onResult({ outcome: "failure", statusCode: 503, durationMs: 1 });
      throw Object.assign(new Error("SYNTHETIC"), { status: 503 });
    }).mockImplementationOnce(async (_path, _body, context) => {
      context.onResult({ outcome: "success", statusCode: 200, durationMs: 2 });
      return { taskId: task.id, projectId: task.projectId, version: 8 };
    });
    fireEvent.click(screen.getByText("Save intent"));
    const retry = await screen.findByRole("button", { name: "Повторить сохранение" });
    fireEvent.click(screen.getByText("Save intent")); // Blocked while the first outcome is unknown.
    fireEvent.click(retry);
    await screen.findByText("Карточка: Актуальное");
    await queue.flush();
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(api.patch.mock.calls[1][1]).toEqual(api.patch.mock.calls[0][1]);
    expect(api.patch.mock.calls[1][2]).toEqual(api.patch.mock.calls[0][2]);
    const action = telemetryEvents().filter(event => event.action === "task.update" && event.event === "ui.action");
    expect(action).toHaveLength(1);
    const results = telemetryEvents().filter(event => event.event === "client.request.result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ actionId: action[0].actionId, outcome: "failure", statusCode: 503 });
    expect(canonicalReads()[0][2]).toEqual({ actionId: action[0].actionId });
  });
  it("continues saving when beginning telemetry throws", async () => {
    const { queue } = await setup();
    vi.spyOn(queue, "beginAction").mockImplementation(() => { throw new Error("DIAGNOSTICS_ONLY"); });
    fireEvent.click(screen.getByText("Save intent"));
    await screen.findByText("Карточка: Актуальное");
    expect(api.patch).toHaveBeenCalledOnce();
    expect(api.patch.mock.calls[0][2].actionId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("continues saving and canonical reading when telemetry completion throws", async () => {
    const { queue } = await setup();
    vi.spyOn(queue, "finishAction").mockImplementation(() => { throw new Error("DIAGNOSTICS_ONLY"); });
    api.patch.mockImplementationOnce(async (_path, _body, context) => {
      context.onResult({ outcome: "success", statusCode: 200, durationMs: 1 });
      return { taskId: task.id, projectId: task.projectId, version: 8 };
    });
    fireEvent.click(screen.getByText("Save intent"));
    await screen.findByText("Карточка: Актуальное");
    expect(api.patch).toHaveBeenCalledOnce();
    expect(canonicalReads()).toHaveLength(1);
  });

  it("emits one truthful successful write result and no canonical-read completion", async () => {
    const { queue } = await setup();
    const requestId = "11111111-1111-4111-8111-111111111111";
    api.patch.mockImplementationOnce(async (_path, _body, context) => {
      context.onResult({ outcome: "success", statusCode: 200, requestId, durationMs: 1 });
      return { taskId: task.id, projectId: task.projectId, version: 8 };
    });
    fireEvent.click(screen.getByText("Save intent"));
    await screen.findByText("Карточка: Актуальное");
    await queue.flush();
    const events = telemetryEvents();
    const action = events.find(event => event.event === "ui.action" && event.action === "task.update");
    const results = events.filter(event => event.event === "client.request.result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ actionId: action?.actionId, outcome: "success", statusCode: 200, requestId });
    expect(canonicalReads()[0][2]).toEqual({ actionId: action?.actionId });
    expect(JSON.stringify(events)).not.toContain("PRIVATE-NEW-TITLE");
  });

  it("does not begin telemetry for normalized no-op or invalid scalar intent", async () => {
    const { queue } = await setup();
    const begin = vi.spyOn(queue, "beginAction");
    fireEvent.click(screen.getByText("No-op intent"));
    fireEvent.click(screen.getByText("Invalid intent"));
    expect(begin).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

});
