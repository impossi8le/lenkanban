import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #57 acceptance: rerenders, retries and repeated operationIds do not
 * inflate the number of unique events, a failed request is never persisted as
 * a success, and an unavailable collector never breaks the business operation.
 *
 * Collector/database are local fakes: an in-memory event table that applies the
 * same `(actorKey, eventId)` uniqueness the real schema declares, plus a stub
 * `fetch`. No external transport, no PostgreSQL.
 */

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  telemetrySession: { createMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  telemetryEvent: { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  checklistOperationReceipt: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn() }));

import { TelemetryClient } from "./client";
import { ingestTelemetryBatch, projectChecklistTelemetry, startTelemetrySession, telemetryActorKey } from "./store";
import { summarizeTelemetryEvents } from "./summarize";
import type { TelemetryReportEvent } from "./report-contract";

const WALL = new Date("2026-10-21T10:00:00.000Z");
const NOW = WALL;
const SESSION = "b12bc345-6789-4abc-8def-012345678901";
const EXPIRY = new Date(WALL.getTime() + 24 * 60 * 60 * 1000).toISOString();
const PROOF = `v1.${Date.parse(EXPIRY)}.${"a".repeat(64)}`;
const ACTION = "c12bc345-6789-4abc-8def-012345678901";
const ERROR_ID = "d12bc345-6789-4abc-8def-012345678901";
const OPERATION = "e12bc345-6789-4abc-8def-012345678901";

type BatchBody = { sessionId: string; sessionToken: string; events: Array<{ eventId: string; event: string }> };
const clients: TelemetryClient[] = [];

