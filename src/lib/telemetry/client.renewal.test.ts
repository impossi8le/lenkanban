import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient, type TelemetryAction } from "./client";

const BASE = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ERROR = "aaaaaaaa-1111-4111-8111-111111111111";
type Init = { kind: "session.start"; sessionId: string };
type Batch = { sessionId: string; sessionToken: string; events: { eventId: string; sessionId: string; seq: number; event: string }[] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function initOk(input: Init, now = BASE) {
  const expiry = now + DAY;
  return Response.json({ success: true, data: { sessionId: input.sessionId, expiresAt: new Date(expiry).toISOString(), sessionToken: `v1.${expiry}.${"a".repeat(64)}` } });
}
const ack = (batch: Batch) => Response.json({ success: true, data: { accepted: batch.events.map(event => event.eventId) } });
const clients: TelemetryClient[] = [];
function fixture(options: { init?: (input: Init, index: number, wall: number) => Promise<Response>; batch?: (input: Batch, index: number) => Promise<Response> } = {}) {
  let wall = BASE, id = 0, initCount = 0, batchCount = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, request) => {
    const body = JSON.parse(String(request?.body)) as Init | Batch;
    if ("kind" in body) return options.init ? options.init(body, ++initCount, wall) : initOk(body, wall);
    return options.batch ? options.batch(body, ++batchCount) : ack(body);
  });
  const client = new TelemetryClient({ fetch, wallClock: () => new Date(wall), clock: () => 0,
    uuid: () => `${(++id).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
  clients.push(client);
  const requests = () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Init | Batch);
  return { client, fetch, time: (value: number) => { wall = value; }, inits: () => requests().filter((body): body is Init => "kind" in body),
    batches: () => requests().filter((body): body is Batch => !("kind" in body)) };
}
const ready = async (client: TelemetryClient) => vi.waitFor(() => expect(client.getDiagnosticContext()).not.toContain("unready"));
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers(); });

describe("lazy bounded telemetry session rollover", () => {
  it.each([-1, 0, 1])("rolls at expiry offset %d and never before it", async offset => {
    const f = fixture(); await f.client.setIdentity("A"); f.time(BASE + DAY + offset);
    const action = f.client.beginAction();
    if (offset < 0) { expect(action).not.toBeNull(); expect(f.inits()).toHaveLength(1); }
    else { expect(action).toBeNull(); expect(f.inits()).toHaveLength(2); await ready(f.client); expect(f.client.beginAction()).not.toBeNull(); }
  });
  it("resets old queue/tokens/proof/seq with one nonblocking init across all entry points", async () => {
    const renewal = deferred<Response>();
    const f = fixture({ init: async (input, index, wall) => index === 1 ? initOk(input, wall) : renewal.promise });
    await f.client.setIdentity("A"); const old = f.client.beginAction()!; f.time(BASE + DAY);
    expect(f.client.beginAction()).toBeNull(); f.client.captureRenderFailure(ERROR);
    f.client.finishAction(old, { outcome: "success", durationMs: 1 }); await f.client.flush();
    expect(f.inits()).toHaveLength(2); expect(f.batches()).toHaveLength(0);
    const next = f.inits()[1]; expect(next.sessionId).not.toBe(old.sessionId);
    renewal.resolve(initOk(next, BASE + DAY)); await ready(f.client);
    f.client.finishAction(old, { outcome: "success", durationMs: 1 }); const current = f.client.beginAction()!; await f.client.flush();
    expect(current.generation).toBeGreaterThan(old.generation); expect(f.batches()).toHaveLength(1);
    expect(f.batches()[0].sessionId).toBe(next.sessionId); expect(f.batches()[0].events).toHaveLength(1); expect(f.batches()[0].events[0].seq).toBe(1);
    expect(f.batches()[0].sessionToken).toContain(String(BASE + 2 * DAY));
  });
  it.each(["render", "finish", "flush"])("lets current %s be the first lazy expiry trigger", async trigger => {
    const f = fixture(); await f.client.setIdentity("A"); const action = f.client.beginAction()!; f.time(BASE + DAY);
    if (trigger === "render") f.client.captureRenderFailure(ERROR);
    else if (trigger === "finish") f.client.finishAction(action, { outcome: "success", durationMs: 1 });
    else await f.client.flush();
    expect(f.inits()).toHaveLength(2); await ready(f.client); expect(f.batches()).toHaveLength(0);
  });
  it.each(["503", "429", "network", "invalid", "body-timeout"])("a failed %s renewal stays disabled past its former expiry", async failure => {
    const stalled = deferred<unknown>();
    const f = fixture({ init: async (input, index, wall) => {
      if (index === 1) return initOk(input, wall);
      if (failure === "network") throw new Error("offline");
      if (failure === "invalid") return Response.json({ success: true, data: { sessionId: input.sessionId } });
      if (failure === "body-timeout") return Object.assign(new Response(null), { json: () => stalled.promise });
      return new Response(null, { status: Number(failure) });
    } });
    await f.client.setIdentity("A"); const old = f.client.beginAction()!; f.time(BASE + DAY); f.client.captureRenderFailure(ERROR);
    await vi.advanceTimersByTimeAsync(5001); f.time(BASE + 3 * DAY);
    for (let index = 0; index < 3; index++) {
      expect(f.client.beginAction()).toBeNull(); f.client.finishAction(old, { outcome: "success", durationMs: 1 });
      f.client.captureRenderFailure(ERROR); await f.client.flush(); await f.client.setIdentity("A");
    }
    expect(f.inits()).toHaveLength(2); expect(f.batches()).toHaveLength(0);
  });
  it("a generic unexpired401 remains terminal even after its former expiry", async () => {
    const f = fixture({ batch: async () => new Response(null, { status: 401 }) });
    await f.client.setIdentity("A"); const old = f.client.beginAction()!; await f.client.flush(); f.time(BASE + 2 * DAY);
    expect(f.client.beginAction()).toBeNull(); f.client.captureRenderFailure(ERROR); f.client.finishAction(old, { outcome: "failure", durationMs: 1 });
    await f.client.flush(); await f.client.setIdentity("A"); expect(f.inits()).toHaveLength(1);
    await f.client.setIdentity(null); await f.client.setIdentity("A"); expect(f.inits()).toHaveLength(2); expect(f.client.beginAction()).not.toBeNull();
  });
  it("stale A finish cannot trigger renewal for an expired B session", async () => {
    const f = fixture(); await f.client.setIdentity("A"); const old = f.client.beginAction()!;
    await f.client.setIdentity(null); await f.client.setIdentity("B"); const before = f.client.getDiagnosticContext(); f.time(BASE + DAY);
    f.client.finishAction(old, { outcome: "success", durationMs: 1 });
    expect(f.inits()).toHaveLength(2); expect(f.client.getDiagnosticContext()).toBe(before);
    expect(f.client.beginAction()).toBeNull(); expect(f.inits()).toHaveLength(3);
  });
  it.each(["ack", "401", "error", "body"])("isolates old in-flight %s and finally from a newer same-user flight", async mode => {
    const old = deferred<Response>(); const oldBody = deferred<unknown>(); const current = deferred<Response>();
    const f = fixture({ batch: async (_input, index) => index === 1 ? old.promise : current.promise });
    await f.client.setIdentity("A"); f.client.beginAction(); const oldFlight = f.client.flush();
    if (mode === "body") { old.resolve(Object.assign(new Response(null), { json: () => oldBody.promise })); await Promise.resolve(); }
    f.time(BASE + DAY); await f.client.flush(); expect(f.inits()).toHaveLength(2); await ready(f.client);
    const fresh = f.client.beginAction()!; const freshFlight = f.client.flush();
    if (mode === "body") oldBody.resolve({ success: true, data: { accepted: [] } });
    else old.resolve(mode === "401" ? new Response(null, { status: 401 }) : mode === "error" ? new Response(null, { status: 500 }) : ack(f.batches()[0]));
    await oldFlight; const sameFlight = f.client.flush(); expect(f.batches()).toHaveLength(2);
    expect(f.batches()[1].sessionId).toBe(fresh.sessionId); expect(f.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    current.resolve(ack(f.batches()[1])); await Promise.all([freshFlight, sameFlight]);
  });
  it.each(["logout", "B", "dispose"])("rejects late renewal JSON after %s", async transition => {
    const body = deferred<unknown>(); let input!: Init;
    const f = fixture({ init: async (request, index, wall) => {
      if (index === 2) { input = request; return Object.assign(new Response(null), { json: () => body.promise }); }
      return initOk(request, wall);
    } });
    await f.client.setIdentity("A"); f.time(BASE + DAY); f.client.beginAction(); await Promise.resolve();
    if (transition === "dispose") f.client.dispose(); else await f.client.setIdentity(transition === "B" ? "B" : null);
    const context = f.client.getDiagnosticContext(); body.resolve(await initOk(input, BASE + DAY).json());
    await vi.advanceTimersByTimeAsync(1); expect(f.client.getDiagnosticContext()).toBe(context);
    const action = f.client.beginAction(); if (transition === "B") expect(action?.sessionId).toBe(f.inits()[2].sessionId); else expect(action).toBeNull();
  });
  it("invalid/throwing wall clock cannot throw or repeatedly initialize", async () => {
    let invalid = false, id = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, request) => initOk(JSON.parse(String(request?.body)) as Init));
    const client = new TelemetryClient({ fetch, wallClock: () => { if (invalid) throw new Error("clock"); return new Date(BASE); },
      uuid: () => `${(++id).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` }); clients.push(client);
    await client.setIdentity("A"); const token = client.beginAction() as TelemetryAction; invalid = true;
    expect(() => client.finishAction(token, { outcome: "success", durationMs: 1 })).not.toThrow();
    expect(client.beginAction()).toBeNull(); await client.flush(); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
