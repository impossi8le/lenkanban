vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/telemetry/client", async () => ({
  ...await vi.importActual("@/lib/telemetry/client"),
  getBrowserTelemetryClient: () => bridge.current,
}));
const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiPost: api.post, apiFetch: api.get }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated", data: { user: { id: "synthetic-actor" } } }) }));

import { TelemetryClient } from "@/lib/telemetry/client";
import { CreateTaskDialog } from "./CreateTaskDialog";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const PROOF = `v1.${NOW.getTime() + 3_600_000}.${"a".repeat(64)}`;
const PRIVATE_TITLE = "PRIVATE-TASK-TITLE-TOKEN";
const PRIVATE_DESCRIPTION = "PRIVATE-DESCRIPTION-TOKEN";

const queues: TelemetryClient[] = [];
const clients: QueryClient[] = [];
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  api.post.mockReset();
  api.get.mockReset();
  api.get.mockResolvedValue({ marked: false, state: null, version: 0 });
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

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const element = () => <QueryClientProvider client={client}><CreateTaskDialog projectId="project-1" canCreate open onClose={vi.fn()} /></QueryClientProvider>;
  const view = render(element());
  fireEvent.change(screen.getByLabelText("Кратко о проблеме"), { target: { value: PRIVATE_TITLE } });
  fireEvent.change(screen.getByLabelText("Подробности (необязательно)"), { target: { value: PRIVATE_DESCRIPTION } });
  return { queue, rerender: () => view.rerender(element()) };
}

describe("create-task telemetry", () => {
  it("pairs one task.create intent with its success result and carries no task text", async () => {
    api.post.mockResolvedValue({ id: "new-task" });
    const { queue, rerender } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Отправить обращение" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[1]).toEqual(["/api/tasks/new-task", expect.objectContaining({ action: "submit", expectedVersion: 0 })]);
    await queue.flush();
    const events = telemetryEvents();
    expect(events.map(event => [event.event, event.action])).toEqual([
      ["ui.action", "task.create"],
      ["client.request.result", "task.create"],
    ]);
    expect(events[1]).toMatchObject({ outcome: "success" });
    expect(events[0].actionId).toBe(events[1].actionId);
    rerender();
    await queue.flush();
    expect(telemetryEvents()).toHaveLength(2);
    const serialized = JSON.stringify(fetchMock.mock.calls);
    expect(serialized).not.toContain(PRIVATE_TITLE);
    expect(serialized).not.toContain(PRIVATE_DESCRIPTION);
  });

  it("reports a failed creation as a failure result while keeping the draft", async () => {
    api.post.mockRejectedValue(Object.assign(new Error("PRIVATE-SERVER-ERROR"), { status: 400 }));
    const { queue } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Отправить обращение" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось подтвердить отправку");
    await queue.flush();
    const events = telemetryEvents();
    expect(events.map(event => [event.event, event.action, event.outcome, event.statusCode])).toEqual([
      ["ui.action", "task.create", undefined, undefined],
      ["client.request.result", "task.create", "failure", undefined],
      ["client.breadcrumb", "app.breadcrumb", undefined, undefined],
      ["client.breadcrumb", "app.breadcrumb", "failure", undefined],
    ]);
    expect(events[0].actionId).toBe(events[1].actionId);
    expect(events.slice(2).map(event => event.actionId)).toEqual([events[0].actionId, events[0].actionId]);
    expect(api.post).toHaveBeenCalledOnce();
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Кратко о проблеме")).toHaveValue(PRIVATE_TITLE);
    expect(screen.getByLabelText("Подробности (необязательно)")).toHaveValue(PRIVATE_DESCRIPTION);
    expect(screen.getByLabelText("Кратко о проблеме")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Повторить отправку" })).toBeEnabled();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("PRIVATE-SERVER-ERROR");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(PRIVATE_DESCRIPTION);
  });

  it("keeps creation working when telemetry has no session", async () => {
    api.post.mockResolvedValue({ id: "new-task" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    bridge.current = null;
    render(<QueryClientProvider client={client}><CreateTaskDialog projectId="project-1" canCreate open onClose={vi.fn()} /></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("Кратко о проблеме"), { target: { value: PRIVATE_TITLE } });
      fireEvent.click(screen.getByRole("button", { name: "Отправить обращение" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(telemetryEvents()).toHaveLength(0);
  });
});
