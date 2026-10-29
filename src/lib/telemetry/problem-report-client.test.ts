import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TelemetryClient, ProblemReportFailure, resetTelemetrySessionDisable } from "./client";

const wall = new Date("2026-10-26T08:00:00.000Z");
const expiresAt = new Date(wall.getTime() + 86400000).toISOString();
const proof = `v1.${Date.parse(expiresAt)}.${"a".repeat(64)}`;
const clients: TelemetryClient[] = [];
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
type Wire = { sessionId: string; sessionToken: string; events: Array<{ eventId: string; errorId: string; breadcrumbs: unknown[] }> };
function fixture(deliver?: (wire: Wire, init: RequestInit) => Promise<Response>) {
  let id = 0, mono = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    if (input.kind) return Response.json({ success: true, data: { sessionId: input.sessionId, sessionToken: proof, expiresAt } });
    return deliver ? deliver(input, init!) : Response.json({ success: true, data: { accepted: input.events.map((event: { eventId: string }) => event.eventId) } });
  });
  const client = new TelemetryClient({ fetch, clock: () => mono, wallClock: () => wall, uuid: () => `${(++id).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
  clients.push(client);
  return { client, fetch, now: (value: number) => { mono = value; }, bodies: () => fetch.mock.calls.map(([, init]) => String(init?.body)).filter(body => !JSON.parse(body).kind) };
}
beforeEach(() => { resetTelemetrySessionDisable(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); resetTelemetrySessionDisable(); vi.useRealTimers(); });

it("does not create or send a report until an authenticated diagnostic session is ready", () => {
  const f = fixture();
  expect(f.client.prepareProblemReport("slow", "home")).toBeNull();
  expect(f.fetch).not.toHaveBeenCalled();
});
it("waits for its exact server ACK, shares an in-flight attempt and preserves a frozen snapshot", async () => {
  const ack = deferred<Response>();
  const f = fixture(async () => ack.promise);
  await f.client.setIdentity("actor-A");
  f.client.recordNavigation("board");
  const draft = f.client.prepareProblemReport("slow", "board")!;
  expect(Object.isFrozen(draft)).toBe(true);
  let settled = false;
  const sending = f.client.sendProblemReport(draft); void sending.then(() => { settled = true; });
  expect(f.client.sendProblemReport(draft)).toBe(sending);
  await Promise.resolve(); expect(settled).toBe(false);
  const wire = JSON.parse(f.bodies()[0]);
  f.client.recordNavigation("settings");
  expect(wire.events[0].breadcrumbs.map((crumb: { name: string }) => crumb.name)).toEqual(["board"]);
  expect(wire.events[0].errorId).toBe(draft.reportId);
  expect(wire.events[0].event).toBe("client.problem.reported");
  expect(wire.events[0].action).toBe("app.problem.report");
  ack.resolve(Response.json({ success: true, data: { accepted: [wire.events[0].eventId] } }));
  expect(await sending).toEqual({ reportId: draft.reportId, breadcrumbCount: 1, truncated: false });
  expect(f.bodies()).toHaveLength(1);
  await f.client.sendProblemReport(draft);
  expect(f.bodies()).toHaveLength(1);
});
it.each(["missing-ack", "server-error", "offline"])("keeps nonce and exact encoded report for explicit retry after %s", async mode => {
  let attempt = 0;
  const f = fixture(async wire => {
    if (++attempt === 1) {
      if (mode === "offline") throw new TypeError("SYNTHETIC_PRIVATE_ERROR");
      return mode === "server-error" ? new Response(null, { status: 500 }) : Response.json({ success: true, data: { accepted: [] } });
    }
    return Response.json({ success: true, data: { accepted: [wire.events[0].eventId] } });
  });
  await f.client.setIdentity("actor-A"); f.client.recordOperation("task.create");
  const draft = f.client.prepareProblemReport("button", "home")!;
  await expect(f.client.sendProblemReport(draft)).rejects.toMatchObject({ code: "unconfirmed" });
  f.client.recordNavigation("settings");
  await expect(f.client.sendProblemReport(draft)).resolves.toMatchObject({ reportId: draft.reportId });
  expect(f.bodies()[1]).toBe(f.bodies()[0]);
  expect(f.bodies().join("")).not.toContain("SYNTHETIC_PRIVATE_ERROR");
});
it("trims oldest breadcrumbs to fit the entire signed envelope and never exposes private or monotonic fields", async () => {
  const f = fixture(); await f.client.setIdentity("actor-A");
  for (let i = 0; i < 90; i++) f.client.recordBreadcrumb("request", "/api/tasks/:id/checklist/:itemId", {
    durationMs: 86400000, statusCode: 599, outcome: "failure", attempt: 3, errorCode: "HTTP_5XX",
    private: "SYNTHETIC_PASSWORD_COOKIE_TASK_TEXT",
  } as Parameters<TelemetryClient["recordBreadcrumb"]>[2]);
  const before = f.client.getBreadcrumbSnapshot();
  const draft = f.client.prepareProblemReport("error", "home")!;
  await f.client.sendProblemReport(draft);
  const payload = f.bodies()[0], wire = JSON.parse(payload);
  expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(8192);
  expect(draft.breadcrumbCount).toBeLessThan(before.length);
  expect(draft.truncated).toBe(true);
  expect(wire.events[0].breadcrumbs.at(-1).eventId).toBe(before.at(-1)?.eventId);
  expect(payload).not.toContain("SYNTHETIC_PASSWORD_COOKIE_TASK_TEXT");
  expect(wire.events[0].breadcrumbs.every((crumb: object) => !Object.hasOwn(crumb, "at"))).toBe(true);
  expect(JSON.stringify(wire.events[0])).not.toContain(proof);
});
it("rejects a pending old session immediately, clears its UI subscriber and ignores a late ACK", async () => {
  const ack = deferred<Response>(); const f = fixture(async () => ack.promise);
  await f.client.setIdentity("actor-A");
  const changed = vi.fn(); const unsubscribe = f.client.subscribeSessionChange(changed);
  const draft = f.client.prepareProblemReport("other", "home")!;
  const pending = f.client.sendProblemReport(draft);
  const failure = expect(pending).rejects.toMatchObject({ code: "changed" });
  const wire = JSON.parse(f.bodies()[0]);
  await f.client.setIdentity("actor-B"); await failure;
  expect(changed).toHaveBeenCalledTimes(1);
  ack.resolve(Response.json({ success: true, data: { accepted: [wire.events[0].eventId] } }));
  await expect(f.client.sendProblemReport(draft)).rejects.toMatchObject({ code: "changed" });
  unsubscribe();
});
it("bounds one attempt by the existing transport deadline without changing the retry intent", async () => {
  const f = fixture(async () => new Promise(() => {})); await f.client.setIdentity("actor-A");
  const draft = f.client.prepareProblemReport("slow", "home")!;
  const pending = f.client.sendProblemReport(draft);
  const assertion = expect(pending).rejects.toMatchObject({ code: "unconfirmed" });
  await vi.advanceTimersByTimeAsync(5000); await assertion;
  expect(f.bodies()).toHaveLength(1);
  expect(f.fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
});
it("never reports success for rejection or disabled collection", async () => {
  const f = fixture(async () => Response.json({ error: { code: "TELEMETRY_UNAVAILABLE" } }, { status: 503 }));
  await f.client.setIdentity("actor-A"); const draft = f.client.prepareProblemReport("other", "home")!;
  await expect(f.client.sendProblemReport(draft)).rejects.toBeInstanceOf(ProblemReportFailure);
  expect(f.client.prepareProblemReport("other", "home")).toBeNull();
  expect(f.bodies()).toHaveLength(1);
});

it("records passive request durations as diagnostics only, with safe unknown status and no collector recursion", async () => {
  const f = fixture();
  expect(f.client.recordRequestTiming("/api/tasks", { durationMs: 10 })).toBe(false);
  await f.client.setIdentity("actor-A");
  expect(f.client.recordRequestTiming("/api/tasks", { durationMs: 12 })).toBe(true);
  expect(f.client.recordRequestTiming("/api/tasks", { durationMs: 5, statusCode: 403, outcome: "rejected" })).toBe(true);
  expect(f.client.recordRequestTiming("/api/tasks?search=SECRET", { durationMs: 1 })).toBe(false);
  expect(f.client.recordRequestTiming("/api/telemetry", { durationMs: 1 })).toBe(false);
  expect(f.client.recordRequestTiming("/api/tasks", { durationMs: -1 })).toBe(false);
  expect(f.client.recordRequestTiming("/api/tasks", { durationMs: 1, statusCode: 0 })).toBe(false);
  await f.client.flush();
  const events = JSON.parse(f.bodies()[0]).events;
  expect(events).toHaveLength(2);
  expect(events.every((event: { event: string; action: string }) => event.event === "client.breadcrumb" && event.action === "app.breadcrumb")).toBe(true);
  expect(events[0]).not.toHaveProperty("statusCode");
  expect(events[0]).not.toHaveProperty("outcome");
  expect(events[1]).toMatchObject({ statusCode: 403, outcome: "rejected", durationMs: 5 });
  expect(f.client.getBreadcrumbSnapshot()).toHaveLength(2);
});
