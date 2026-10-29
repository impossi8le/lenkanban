import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  telemetrySession: { createMany: vi.fn(), findUnique: vi.fn() },
  telemetryEvent: { createMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn() }));

import {
  parseClientTelemetryBatch,
  parseClientTelemetryEvent,
  parseTelemetrySessionStart,
} from "./contract";
import { ingestTelemetryBatch, safeAdminEvent, startTelemetrySession, telemetryActorKey } from "./store";
import { summarizeTelemetryEvents } from "./summarize";
import type { TelemetryReportEvent } from "./report-contract";
import { TELEMETRY_COVERAGE } from "./report-contract";
import { TELEMETRY_SERVER_ROUTES } from "./catalog";

/**
 * Issue #57 acceptance: the analytics contract is closed.
 *
 * Every fixture here is synthetic. No Pino/Sentry/collector transport is
 * contacted; the Prisma module is replaced before `store` is imported.
 */

const EVENT = "a12bc345-6789-4abc-8def-012345678901";
const SESSION = "b12bc345-6789-4abc-8def-012345678901";
const ACTION = "c12bc345-6789-4abc-8def-012345678901";
const NOW = new Date("2026-10-21T09:00:00.000Z");
const TOKEN = `v1.${NOW.getTime() + 60 * 60 * 1000}.${"a".repeat(64)}`;

type Shape = Record<string, unknown>;

function intent(extra: Shape = {}): Shape {
  return {
    schemaVersion: 1,
    eventId: EVENT,
    sessionId: SESSION,
    actionId: ACTION,
    action: "task.checklist.toggle",
    event: "ui.action",
    occurredAt: NOW.toISOString(),
    seq: 1,
    ...extra,
  };
}

function result(extra: Shape = {}): Shape {
  return intent({ event: "client.request.result", outcome: "success", durationMs: 4, ...extra });
}

function renderFailure(extra: Shape = {}): Shape {
  return intent({
    action: "app.render",
    event: "client.render.failed",
    errorId: "d12bc345-6789-4abc-8def-012345678901",
    errorCode: "RENDER_FAILURE",
    ...extra,
  });
}

