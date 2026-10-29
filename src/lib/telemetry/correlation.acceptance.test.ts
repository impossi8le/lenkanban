import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #58 acceptance: one UI action is traceable through the HTTP boundary
 * into a server error record, while concurrent users, logout, forged headers
 * and failed writes never blur that chain.
 *
 * All transports are local stubs. Prisma and the Pino sink are replaced; the
 * Sentry/collector modules are never contacted.
 */

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: logs.info, warn: logs.warn, error: logs.error } }));

const writer = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/telemetry/store", async importOriginal => {
  const actual = await importOriginal<typeof import("./store")>();
  return { ...actual, recordServerRequestTelemetry: writer.record };
});

const db = vi.hoisted(() => ({ telemetryEvent: { findMany: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { withApiLogging } from "@/middleware/api-logger";
import { createRequestLogContext } from "@/lib/request-context";
import { TelemetryClient } from "./client";
import { readTelemetryError } from "./reports";
import { telemetryActorKey } from "./store";
import { validCorrelationId } from "@/lib/telemetry-sanitize";
import { apiPatch, apiFetch } from "@/lib/api";
import type { TelemetryEvent } from "@prisma/client";
import type { TelemetryRequestResult } from "./client";

const ACTION = "c12bc345-6789-4abc-8def-012345678901";
const REQUEST = "e12bc345-6789-4abc-8def-012345678901";
const OTHER_REQUEST = "f12bc345-6789-4abc-8def-012345678901";
const ERROR_ID = "a22bc345-6789-4abc-8def-012345678901";
const WALL = new Date("2026-10-21T11:00:00.000Z");
const EXPIRY = new Date(WALL.getTime() + 24 * 60 * 60 * 1000).toISOString();
const PROOF = `v1.${Date.parse(EXPIRY)}.${"a".repeat(64)}`;
const ROUTE = "/api/tasks/:id/checklist/:itemId";

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-correlation-secret-32-chars-min");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "aBc1234");
  writer.record.mockResolvedValue(undefined);
  db.telemetryEvent.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(headers: Record<string, string> = {}, url = "https://app.invalid/api/tasks/real-id/checklist/item-1?token=synthetic-private-query") {
  return new NextRequest(url, { headers });
}

/** The server writer is scheduled through a dynamic import; let it settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe("#58 HTTP boundary records the actual outcome with matching IDs", () => {
  it.each([200, 409, 500])("collects the existing task command route at status %s with an action-derived trace", async status => {
    const response = await withApiLogging(request({
      "X-Action-Id": ACTION.toUpperCase(),
      "X-Trace-Id": "synthetic-private-ignored",
      "X-Actor-Id": "synthetic-private-forged-actor",
    }), async (_, context) => {
      context.actorId = "verified-actor";
      return new Response("synthetic-private-response", { status });
    }, { route: "/api/tasks/:id" });
    await settle();
    expect(writer.record).toHaveBeenCalledOnce();
    expect(writer.record.mock.calls[0][0]).toMatchObject({
      route: "/api/tasks/:id", actorId: "verified-actor", statusCode: status,
      traceId: ACTION.replace(/-/g, ""), requestId: response.headers.get("X-Request-Id"),
    });
    expect(JSON.stringify(writer.record.mock.calls)).not.toContain("synthetic-private");
    expect(writer.record.mock.calls[0][0]).not.toHaveProperty("trust");
    expect(await response.text()).toBe("synthetic-private-response");
  });

  it.each([
    [200, "success"],
    [400, "rejected"],
    [401, "rejected"],
    [403, "rejected"],
    [409, "conflict"],
    [500, "failure"],
    [503, "failure"],
  ] as const)("records returned status %i as %s exactly once", async (status, outcome) => {
    let contextRequestId: string | undefined;
    const response = await withApiLogging(request({ "X-Action-Id": ACTION }), async (_, context) => {
      contextRequestId = context.requestId;
      return new Response("business result", { status });
    }, { route: ROUTE, actorId: "actor-A" });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("business result");
    expect(validCorrelationId(contextRequestId)).toBe(true);
    expect(response.headers.get("X-Request-Id")).toBe(contextRequestId);

    const sink = status >= 500 ? logs.error : status >= 400 ? logs.warn : logs.info;
    expect(sink).toHaveBeenCalledOnce();
    const record = sink.mock.calls[0][0];
    expect(record).toMatchObject({ requestId: contextRequestId, actionId: ACTION, route: ROUTE, actorId: "actor-A", statusCode: status, outcome });
    expect(record.durationMs).toBeGreaterThanOrEqual(0);

    if (status >= 400) {
      const errorId = response.headers.get("X-Error-Id");
      expect(validCorrelationId(errorId)).toBe(true);
      expect(record.errorId).toBe(errorId);
    } else {
      expect(response.headers.has("X-Error-Id")).toBe(false);
      expect(record).not.toHaveProperty("errorId");
    }
    // The server writer receives the same identifiers as the response.
    await settle();
    expect(writer.record).toHaveBeenCalledOnce();
    expect(writer.record.mock.calls[0][0]).toMatchObject({ requestId: contextRequestId, actionId: ACTION, statusCode: status, route: ROUTE });
  });

  it("logs a thrown exception once, rethrows the original value and never reports success", async () => {
    const original = Object.assign(new Error("synthetic-private-message"), { code: "PRIVATE_CODE" });
    await expect(withApiLogging(request({ "X-Action-Id": ACTION }), async () => { throw original; },
      { route: ROUTE, actorId: "actor-A" })).rejects.toBe(original);
    expect(logs.error).toHaveBeenCalledOnce();
    expect(logs.info).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
    const record = logs.error.mock.calls[0][0];
    expect(record).toMatchObject({ event: "api.request.failed", outcome: "failure", statusCode: 500, actionId: ACTION });
    expect(validCorrelationId(record.errorId)).toBe(true);
    await settle();
    expect(writer.record.mock.calls[0][0]).toMatchObject({ event: "api.request.failed", errorId: record.errorId, statusCode: 500 });
    // The wrapper passes the original error to the shared logger; redaction is
    // the logger's boundary (covered in redaction.acceptance.test.ts).
    expect(record).not.toHaveProperty("url");
    expect(record).not.toHaveProperty("body");
    expect(JSON.stringify(record)).not.toContain("token=synthetic-private-query");
  });

  it("keeps route template, status, duration and release but no URL, query, cookie or body", async () => {
    const response = await withApiLogging(
      request({ "X-Action-Id": ACTION, Cookie: "session=synthetic-private-cookie", Authorization: "Bearer synthetic-private-bearer" }),
      async () => new Response(JSON.stringify({ text: "synthetic-private-task-text" }), {
        status: 500,
        headers: { "Set-Cookie": "session=synthetic-private-cookie" },
      }),
      { route: ROUTE, actorId: "actor-A" },
    );
    expect(response.status).toBe(500);
    const record = logs.error.mock.calls[0][0];
    expect(record.route).toBe(ROUTE);
    expect(record).not.toHaveProperty("url");
    expect(JSON.stringify(record)).not.toMatch(/synthetic-private|token=|real-id|item-1|session=/);
  });
});

describe("#58 correlation headers cannot substitute the actor or inject log content", () => {
  it.each([
    ["non-UUID", "not-a-uuid"],
    ["zero UUID", "00000000-0000-0000-0000-000000000000"],
    ["oversized", "a".repeat(4096)],
    ["JSON injection", `{"actorId":"forged","event":"task.checklist.updated"}`],
  ])("drops the %s X-Action-Id without logging its raw value", async (_label, header) => {
    await withApiLogging(request({ "X-Action-Id": header }), async () => new Response(null, { status: 200 }),
      { route: ROUTE, actorId: "actor-A" });
    const record = logs.info.mock.calls[0][0];
    expect(record).not.toHaveProperty("actionId");
    expect(record.actorId).toBe("actor-A");
    expect(JSON.stringify(record)).not.toContain(header);
    expect(JSON.stringify(record)).not.toContain("forged");
  });

  it.each([
    ["multiline", `${ACTION}\n{"actorId":"forged"}`],
    ["control characters", `${ACTION}\u0000\u001b[31m`],
    ["whitespace padded", ` ${ACTION} `],
    ["CRLF", `${ACTION}\r\nX-Actor-Id: forged`],
  ])("rejects a raw %s header value before it can become a log field", (_label, header) => {
    // Real Headers trim/reject these, so the boundary is exercised directly.
    const context = createRequestLogContext({ get: () => header }, { route: ROUTE, actorId: "actor-A" });
    expect(context).not.toHaveProperty("actionId");
    expect(context.actorId).toBe("actor-A");
    expect(validCorrelationId(context.requestId)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("forged");
  });

  it("ignores forged actor, request and error headers from the client", async () => {
    const forged = "b22bc345-6789-4abc-8def-012345678901";
    const response = await withApiLogging(
      request({ "X-Action-Id": ACTION, "X-Actor-Id": "forged-actor", "X-Request-Id": forged, "X-Error-Id": forged }),
      async () => new Response(null, { status: 403 }),
      { route: ROUTE, actorId: "actor-A" },
    );
    const record = logs.warn.mock.calls[0][0];
    expect(record.actorId).toBe("actor-A");
    expect(record.requestId).not.toBe(forged);
    expect(record.errorId).not.toBe(forged);
    expect(response.headers.get("X-Request-Id")).not.toBe(forged);
    expect(response.headers.get("X-Error-Id")).not.toBe(forged);
  });

  it("derives requestId per attempt while one actionId spans a network retry", async () => {
    const attempts: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await withApiLogging(request({ "X-Action-Id": ACTION }), async (_, context) => {
        attempts.push(context.requestId);
        return new Response(null, { status: 503 });
      }, { route: ROUTE, actorId: "actor-A" });
    }
    expect(new Set(attempts).size).toBe(2);
    const records = logs.error.mock.calls.map(([record]) => record);
    expect(records.map(record => record.actionId)).toEqual([ACTION, ACTION]);
    expect(records.map(record => record.requestId)).toEqual(attempts);
    expect(new Set(records.map(record => record.errorId)).size).toBe(2);
  });
});

describe("#58 concurrent users and logout keep separate contexts", () => {
  it("does not mix two overlapping server requests of different actors", async () => {
    const release: Array<() => void> = [];
    const pending = ["actor-A", "actor-B"].map(actorId => withApiLogging(
      request({ "X-Action-Id": ACTION }), async () => {
        await new Promise<void>(resolve => { release.push(resolve); });
        return new Response(null, { status: 500 });
      }, { route: ROUTE, actorId },
    ));
    // Both handlers are now suspended on their own promise.
    expect(release).toHaveLength(2);
    release.forEach(resolve => resolve());
    const responses = await Promise.all(pending);
    const records = logs.error.mock.calls.map(([record]) => record);
    expect(records.map(record => record.actorId).sort()).toEqual(["actor-A", "actor-B"]);
    expect(records[0].requestId).not.toBe(records[1].requestId);
    expect(records[0].errorId).not.toBe(records[1].errorId);
    expect(responses.map(response => response.headers.get("X-Request-Id")).sort())
      .toEqual(records.map(record => record.requestId).sort());
    // The best-effort writer is an asynchronous duplicate of the same context;
    // whatever it receives must carry one actor only, never a merged pair.
    await settle();
    for (const [input] of writer.record.mock.calls) {
      expect(["actor-A", "actor-B"]).toContain(input.actorId);
      expect(input).not.toHaveProperty("actorIds");
    }
    const pairs = records.map(record => `${record.actorId}|${record.requestId}|${record.errorId}`);
    expect(new Set(pairs).size).toBe(2);
  });

  function clientFixture(prefix = 0) {
    let mono = 0;
    let id = prefix;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { kind?: string; sessionId: string; events?: Array<{ eventId: string }> };
      if (body.kind === "session.start") {
        return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: EXPIRY } });
      }
      return Response.json({ success: true, data: { accepted: body.events!.map(event => event.eventId) } });
    });
    const client = new TelemetryClient({
      fetch, clock: () => mono, wallClock: () => WALL,
      uuid: () => `${(++id).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
    });
    const batches = () => fetch.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)) as { kind?: string; sessionId: string; events?: Array<Record<string, unknown>> })
      .filter(body => !body.kind);
    return { client, fetch, batches, advance: async (ms: number) => { mono += ms; await vi.advanceTimersByTimeAsync(ms); } };
  }

  it("keeps two concurrent users in separate sessions with separate events", async () => {
    const a = clientFixture();
    const b = clientFixture(100);
    await a.client.setIdentity("actor-A");
    await b.client.setIdentity("actor-B");
    const actionA = a.client.beginAction()!;
    const actionB = b.client.beginAction()!;
    expect(actionA.sessionId).not.toBe(actionB.sessionId);
    a.client.finishAction(actionA, { outcome: "failure", durationMs: 3, statusCode: 500 });
    b.client.finishAction(actionB, { outcome: "success", durationMs: 4, statusCode: 200 });
    await a.client.flush();
    await b.client.flush();
    const eventsA = a.batches().flatMap(batch => batch.events!);
    const eventsB = b.batches().flatMap(batch => batch.events!);
    expect(eventsA.every(event => event.sessionId === actionA.sessionId)).toBe(true);
    expect(eventsB.every(event => event.sessionId === actionB.sessionId)).toBe(true);
    expect(eventsA.every(event => event.actionId === actionA.actionId)).toBe(true);
    expect(eventsB.every(event => event.actionId === actionB.actionId)).toBe(true);
    expect(eventsA.find(event => event.event === "client.request.result")).toMatchObject({ outcome: "failure", statusCode: 500 });
    expect(eventsB.find(event => event.event === "client.request.result")).toMatchObject({ outcome: "success", statusCode: 200 });
    a.client.dispose(); b.client.dispose();
  });

  it("logout clears the pending queue and the session before a new user starts", async () => {
    const f = clientFixture();
    await f.client.setIdentity("actor-A");
    const actionA = f.client.beginAction()!;
    expect(actionA).toBeTruthy();
    await f.client.setIdentity(null);
    // Nothing from A is delivered after logout.
    await f.client.flush();
    expect(f.batches()).toHaveLength(0);
    expect(f.client.beginAction()).toBeNull();
    await f.client.setIdentity("actor-B");
    const actionB = f.client.beginAction()!;
    expect(actionB.sessionId).not.toBe(actionA.sessionId);
    expect(actionB.actionId).not.toBe(actionA.actionId);
    await f.client.flush();
    const events = f.batches().flatMap(batch => batch.events!);
    expect(events.every(event => event.sessionId === actionB.sessionId)).toBe(true);
    expect(events.some(event => event.actionId === actionA.actionId)).toBe(false);
    f.client.dispose();
  });
});

describe("#58 UI action → API result → server error chain", () => {
  it("links one actionId, a per-attempt requestId and the server errorId", async () => {
    const f = (() => {
      let id = 0;
      const bodies: Array<Record<string, unknown>> = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { kind?: string; sessionId: string; events?: Array<{ eventId: string }> };
        bodies.push(body);
        if (body.kind === "session.start") {
          return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: EXPIRY } });
        }
        return Response.json({ success: true, data: { accepted: body.events!.map(event => event.eventId) } });
      });
      const client = new TelemetryClient({ fetch, clock: () => 0, wallClock: () => WALL,
        uuid: () => `${(++id).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
      return { client, fetch, bodies, batches: () => bodies.filter(body => !body.kind) };
    })();
    await f.client.setIdentity("actor-A");
    const action = f.client.beginAction()!;

    // The API call reuses the intent's actionId and reports the observed result.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "synthetic-private" } }), {
      status: 500,
      headers: { "X-Request-Id": REQUEST.toUpperCase(), "X-Error-Id": ERROR_ID.toUpperCase() },
    })));
    await expect(apiPatch("/api/tasks/1/checklist/2", { completed: true }, {
      actionId: action.actionId,
      onResult: result => f.client.finishAction(action, result),
    })).rejects.toMatchObject({ status: 500, requestId: REQUEST, errorId: ERROR_ID });

    await f.client.flush();
    const events = f.batches().flatMap(batch => batch.events as Array<Record<string, unknown>>);
    expect(events).toHaveLength(4);
    const intent = events.find(event => event.event === "ui.action")!;
    const result = events.find(event => event.event === "client.request.result")!;
    expect(intent.actionId).toBe(action.actionId);
    expect(result).toMatchObject({ actionId: action.actionId, outcome: "failure", statusCode: 500, requestId: REQUEST, errorId: ERROR_ID });
    expect(intent.traceId).toBe(action.actionId.replace(/-/g, ""));
    expect(result.traceId).toBe(intent.traceId);
    expect(events.filter(event => event.event === "client.breadcrumb").map(event => event.kind)).toEqual(["operation", "request"]);
    expect(JSON.stringify(events)).not.toMatch(/synthetic-private|completed|payload|message/);

    // The server record uses the same request/action/error triple and remains
    // the only authority that can upgrade the client chain.
    const actorKey = telemetryActorKey("actor-A")!;
    const serverRow = {
      id: "server-1", actorKey, eventId: "b32bc345-6789-4abc-8def-012345678901",
      receivedAt: WALL, occurredAt: WALL, event: "api.request.completed", category: "diagnostic",
      source: "server", trust: "server_observed", actionId: action.actionId, requestId: REQUEST,
      errorId: ERROR_ID, operationId: null, sessionId: null, projectId: null, taskId: null,
      payload: { schemaVersion: 1, route: ROUTE, method: "PATCH", statusCode: 500, durationMs: 8, outcome: "failure", errorCode: "HTTP_5XX" },
    } as TelemetryEvent;
    const clientResultRow = {
      id: "client-1", actorKey, eventId: result.eventId, receivedAt: WALL, occurredAt: WALL,
      event: "client.request.result", category: "diagnostic", source: "client", trust: "client_reported",
      actionId: action.actionId, requestId: REQUEST, errorId: ERROR_ID, operationId: null,
      sessionId: action.sessionId, projectId: null, taskId: null,
      payload: { schemaVersion: 1, action: "task.checklist.toggle", seq: result.seq, outcome: "failure", durationMs: result.durationMs, statusCode: 500 },
    } as TelemetryEvent;
    db.telemetryEvent.findMany
      .mockResolvedValueOnce([clientResultRow])
      .mockResolvedValueOnce([serverRow])
      .mockResolvedValueOnce([serverRow, clientResultRow])
      .mockResolvedValueOnce([]);
    const detail = await readTelemetryError(ERROR_ID, {}, WALL);
    expect(detail?.linkage).toBe("server_verified");
    expect(detail?.errorId).toBe(ERROR_ID);
    expect(detail?.events.map(event => event.requestId)).toEqual([REQUEST, REQUEST]);
    expect(detail?.events.map(event => event.actionId)).toEqual([action.actionId, action.actionId]);
    expect(JSON.stringify(detail)).not.toContain("synthetic-private");
    f.client.dispose();
  });

  it.each([
    [400, "rejected"],
    [401, "rejected"],
    [403, "rejected"],
    [409, "conflict"],
    [500, "failure"],
  ] as const)("reports HTTP %i as %s without inventing a server ID", async (status, outcome) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "synthetic-private" } }), { status })));
    const onResult = vi.fn();
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).rejects.toMatchObject({ status });
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0]).toEqual({ outcome, statusCode: status, durationMs: expect.any(Number) });
  });

  it.each([
    ["timeout", () => { throw Object.assign(new Error("synthetic-private-timeout"), { name: "TimeoutError" }); }, "failure"],
    ["network loss", () => { throw new TypeError("synthetic-private-network"); }, "failure"],
    ["abort", () => { throw Object.assign(new Error("synthetic-private-abort"), { name: "AbortError" }); }, "cancelled"],
  ] as const)("reports %s as %s with no request or error ID", async (_label, thrower, outcome) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw thrower(); }));
    const onResult = vi.fn();
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).rejects.toThrow();
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ outcome, durationMs: expect.any(Number) });
  });

  it("a retry keeps the actionId but receives a new server requestId", async () => {
    const results: TelemetryRequestResult[] = [];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "X-Request-Id": REQUEST } }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { saved: true } }, { headers: { "X-Request-Id": OTHER_REQUEST } })));
    const onResult = (result: TelemetryRequestResult) => { results.push(result); };
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).rejects.toMatchObject({ status: 503 });
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).resolves.toEqual({ saved: true });
    expect(results.map(result => result.requestId)).toEqual([REQUEST, OTHER_REQUEST]);
    expect(results.map(result => result.outcome)).toEqual(["failure", "success"]);
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("X-Action-Id")).toBe(ACTION);
    expect(new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers).get("X-Action-Id")).toBe(ACTION);
  });

  it("does not attach correlation headers to a foreign URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: {} })));
    const onResult = vi.fn();
    await apiFetch("https://foreign.invalid/api/tasks/1", undefined, { actionId: ACTION, onResult });
    expect(onResult).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0][1]).toBeUndefined();
  });

  it("never fabricates a success event when the server write is rejected", async () => {
    const writerModule = await import("@/lib/telemetry/store");
    expect(writerModule.recordServerRequestTelemetry).toBe(writer.record);
    writer.record.mockRejectedValueOnce(Error("synthetic-private-storage"));
    const response = await withApiLogging(request({ "X-Action-Id": ACTION }), async () => new Response(null, { status: 200 }),
      { route: ROUTE, actorId: "actor-A" });
    expect(response.status).toBe(200);
    expect(logs.info.mock.calls[0][0]).toMatchObject({ outcome: "success", statusCode: 200 });
    // The writer is best effort and cannot turn a 200 into a failure, but the
    // rejection is contained and no second success record is emitted.
    expect(logs.info).toHaveBeenCalledOnce();
    await settle();
    expect(writer.record).toHaveBeenCalledOnce();
  });
});
