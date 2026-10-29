import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TelemetryClient, getBrowserTelemetryClient, isCancellationError, isTelemetryDisabledForSession,
} from "./client";
import type { ClientTelemetryEvent } from "./contract";

const WALL = new Date("2026-10-20T12:00:00.000Z");
const EXPIRY = new Date(WALL.getTime() + 24 * 60 * 60 * 1000).toISOString();
const PROOF = `v1.${Date.parse(EXPIRY)}.${"a".repeat(64)}`;
type Batch = { sessionId: string; sessionToken: string; events: ClientTelemetryEvent[] };
type Init = { kind: "session.start"; sessionId: string };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function initOk(input: Init) {
  return Response.json({ success: true, data: { sessionId: input.sessionId, sessionToken: PROOF, expiresAt: EXPIRY } });
}
function ack(input: Batch) { return Response.json({ success: true, data: { accepted: input.events.map(event => event.eventId) } }); }
const clients: TelemetryClient[] = [];
function fixture(options: { init?: (input: Init, init?: RequestInit) => Promise<Response>; batch?: (input: Batch, init?: RequestInit) => Promise<Response>; uuid?: () => string } = {}) {
  let mono = 0;
  let wall = WALL;
  let seq = 0;
  const uuid = vi.fn(options.uuid ?? (() => `${(++seq).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`));
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as Init | Batch;
    if ("kind" in input) return options.init ? options.init(input, init) : initOk(input);
    return options.batch ? options.batch(input, init) : ack(input);
  });
  const client = new TelemetryClient({ fetch, clock: () => mono, wallClock: () => wall, uuid });
  clients.push(client);
  const batches = () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Batch & { kind?: string }).filter(input => !input.kind);
  return { client, fetch, uuid, batches, now: (value: number) => { mono = value; }, wall: (value: Date) => { wall = value; },
    advance: async (ms: number) => { mono += ms; await vi.advanceTimersByTimeAsync(ms); } };
}
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded authenticated telemetry queue", () => {
  it("does not collect before authenticated init succeeds and carries the exact nonce-bound proof", async () => {
    const init = deferred<Response>();
    const f = fixture({ init: async () => init.promise });
    expect(f.client.beginAction()).toBeNull();
    await f.client.flush();
    expect(f.fetch).not.toHaveBeenCalled();
    const pending = f.client.setIdentity("actor-A");
    expect(f.client.beginAction()).toBeNull();
    const request = JSON.parse(String(f.fetch.mock.calls[0][1]?.body)) as Init;
    expect(request).toEqual({ kind: "session.start", sessionId: expect.any(String) });
    init.resolve(initOk(request));
    await pending;
    const action = f.client.beginAction()!;
    f.client.finishAction(action, { outcome: "success", durationMs: 12 });
    f.client.finishAction(action, { outcome: "failure", durationMs: 99 });
    await f.client.flush();
    expect(f.batches()).toHaveLength(1);
    expect(f.batches()[0]).toMatchObject({ sessionId: request.sessionId, sessionToken: PROOF });
    expect(f.batches()[0].events.map(event => event.event)).toEqual(["ui.action", "client.request.result"]);
    expect(f.batches()[0].events.every(event => event.actionId === action.actionId)).toBe(true);
    expect(JSON.stringify(f.batches()[0].events)).not.toContain(PROOF);
  });

  it.each(["wrong-session", "bad-proof", "expired"])("refuses an init response with %s", async mode => {
    const f = fixture({ init: async input => Response.json({ success: true, data: {
      sessionId: mode === "wrong-session" ? "ffffffff-1111-4111-8111-111111111111" : input.sessionId,
      sessionToken: mode === "bad-proof" ? "synthetic-invalid-proof" : PROOF,
      expiresAt: mode === "expired" ? WALL.toISOString() : EXPIRY,
    } }) });
    await f.client.setIdentity("actor-A");
    expect(f.client.beginAction()).toBeNull();
  });

  it("a failed 503 init stays disabled without an automatic init/retry loop", async () => {
    const f = fixture({ init: async () => new Response(null, { status: 503 }) });
    await f.client.setIdentity("actor-A");
    await f.advance(600_000);
    await f.client.setIdentity("actor-A");
    expect(f.client.beginAction()).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("automatically flushes and permits only one batch request at a time", async () => {
    const delivery = deferred<Response>();
    const f = fixture({ batch: async () => delivery.promise });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    await f.advance(0);
    expect(f.batches()).toHaveLength(1);
    const one = f.client.flush();
    const two = f.client.flush();
    expect(f.batches()).toHaveLength(1);
    delivery.resolve(ack(f.batches()[0]));
    await Promise.all([one, two]);
    await f.client.flush();
    expect(f.batches()).toHaveLength(1);
  });

  it("drops the oldest beyond 100 and stays under 64KiB, with batches limited to 10 and 8KiB", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    for (let i = 0; i < 150; i++) expect(f.client.beginAction()).not.toBeNull();
    for (let i = 0; i < 12; i++) await f.client.flush();
    const batches = f.batches();
    expect(batches).toHaveLength(10);
    const events = batches.flatMap(batch => batch.events);
    expect(events).toHaveLength(100);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 51));
    expect(batches.every(batch => batch.events.length <= 10 && new TextEncoder().encode(JSON.stringify(batch)).length <= 8192)).toBe(true);
    expect(events.reduce((bytes, event) => bytes + new TextEncoder().encode(JSON.stringify(event)).length, 0)).toBeLessThanOrEqual(65536);
    // Closed event sizes make the count cap stricter than the byte cap here.
  });

  it("uses enqueue monotonic age with a strict five-minute TTL, independent of occurredAt", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    f.now(300_000);
    f.wall(new Date("2026-10-20T12:00:00.001Z"));
    await f.client.flush();
    expect(f.batches()).toHaveLength(0);
    f.client.beginAction();
    f.now(599_999);
    await f.client.flush();
    expect(f.batches()[0].events).toHaveLength(1);
  });

  it.each(["network", "429", "503"])("caps %s attempts at three with bounded retries", async mode => {
    const f = fixture({ batch: async () => {
      if (mode === "network") throw new TypeError("synthetic-private-network");
      return new Response(null, { status: Number(mode), headers: { "Retry-After": "999999" } });
    } });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    await f.client.flush();
    await f.advance(mode === "network" ? 1000 : 30_000);
    expect(f.batches()).toHaveLength(2);
    await f.advance(mode === "network" ? 2000 : 30_000);
    expect(f.batches()).toHaveLength(3);
    await f.advance(600_000);
    expect(f.batches()).toHaveLength(3);
    expect(f.batches().every(batch => batch.events[0].eventId === f.batches()[0].events[0].eventId)).toBe(true);
  });

  it("a 503 TELEMETRY_UNAVAILABLE batch is expected, so collection stops for the session", async () => {
    const f = fixture({ batch: async () => Response.json(
      { success: false, error: { code: "TELEMETRY_UNAVAILABLE", message: "Telemetry unavailable" } },
      { status: 503 },
    ) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    await f.client.flush();
    await f.advance(600_000);
    expect(f.batches()).toHaveLength(1);
    expect(f.client.beginAction()).toBeNull();
    expect(isTelemetryDisabledForSession()).toBe(true);
  });

  it("drops a retry at the remaining TTL boundary instead of delivering expired events", async () => {
    const f = fixture({ batch: async () => new Response(null, { status: 429, headers: { "Retry-After": "30" } }) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    f.now(299_000);
    await f.client.flush();
    await f.advance(1000);
    expect(f.batches()).toHaveLength(1);
  });

  it.each([400, 403, 422])("never retries terminal HTTP %i", async status => {
    const f = fixture({ batch: async () => new Response(null, { status }) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    await f.client.flush();
    await f.advance(600_000);
    expect(f.batches()).toHaveLength(1);
  });

  it("401 clears and pauses until a fresh authentication boundary", async () => {
    const f = fixture({ batch: async () => new Response(null, { status: 401 }) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    await f.client.flush();
    expect(f.client.beginAction()).toBeNull();
    await f.advance(600_000);
    await f.client.setIdentity("actor-A");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await f.client.setIdentity(null);
    await f.client.setIdentity("actor-A");
    expect(f.client.beginAction()).not.toBeNull();
  });

  it("only removes acknowledged IDs from the sent batch, retrying unacknowledged events", async () => {
    let attempts = 0;
    const f = fixture({ batch: async input => {
      if (++attempts === 1) return Response.json({ success: true, data: { accepted: [input.events[0].eventId, input.events[0].eventId, "ffffffff-1111-4111-8111-111111111111"] } });
      return ack(input);
    } });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    f.client.beginAction();
    await f.client.flush();
    await f.advance(1000);
    expect(f.batches()).toHaveLength(2);
    expect(f.batches()[1].events.map(event => event.eventId)).toEqual([f.batches()[0].events[1].eventId]);
  });

  it("does not acknowledge a newly queued event that was absent from the in-flight batch", async () => {
    const response = deferred<Response>();
    let count = 0;
    const f = fixture({ batch: async input => ++count === 1 ? response.promise : ack(input) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    const pending = f.client.flush();
    f.client.beginAction();
    const newerEventId = f.uuid.mock.results.at(-1)!.value;
    response.resolve(Response.json({ success: true, data: { accepted: [f.batches()[0].events[0].eventId, newerEventId] } }));
    await pending;
    await f.client.flush();
    expect(f.batches()[1].events.map(event => event.eventId)).toEqual([newerEventId]);
  });

  it("ignores late session-init JSON from A after logout/login B", async () => {
    const json = deferred<unknown>();
    let count = 0;
    const f = fixture({ init: async input => ++count === 1
      ? Object.assign(new Response(null), { json: () => json.promise })
      : initOk(input) });
    const oldInit = f.client.setIdentity("actor-A");
    await Promise.resolve();
    await f.client.setIdentity(null);
    await f.client.setIdentity("actor-B");
    const bSession = (JSON.parse(String(f.fetch.mock.calls[1][1]?.body)) as Init).sessionId;
    json.resolve({ success: true, data: { sessionId: (JSON.parse(String(f.fetch.mock.calls[0][1]?.body)) as Init).sessionId, sessionToken: PROOF, expiresAt: EXPIRY } });
    await oldInit;
    expect(f.client.beginAction()?.sessionId).toBe(bSession);
    await f.client.flush();
    expect(f.batches().every(batch => batch.sessionId === bSession)).toBe(true);
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("an old flight's finally cannot unlock B's new in-flight request", async () => {
    const old = deferred<Response>();
    const fresh = deferred<Response>();
    let attempts = 0;
    const f = fixture({ batch: async () => ++attempts === 1 ? old.promise : fresh.promise });
    await f.client.setIdentity("actor-A");
    const oldAction = f.client.beginAction()!;
    const oldFlight = f.client.flush();
    const oldSignal = f.fetch.mock.calls[1][1]?.signal;
    await f.client.setIdentity(null);
    await f.client.setIdentity("actor-B");
    const newAction = f.client.beginAction()!;
    const newFlight = f.client.flush();
    f.client.finishAction(oldAction, { outcome: "success", durationMs: 1 });
    old.resolve(ack(f.batches()[0]));
    await oldFlight;
    const sameFlight = f.client.flush();
    expect(f.batches()).toHaveLength(2);
    expect(oldSignal?.aborted).toBe(true);
    expect(f.batches()[1].events.every(event => event.sessionId === newAction.sessionId)).toBe(true);
    fresh.resolve(ack(f.batches()[1]));
    await Promise.all([newFlight, sameFlight]);
  });

  it("a delayed old ACK JSON cannot acknowledge or retry events from B", async () => {
    const json = deferred<unknown>();
    let count = 0;
    const f = fixture({ batch: async input => ++count === 1
      ? Object.assign(new Response(null), { json: () => json.promise })
      : ack(input) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    const oldFlight = f.client.flush();
    await Promise.resolve();
    await f.client.setIdentity(null);
    await f.client.setIdentity("actor-B");
    const fresh = f.client.beginAction()!;
    json.resolve({ success: true, data: { accepted: [] } });
    await oldFlight;
    await f.client.flush();
    expect(f.batches()).toHaveLength(2);
    expect(f.batches()[1].events[0].sessionId).toBe(fresh.sessionId);
    expect(f.batches()[1].events).toHaveLength(1);
  });

  it("keeps the delivery timeout active while waiting for a stalled ACK response body", async () => {
    const json = deferred<unknown>();
    const entered = deferred<void>();
    const f = fixture({ batch: async () => Object.assign(new Response(null), { json: () => {
      entered.resolve();
      return json.promise;
    } }) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    const flight = f.client.flush();
    await entered.promise;
    const deliverySignal = f.fetch.mock.calls[1][1]?.signal;
    await f.advance(5000);
    const wasAborted = deliverySignal?.aborted;
    json.resolve({ success: true, data: { accepted: f.batches()[0].events.map(event => event.eventId) } });
    await flight;
    expect(wasAborted).toBe(true);
  });

  it("settles a never-ending ACK body at five seconds and retries without a permanently busy flight", async () => {
    let attempts = 0;
    const f = fixture({ batch: async input => ++attempts === 1
      ? Object.assign(new Response(null), { json: () => new Promise<never>(() => {}) })
      : ack(input) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction();
    let settled = false;
    const flight = f.client.flush().then(() => { settled = true; });
    await f.advance(4999);
    expect(settled).toBe(false);
    await f.advance(1);
    expect(settled).toBe(true);
    await flight;
    expect(f.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await f.advance(1000);
    expect(f.batches()).toHaveLength(2);
    expect(f.batches()[1].events[0].eventId).toBe(f.batches()[0].events[0].eventId);
    await f.client.flush();
    expect(f.batches()).toHaveLength(2);
  });

  it("settles session init even when the fetch adapter ignores AbortSignal forever", async () => {
    const f = fixture({ init: async () => new Promise<never>(() => {}) });
    let settled = false;
    const init = f.client.setIdentity("actor-A").then(() => { settled = true; });
    await f.advance(5000);
    expect(settled).toBe(true);
    await init;
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(f.client.beginAction()).toBeNull();
    await f.advance(300_000);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("is safe for malformed callback inputs, invalid UUID generation and dispose", async () => {
    const invalid = fixture({ uuid: () => "invalid-private-id" });
    await invalid.client.setIdentity("actor-A");
    expect(invalid.fetch).not.toHaveBeenCalled();
    const f = fixture();
    await f.client.setIdentity("actor-A");
    const token = f.client.beginAction()!;
    const hostile = new Proxy({}, { get() { throw new Error("synthetic getter failure"); } });
    expect(() => f.client.finishAction(token, hostile as Parameters<TelemetryClient["finishAction"]>[1])).not.toThrow();
    f.client.dispose();
    expect(f.client.beginAction()).toBeNull();
    await f.advance(600_000);
    expect(f.batches()).toHaveLength(0);
  });

  it("does not construct or fetch the browser singleton during SSR", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(getBrowserTelemetryClient()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("#55 cancellation and the path to an error", () => {
  it.each(["task.checklist.toggle", "task.create", "task.update", "task.move", "comment.create", "attachment.upload"] as const)("starts a diagnostic path directly from %s", async action => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    const token = f.client.beginAction(action)!;
    f.client.finishAction(token, { outcome: "failure", durationMs: 2, statusCode: 503 });
    await f.client.flush();
    const events = f.batches().flatMap(batch => batch.events);
    const crumbs = events.filter(event => event.event === "client.breadcrumb");
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toMatchObject({ kind: "operation", name: action });
    expect(crumbs[1]).toMatchObject({ kind: "request", outcome: "failure", errorCode: "HTTP_5XX" });
    expect(events.every(event => event.traceId === token.actionId.replace(/-/g, ""))).toBe(true);
  });

  it("records delivery retries only when sent, without recursively enqueueing them", async () => {
    const f = fixture({ batch: async () => new Response(null, { status: 503 }) });
    await f.client.setIdentity("actor-A");
    f.client.beginAction("task.create");
    await f.client.flush();
    expect(f.client.getBreadcrumbSnapshot().filter(crumb => crumb.kind === "retry")).toEqual([]);
    await f.advance(1000);
    await f.advance(2000);
    const retries = f.client.getBreadcrumbSnapshot().filter(crumb => crumb.kind === "retry");
    expect(retries.map(crumb => [crumb.name, crumb.attempt])).toEqual([["telemetry.batch", 2], ["telemetry.batch", 3]]);
    await f.advance(30_000);
    expect(f.batches()).toHaveLength(3);
    expect(f.batches().every(batch => batch.events.length === 1 && batch.events[0].event === "ui.action")).toBe(true);
    await f.client.setIdentity("actor-B");
    expect(f.client.getBreadcrumbSnapshot()).toEqual([]);
  });

  it.each([
    ["AbortError", Object.assign(new Error("synthetic-private-abort"), { name: "AbortError" })],
    ["DOMException AbortError", new DOMException("synthetic-private-abort", "AbortError")],
    ["ABORT_ERR code", Object.assign(new Error("synthetic-private-abort"), { code: "ABORT_ERR" })],
  ])("recognises %s as a cancellation", (_label, error) => {
    expect(isCancellationError(error)).toBe(true);
  });

  it.each([
    ["timeout", Object.assign(new Error("synthetic-private-timeout"), { name: "TimeoutError" })],
    ["network", new TypeError("synthetic-private-network")],
    ["plain error", new Error("synthetic-private")],
    ["numeric code outside DOMException", Object.assign(new Error("synthetic-private"), { code: 20 })],
    ["non-error", "synthetic-private"],
    ["null", null],
  ])("does not treat %s as a cancellation", (_label, error) => {
    expect(isCancellationError(error)).toBe(false);
  });

  it("does not throw on a hostile thrown value", () => {
    const hostile = new Proxy({}, { get() { throw new Error("synthetic-private-getter"); } });
    expect(() => isCancellationError(hostile)).not.toThrow();
    expect(isCancellationError(hostile)).toBe(false);
  });

  it("flushes a screen → operation → failed request path in order", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    expect(f.client.recordScreen("board")).toBe(true);
    const token = f.client.beginAction("task.update")!;
    f.client.finishAction(token, { outcome: "failure", durationMs: 7, statusCode: 500 });
    await f.client.flush();

    const events = f.batches().flatMap(batch => batch.events);
    const crumbs = events.filter(event => event.event === "client.breadcrumb");
    const result = events.find(event => event.event === "client.request.result");
    expect(crumbs.map(crumb => [crumb.kind, crumb.name])).toEqual([
      ["navigation", "board"],
      ["operation", "task.update"],
      ["request", "/api/tasks/:id"],
    ]);
    expect(result).toMatchObject({ actionId: token.actionId, outcome: "failure", statusCode: 500, errorCode: "HTTP_5XX" });
    expect(crumbs.every(crumb => crumb.actionId === token.actionId)).toBe(true);
    expect(crumbs.every(crumb => crumb.seq < result!.seq)).toBe(true);
    expect(crumbs.at(-1)).toMatchObject({ outcome: "failure", statusCode: 500, errorCode: "HTTP_5XX" });
    expect(JSON.stringify(events)).not.toMatch(/synthetic-private|task-title/i);
  });

  it.each([
    ["view", (client: TelemetryClient) => client.recordViewChange("calendar"), "board.view.change"],
    ["filter", (client: TelemetryClient) => client.recordFilterChange("assignee"), "board.filter.change"],
    ["search", (client: TelemetryClient) => client.recordSearch(), "board.search"],
  ])("starts the path from a %s intent", async (_label, record, name) => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    expect(record(f.client)).toBe(true);
    const token = f.client.beginAction("task.move")!;
    f.client.finishAction(token, { outcome: "failure", durationMs: 1, statusCode: 503 });
    await f.client.flush();
    const crumbs = f.batches().flatMap(batch => batch.events).filter(event => event.event === "client.breadcrumb");
    expect(crumbs.map(crumb => [crumb.kind, crumb.name])).toEqual([
      ["operation", name],
      ["operation", "task.move"],
      ["request", "/api/tasks/:id/move"],
    ]);
  });

  it("records the task card as a dialog when it is the current screen", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    expect(f.client.recordScreen("task.detail")).toBe(true);
    const token = f.client.beginAction("comment.create")!;
    f.client.finishAction(token, { outcome: "rejected", durationMs: 3, statusCode: 422 });
    await f.client.flush();
    const crumbs = f.batches().flatMap(batch => batch.events).filter(event => event.event === "client.breadcrumb");
    expect(crumbs.map(crumb => [crumb.kind, crumb.name])).toEqual([
      ["dialog", "task.detail"],
      ["operation", "comment.create"],
      ["request", "/api/tasks/:id/messages"],
    ]);
  });

  it("labels an aborted request as cancelled with ABORT, not as a failure", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    expect(f.client.recordScreen("board")).toBe(true);
    const token = f.client.beginAction("task.update")!;
    f.client.finishAction(token, { outcome: "cancelled", durationMs: 2 });
    await f.client.flush();
    const events = f.batches().flatMap(batch => batch.events);
    const result = events.find(event => event.event === "client.request.result");
    expect(result).toMatchObject({ outcome: "cancelled", errorCode: "ABORT" });
    expect(result).not.toHaveProperty("statusCode");
    const request = events.find(event => event.event === "client.breadcrumb" && event.kind === "request");
    expect(request).toMatchObject({ outcome: "cancelled", errorCode: "ABORT" });
  });
});