function batch(events: unknown[] = [intent()]): Shape {
  return { sessionId: SESSION, sessionToken: TOKEN, events };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-contract-secret-at-least-32-chars");
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  db.telemetrySession.createMany.mockResolvedValue({ count: 1 });
  db.telemetrySession.findUnique.mockResolvedValue({
    id: SESSION,
    actorKey: telemetryActorKey("actorA")!,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  });
  db.telemetryEvent.createMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("#57 required fields and schemaVersion", () => {
  it.each(["schemaVersion", "eventId", "sessionId", "actionId", "action", "event", "occurredAt", "seq"])(
    "rejects an event missing required field %s",
    key => {
      const input = intent();
      delete input[key];
      expect(parseClientTelemetryEvent(input)).toBeNull();
    },
  );

  it.each([
    ["schemaVersion", undefined],
    ["schemaVersion", null],
    ["schemaVersion", "1"],
    ["schemaVersion", 0],
    ["schemaVersion", 2],
    ["schemaVersion", 1.5],
    ["eventId", null],
    ["eventId", 42],
    ["occurredAt", null],
    ["seq", null],
  ])("rejects %s=%j rather than coercing it", (key, value) => {
    expect(parseClientTelemetryEvent(intent({ [key]: value }))).toBeNull();
  });

  it("returns exactly the documented field set for each closed event variant", () => {
    const ui = parseClientTelemetryEvent(intent());
    const request = parseClientTelemetryEvent(result({ statusCode: 409, requestId: EVENT, errorId: ACTION }));
    const render = parseClientTelemetryEvent(renderFailure());
    expect(Object.keys(ui!).sort()).toEqual(
      ["action", "actionId", "event", "eventId", "occurredAt", "schemaVersion", "seq", "sessionId"].sort(),
    );
    expect(Object.keys(request!).sort()).toEqual(
      ["action", "actionId", "durationMs", "errorId", "event", "eventId", "occurredAt", "outcome", "requestId", "schemaVersion", "seq", "sessionId", "statusCode"].sort(),
    );
    expect(Object.keys(render!).sort()).toEqual(
      ["action", "actionId", "errorCode", "errorId", "event", "eventId", "occurredAt", "schemaVersion", "seq", "sessionId"].sort(),
    );
    expect(ui!.schemaVersion).toBe(1);
    expect(render!.schemaVersion).toBe(1);
  });

  it.each([
    ["actorId", "actor-1"],
    ["actorKey", "v1:" + "a".repeat(64)],
    ["source", "server"],
    ["trust", "authoritative"],
    ["receivedAt", NOW.toISOString()],
    ["category", "usage"],
  ])("refuses the client-supplied server-only field %s even with a plausible value", (key, value) => {
    for (const input of [intent({ [key]: value }), result({ [key]: value }), renderFailure({ [key]: value })]) {
      expect(parseClientTelemetryEvent(input)).toBeNull();
    }
  });
});

describe("#57 outcome vocabulary", () => {
  it.each(["success", "rejected", "conflict", "failure", "cancelled"])("accepts the declared outcome %s", outcome => {
    expect(parseClientTelemetryEvent(result({ outcome }))).toMatchObject({ event: "client.request.result", outcome });
  });

  it.each([
    "SUCCESS",
    "Success",
    "committed",
    "ok",
    "error",
    "timeout",
    "cancelled ",
    "",
    null,
    undefined,
    1,
    true,
    ["success"],
    { outcome: "success" },
  ])("rejects the undeclared outcome %j", outcome => {
    expect(parseClientTelemetryEvent(result({ outcome }))).toBeNull();
  });

  it("never derives an outcome for a UI intent that has no result yet", () => {
    expect(parseClientTelemetryEvent(intent())).not.toHaveProperty("outcome");
    expect(parseClientTelemetryEvent(intent({ outcome: "success" }))).toBeNull();
  });

  it("keeps a failed result distinguishable from a successful one at the parser boundary", () => {
    const failed = parseClientTelemetryEvent(result({ outcome: "failure", statusCode: 500 }));
    const succeeded = parseClientTelemetryEvent(result({ outcome: "success", statusCode: 200 }));
    expect(failed).toMatchObject({ event: "client.request.result", outcome: "failure", statusCode: 500 });
    expect(succeeded).toMatchObject({ event: "client.request.result", outcome: "success", statusCode: 200 });
    expect(failed).not.toEqual(succeeded);
  });
});

describe("#57 unsupported events and closed catalog", () => {
  it.each([
    "request.clarification.respond",
    "task.checklist.updated",
    "task.checklist.noop",
    "api.request.completed",
    "socket.operation.completed",
    "job.failed",
    "auth.result",
    "ui.action ",
    "UI.ACTION",
    "",
  ])("rejects unsupported event name %j", event => {
    expect(parseClientTelemetryEvent(intent({ event }))).toBeNull();
    expect(parseClientTelemetryEvent(result({ event }))).toBeNull();
  });

  it.each([
    "request.clarification.respond",
    "task.checklist.delete",
    "app.render",
    "Task.Checklist.Toggle",
    "",
  ])("rejects unsupported action %j", action => {
    expect(parseClientTelemetryEvent(intent({ action }))).toBeNull();
    expect(parseClientTelemetryEvent(result({ action }))).toBeNull();
  });

  it("rejects a mismatched event/action pair in both directions", () => {
    expect(parseClientTelemetryEvent(intent({ action: "app.render" }))).toBeNull();
    expect(parseClientTelemetryEvent(renderFailure({ action: "task.checklist.toggle" }))).toBeNull();
    expect(parseClientTelemetryEvent(renderFailure({ errorCode: "OTHER_FAILURE" }))).toBeNull();
    expect(parseClientTelemetryEvent(renderFailure({ errorId: "not-a-uuid" }))).toBeNull();
    expect(parseClientTelemetryEvent(renderFailure({ outcome: "failure" }))).toBeNull();
  });

  it("rejects a whole batch containing one unsupported event instead of silently dropping it", () => {
    expect(parseClientTelemetryBatch(batch([intent(), intent({ event: "task.checklist.updated" })]))).toBeNull();
    expect(parseClientTelemetryBatch(batch([intent(), intent({ schemaVersion: 2 })]))).toBeNull();
  });

  it("exposes only the documented coverage and server routes", () => {
    expect([...TELEMETRY_COVERAGE]).toEqual([
      "task.checklist.toggle",
      "app.render",
      "screen.view",
      "board.view.change",
      "board.filter.change",
      "board.search",
      "task.create",
      "task.update",
      "task.move",
      "comment.create",
      "attachment.upload",
    ]);
    expect([...TELEMETRY_SERVER_ROUTES]).toEqual([
      "/api/tasks/:id",
      "/api/tasks/:id/checklist/:itemId",
      "/api/tasks/:id/messages",
      "/api/recurring-tasks",
      "/api/recurring-tasks/:id",
    ]);
    // A concrete URL or a query string is never an accepted route template.
    for (const forged of ["/api/tasks/1/checklist/2", "/api/tasks/:id?token=private", "/api/admin/telemetry"]) {
      expect(TELEMETRY_SERVER_ROUTES.has(forged)).toBe(false);
    }
  });

  it.each([
    { kind: "session.end", sessionId: SESSION },
    { kind: "session.start" },
    { kind: "session.start", sessionId: "not-a-uuid" },
    { kind: "session.start", sessionId: SESSION, actorId: "actor-1" },
  ])("rejects unsupported session-start shape %j", input => {
    expect(parseTelemetrySessionStart(input)).toBeNull();
  });
});

describe("#57 persistence boundary re-validates the closed contract", () => {
  async function ingest(input: unknown, actor = "actorA") {
    const key = telemetryActorKey(actor)!;
    return ingestTelemetryBatch(key, input, NOW);
  }

  it("rejects a re-serialized payload that bypasses the parser with a server-only trust field", async () => {
    await expect(ingest(batch([intent({ trust: "authoritative" })]))).rejects.toMatchObject({ status: 400 });
    await expect(ingest(batch([intent({ category: "usage" })]))).rejects.toMatchObject({ status: 400 });
    await expect(ingest(batch([intent({ receivedAt: NOW.toISOString() })]))).rejects.toMatchObject({ status: 400 });
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
  });

  it("rejects unsupported events at the persistence boundary, not only in the parser", async () => {
    await expect(ingest(batch([intent({ event: "task.checklist.updated" })]))).rejects.toMatchObject({ status: 400 });
    await expect(ingest(batch([intent({ schemaVersion: 2 })]))).rejects.toMatchObject({ status: 400 });
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
  });

  it("writes server-owned provenance, category and a safe schemaVersion payload", async () => {
    // The proof must be the real HMAC binding, not a hand-written token.
    const binding = await startTelemetrySession(telemetryActorKey("actorA")!, SESSION, NOW);
    await expect(ingest({ ...batch(), sessionToken: binding.sessionToken })).resolves.toEqual([EVENT]);
    const row = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      eventId: EVENT,
      event: "ui.action",
      category: "usage",
      source: "client",
      trust: "client_reported",
      actorKey: telemetryActorKey("actorA"),
      receivedAt: NOW,
    });
    expect(row.payload).toEqual({ schemaVersion: 1, action: "task.checklist.toggle", seq: 1 });
  });

  it("accepts a signed session start only for the pseudonymous actor key", async () => {
    const key = telemetryActorKey("actorA")!;
    await expect(startTelemetrySession(key, SESSION, NOW)).resolves.toMatchObject({ sessionId: SESSION });
    await expect(startTelemetrySession(telemetryActorKey("actorB")!, ACTION, NOW))
      .rejects.toMatchObject({ status: 401 });
  });
});