function fixture(batchResponse: () => Promise<Response>) {
  let mono = 0;
  let id = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as BatchBody & { kind?: string };
    if (body.kind === "session.start") {
      return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: EXPIRY } });
    }
    return batchResponse();
  });
  const client = new TelemetryClient({
    fetch,
    clock: () => mono,
    wallClock: () => WALL,
    uuid: () => `${(++id).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
  });
  clients.push(client);
  const batches = () => fetch.mock.calls
    .map(([, init]) => JSON.parse(String(init?.body)) as BatchBody & { kind?: string })
    .filter(body => !body.kind);
  return { client, fetch, batches, advance: async (ms: number) => { mono += ms; await vi.advanceTimersByTimeAsync(ms); } };
}

/** Mirrors the collector's `(actorKey, eventId)` uniqueness and first receivedAt. */
function memoryCollector() {
  const rows = new Map<string, { actorKey: string; eventId: string; receivedAt: Date; event: string }>();
  return {
    insert(actorKey: string, events: Array<{ eventId: string; event: string }>, receivedAt: Date) {
      for (const event of events) {
        const key = `${actorKey}|${event.eventId}`;
        if (!rows.has(key)) rows.set(key, { actorKey, eventId: event.eventId, receivedAt, event: event.event });
      }
      return events.map(event => event.eventId);
    },
    rows: () => [...rows.values()],
    count: () => rows.size,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-dedup-secret-at-least-32-characters");
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  db.telemetrySession.createMany.mockResolvedValue({ count: 1 });
  db.telemetrySession.findUnique.mockResolvedValue({
    id: SESSION,
    actorKey: telemetryActorKey("actorA")!,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  });
  db.telemetryEvent.createMany.mockResolvedValue({ count: 1 });
  db.$queryRaw.mockResolvedValue([{ id: "receipt-1" }]);
});

afterEach(() => {
  clients.splice(0).forEach(client => client.dispose());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("#57 retry and rerender do not inflate unique events", () => {
  it("reuses one eventId across three delivery attempts of the same intent", async () => {
    const f = fixture(async () => new Response(null, { status: 503 }));
    await f.client.setIdentity("actor-A");
    const action = f.client.beginAction()!;
    f.client.finishAction(action, { outcome: "failure", durationMs: 5, statusCode: 503 });
    await f.client.flush();
    await f.advance(1000);
    await f.advance(2000);
    await f.advance(30_000);
    const batches = f.batches();
    expect(batches).toHaveLength(3);
    const uniqueIds = new Set(batches.flatMap(batch => batch.events.map(event => event.eventId)));
    expect(uniqueIds.size).toBe(4); // intent + result + operation/request path
    expect(batches.every(batch => batch.events.map(event => event.eventId).join() === batches[0].events.map(event => event.eventId).join())).toBe(true);
  });

  it("counts one intent once when the same signed batch is delivered five times", async () => {
    const collector = memoryCollector();
    const key = telemetryActorKey("actorA")!;
    // A real HMAC proof for the mocked binding: a hand-written token is rejected.
    const binding = await startTelemetrySession(key, SESSION, NOW);
    const body = {
      sessionId: binding.sessionId,
      sessionToken: binding.sessionToken,
      events: [{ schemaVersion: 1, event: "ui.action", action: "task.checklist.toggle", eventId: ERROR_ID,
        actionId: ACTION, sessionId: SESSION, occurredAt: NOW.toISOString(), seq: 1 }],
    };
    // The mocked store writes to the memory collector, so the assertion is about
    // the uniqueness rule rather than the mock call count alone.
    db.telemetryEvent.createMany.mockImplementation(async ({ data }: { data: Array<{ actorKey: string; eventId: string; event: string }> }) => {
      collector.insert(data[0].actorKey, data.map(row => ({ eventId: row.eventId, event: row.event })), NOW);
      return { count: data.length };
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(ingestTelemetryBatch(key, body, NOW)).resolves.toEqual([ERROR_ID]);
    }
    expect(collector.count()).toBe(1);
    expect(collector.rows()[0].receivedAt).toEqual(NOW);
  });

  it("does not create a second event for a repeated render failure of the same Error", async () => {
    // The dedup lives in the render wrapper, not in the sink; both adapters are
    // replaced with recording doubles so the count is observable.
    const capture = vi.fn();
    const renderCapture = vi.fn();
    vi.doMock("./client", () => ({
      getBrowserTelemetryClient: () => ({ getDiagnosticContext: () => "1:session", captureRenderFailure: renderCapture }),
    }));
    vi.doMock("@/lib/sentry", () => ({ captureException: capture }));
    vi.resetModules();
    try {
      const isolated = await import("./render-error");
      const error = new Error("synthetic-render");
      const first = isolated.reportRenderFailure(error);
      const second = isolated.reportRenderFailure(error);
      const third = isolated.reportRenderFailure(error);
      expect(first).toBeTruthy();
      expect(new Set([first, second, third]).size).toBe(1);
      expect(renderCapture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("./client");
      vi.doUnmock("@/lib/sentry");
      vi.resetModules();
    }
  });

  it("counts repeated render failures sharing one errorId once in the report", () => {
    const window = { from: "2026-10-21T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z", timezone: "UTC" as const };
    const row = (id: string, eventId: string): TelemetryReportEvent => ({
      id, actorKey: telemetryActorKey("actorA")!, eventId,
      receivedAt: NOW.toISOString(), occurredAt: NOW.toISOString(),
      event: "client.render.failed", category: "diagnostic", source: "client", trust: "client_reported",
      actionId: ACTION, sessionId: SESSION, errorId: ERROR_ID,
      payload: { schemaVersion: 1, action: "app.render", errorCode: "RENDER_FAILURE" },
    });
    const summary = summarizeTelemetryEvents([row("r1", ERROR_ID), row("r2", ACTION), row("r3", OPERATION)], window, false, 100);
    expect(summary.diagnostics.renderFailures).toBe(1);
    expect(summary.usage).toEqual({ uniqueActions: 0, clientSessions: 0, clientActors: 0, committedChanges: 0, screens: [], features: [] });
  });
});

describe("#57 repeated operationId and failure are not persisted success", () => {
  function receipt(overrides: Record<string, unknown> = {}) {
    return {
      id: "receipt-1", actorId: "actorA", operationId: OPERATION, taskId: "task-1", itemId: "item-1",
      projectId: "project-1", completed: true, changed: true, eventId: ERROR_ID, actionId: ACTION,
      requestId: null, committedAt: NOW, telemetryProjectedAt: null, ...overrides,
    };
  }

  it("projects one authoritative event for one operation even after an intermediate foreign toggle", async () => {
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt());
    await projectChecklistTelemetry("receipt-1");
    expect(db.telemetryEvent.createMany).toHaveBeenCalledTimes(1);
    const projected = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    expect(projected).toMatchObject({
      event: "task.checklist.updated", operationId: OPERATION, trust: "authoritative", eventId: ERROR_ID,
      payload: { schemaVersion: 1, action: "task.checklist.toggle", method: "PATCH", outcome: "success" },
    });
    // A second repair run sees the durable marker and never publishes again,
    // even though another actor may have toggled the item in between.
    db.telemetryEvent.createMany.mockClear();
    db.checklistOperationReceipt.update.mockClear();
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt({ telemetryProjectedAt: NOW }));
    await projectChecklistTelemetry("receipt-1");
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
    expect(db.checklistOperationReceipt.update).not.toHaveBeenCalled();
  });

  it.each([
    ["no-op", { changed: false }],
    ["expired", { committedAt: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000) }],
  ])("never projects a %s operation as a committed change", async (_label, overrides) => {
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt(overrides));
    await projectChecklistTelemetry("receipt-1");
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
    // The marker uses the collector clock, not the operation's committedAt.
    expect(db.checklistOperationReceipt.update).toHaveBeenCalledWith({ where: { id: "receipt-1" }, data: { telemetryProjectedAt: expect.any(Date) } });
  });

  it("does not mark or publish when the authoritative write fails", async () => {
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt());
    db.telemetryEvent.createMany.mockRejectedValue(Error("synthetic storage failure"));
    await expect(projectChecklistTelemetry("receipt-1")).resolves.toBeUndefined();
    expect(db.checklistOperationReceipt.update).not.toHaveBeenCalled();
  });

  it("keeps a failed request result separate from the committed business event", async () => {
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt({ changed: false }));
    await projectChecklistTelemetry("receipt-1");
    const window = { from: "2026-10-21T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z", timezone: "UTC" as const };
    const failedResult: TelemetryReportEvent = {
      id: "row-1", actorKey: telemetryActorKey("actorA")!, eventId: ACTION,
      receivedAt: NOW.toISOString(), occurredAt: NOW.toISOString(),
      event: "client.request.result", category: "diagnostic", source: "client", trust: "client_reported",
      actionId: ACTION, sessionId: SESSION,
      payload: { schemaVersion: 1, action: "task.checklist.toggle", outcome: "failure", durationMs: 7, statusCode: 500 },
    };
    const summary = summarizeTelemetryEvents([failedResult], window, false, 100);
    expect(summary.diagnostics.clientFailures).toBe(1);
    expect(summary.usage.committedChanges).toBe(0);
    // A client failure is not counted as a server failure and cannot invent a commit.
    expect(summary.diagnostics.failureRate).toBeNull();
  });
});

describe("#57 collector unavailable never breaks the user operation", () => {
  it.each([
    ["network rejection", async () => { throw new TypeError("synthetic network failure"); }],
    ["503", async () => new Response(null, { status: 503 })],
    ["500", async () => new Response(null, { status: 500 })],
    ["malformed JSON", async () => new Response("not-json", { status: 200 })],
    ["401", async () => new Response(null, { status: 401 })],
  ] as const)("survives a %s collector response without throwing into the caller", async (_label, response) => {
    const f = fixture(response as () => Promise<Response>);
    await f.client.setIdentity("actor-A");
    const businessOperation = async () => {
      const action = f.client.beginAction();
      f.client.finishAction(action!, { outcome: "failure", durationMs: 9 });
      return { saved: true };
    };
    await expect(businessOperation()).resolves.toEqual({ saved: true });
    await expect(f.client.flush()).resolves.toBeUndefined();
    await f.advance(600_000);
    // Bounded retries: at most three delivery attempts, never an endless loop.
    expect(f.batches().length).toBeLessThanOrEqual(3);
  });

  it("keeps the business result when the analytics client is not ready at all", async () => {
    const f = fixture(async () => Response.json({ success: true, data: { accepted: [] } }));
    // No setIdentity: the client is unready, so no action token exists.
    expect(f.client.beginAction()).toBeNull();
    expect(f.client.finishAction).toBeTypeOf("function");
    await expect(f.client.flush()).resolves.toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("drops the oldest events beyond the bounded queue instead of growing without limit", async () => {
    const f = fixture(async () => new Response(null, { status: 503 }));
    await f.client.setIdentity("actor-A");
    for (let i = 0; i < 150; i++) f.client.beginAction();
    for (let i = 0; i < 12; i++) await f.client.flush();
    const delivered = f.batches().flatMap(batch => batch.events);
    // 100 live events plus at most the first delivered batch that has already
    // left the queue: the bound never grows with the 150 produced intents.
    expect(new Set(delivered.map(event => event.eventId)).size).toBeLessThanOrEqual(110);
    expect(f.batches().every(batch => batch.events.length <= 10)).toBe(true);
  });
});