describe("#57 the admin report DTO rejects rows outside the closed contract", () => {
  function row(extra: Shape = {}): TelemetryReportEvent {
    return {
      id: "row-1",
      actorKey: telemetryActorKey("actorA")!,
      eventId: EVENT,
      receivedAt: NOW.toISOString(),
      occurredAt: NOW.toISOString(),
      event: "ui.action",
      category: "usage",
      source: "client",
      trust: "client_reported",
      actionId: ACTION,
      sessionId: SESSION,
      payload: { schemaVersion: 1, action: "task.checklist.toggle", seq: 1 },
      ...extra,
    } as TelemetryReportEvent;
  }

  it("counts a contract-valid intent once", () => {
    expect(summarizeTelemetryEvents([row()], { from: "2026-10-21T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z", timezone: "UTC" }, false, 100)
      .usage.uniqueActions).toBe(1);
  });

  it.each([
    { event: "task.checklist.updated" },
    { event: "invented.event" },
    { trust: "authoritative" },
    { source: "server" },
    { category: "diagnostic" },
    { payload: { schemaVersion: 2, action: "task.checklist.toggle", seq: 1 } },
    { payload: { schemaVersion: 1, action: "request.clarification.respond", seq: 1 } },
    { actionId: null },
    { sessionId: null },
  ])("does not count the unsupported row %j as usage", extra => {
    const summary = summarizeTelemetryEvents([row(extra)], {
      from: "2026-10-21T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z", timezone: "UTC",
    }, false, 100);
    expect(summary.usage).toEqual({ uniqueActions: 0, clientSessions: 0, clientActors: 0, committedChanges: 0, screens: [], features: [] });
    expect(summary.collection.observedRows).toBe(0);
  });

  it("drops an unknown stored payload field instead of promoting it into the report DTO", () => {
    const stored = {
      id: "row-1",
      actorKey: telemetryActorKey("actorA")!,
      eventId: EVENT,
      receivedAt: NOW,
      occurredAt: NOW,
      event: "ui.action",
      category: "usage",
      source: "client",
      trust: "client_reported",
      actionId: ACTION,
      requestId: null,
      errorId: null,
      operationId: null,
      sessionId: SESSION,
      projectId: null,
      taskId: null,
      payload: { schemaVersion: 1, action: "task.checklist.toggle", seq: 1, outcome: "success", text: "PRIVATE-TEXT" },
    };
    const safe = safeAdminEvent(stored as never);
    expect(safe?.payload).toEqual({ schemaVersion: 1, action: "task.checklist.toggle", seq: 1 });
    expect(JSON.stringify(safe)).not.toContain("PRIVATE-TEXT");
  });

  it("rejects a stored row whose payload schemaVersion is not exactly 1", () => {
    const stored = {
      id: "row-1",
      actorKey: telemetryActorKey("actorA")!,
      eventId: EVENT,
      receivedAt: NOW,
      occurredAt: NOW,
      event: "ui.action",
      category: "usage",
      source: "client",
      trust: "client_reported",
      actionId: ACTION,
      requestId: null,
      errorId: null,
      operationId: null,
      sessionId: SESSION,
      projectId: null,
      taskId: null,
      payload: { schemaVersion: 2, action: "task.checklist.toggle", seq: 1 },
    };
    expect(safeAdminEvent(stored as never)).toBeNull();
  });
});
