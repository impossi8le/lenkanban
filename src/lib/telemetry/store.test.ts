import type { TelemetryEvent } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  telemetrySession: { createMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  telemetryEvent: { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  checklistOperationReceipt: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn() }));
import {
  startTelemetrySession, ingestTelemetryBatch, telemetryActorKey, projectChecklistTelemetry,
  projectPendingChecklistTelemetry, readAdminTelemetry, cleanupTelemetry, safeAdminEvent,
} from "./store";
import { TELEMETRY_RETENTION_MS, TELEMETRY_SESSION_MS } from "./http";

const now = new Date("2026-10-20T12:00:00.000Z");
const sessionId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-secret-with-at-least-32-characters");
  vi.useFakeTimers();
  vi.setSystemTime(now);
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  db.telemetrySession.createMany.mockResolvedValue({ count: 1 });
  db.telemetryEvent.createMany.mockResolvedValue({ count: 1 });
  db.$queryRaw.mockResolvedValue([{ id: "receipt1" }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function event(overrides = {}) {
  return { schemaVersion: 1, event: "ui.action", eventId, actionId, sessionId,
    action: "task.checklist.toggle", occurredAt: now.toISOString(), seq: 0, ...overrides };
}
async function session(actor = "actorA", clock = now) {
  const actorKey = telemetryActorKey(actor)!;
  db.telemetrySession.findUnique.mockResolvedValue({ id: sessionId, actorKey, expiresAt: new Date(clock.getTime() + TELEMETRY_SESSION_MS) });
  return { actorKey, ...(await startTelemetrySession(actorKey, sessionId, clock)) };
}
function receipt(overrides = {}) {
  return { id: "receipt1", actorId: "actorA", operationId, taskId: "task1", itemId: "item1", projectId: "project1",
    completed: true, changed: true, eventId, actionId, requestId: null, committedAt: now, telemetryProjectedAt: null, ...overrides };
}

describe("telemetry persistence contracts (mock transactions, no PostgreSQL claim)", () => {
  it("acknowledges immutable snapshots after JSONB key reordering and refuses changed replay identity", async () => {
    const s = await session();
    const report = event({ event: "client.problem.reported", action: "app.problem.report", seq: 1,
      errorId: operationId, reason: "button", screen: "home", breadcrumbs: [{ eventId: actionId,
        seq: 0, occurredAt: now.toISOString(), kind: "dialog", name: "task.detail" }] });
    let stored: Record<string, unknown> | undefined;
    db.telemetryEvent.createMany.mockImplementation(async ({ data }) => {
      if (!stored) {
        stored = structuredClone(data[0]);
        const payload = stored!.payload as { breadcrumbs: Record<string, unknown>[] };
        payload.breadcrumbs = payload.breadcrumbs.map(crumb => Object.fromEntries(Object.entries(crumb).reverse()));
      }
      return { count: 1 };
    });
    db.telemetryEvent.findMany.mockImplementation(async ({ where }) => stored
      && (where.actorKey ? where.actorKey === stored.actorKey : where.errorId.in.includes(stored.errorId)) ? [stored] : []);
    const batch = { sessionId, sessionToken: s.sessionToken, events: [report] };
    expect(await ingestTelemetryBatch(s.actorKey, batch, now)).toEqual([eventId]);
    const first = structuredClone(stored);
    expect(await ingestTelemetryBatch(s.actorKey, batch, now)).toEqual([eventId]);
    expect(stored).toEqual(first);
    expect(stored).toMatchObject({ actorKey: s.actorKey, event: "client.problem.reported",
      errorId: operationId, source: "client", trust: "client_reported", category: "diagnostic" });
    const row = { ...stored, id: "report1", requestId: null, projectId: null, taskId: null,
      operationId: null } as TelemetryEvent;
    expect(safeAdminEvent(row)).toMatchObject({ errorId: operationId,
      payload: { reason: "button", screen: "home", breadcrumbs: [{ name: "task.detail" }] } });
    expect(JSON.stringify(stored)).not.toContain(s.sessionToken);
    await expect(ingestTelemetryBatch(s.actorKey, { ...batch,
      events: [{ ...report, errorId: sessionId }] }, now)).rejects.toMatchObject({ code: "TELEMETRY_REPORT_REPLAY_MISMATCH" });
  });

  it("rejects another actor's signed problem report and does not acknowledge failed storage", async () => {
    const s = await session();
    const report = event({ event: "client.problem.reported", action: "app.problem.report", errorId: operationId,
      reason: "error", screen: "board", breadcrumbs: [] });
    const batch = { sessionId, sessionToken: s.sessionToken, events: [report] };
    await expect(ingestTelemetryBatch(telemetryActorKey("actorB")!, batch, now)).rejects.toMatchObject({ status: 401 });
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
    db.telemetryEvent.findMany.mockResolvedValue([]);
    db.telemetryEvent.createMany.mockRejectedValue(Error("PRIVATE"));
    await expect(ingestTelemetryBatch(s.actorKey, batch, now)).rejects.toThrow();
    expect(db.telemetryEvent.createMany).toHaveBeenCalledTimes(1);
    expect(db.telemetryEvent.findMany).toHaveBeenCalledTimes(1); // collision check, no successful receipt readback
  });

  it.each(["server", "other-actor"])("refuses a public report number already used by %s before insert", async kind => {
    const s = await session();
    const report = event({ event: "client.problem.reported", action: "app.problem.report", errorId: operationId,
      reason: "slow", screen: "home", breadcrumbs: [] });
    db.telemetryEvent.findMany.mockResolvedValue([{ actorKey: telemetryActorKey("actorB"), eventId: actionId,
      errorId: operationId, event: kind === "server" ? "api.request.completed" : "client.problem.reported" }]);
    await expect(ingestTelemetryBatch(s.actorKey, { sessionId, sessionToken: s.sessionToken, events: [report] }, now))
      .rejects.toMatchObject({ status: 409, code: "TELEMETRY_REPORT_ID_CONFLICT" });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
  });

  it("rejects two new manual intentions with the same public number in one batch", async () => {
    const s = await session();
    const report = event({ event: "client.problem.reported", action: "app.problem.report", errorId: operationId,
      reason: "slow", screen: "home", breadcrumbs: [] });
    await expect(ingestTelemetryBatch(s.actorKey, { sessionId, sessionToken: s.sessionToken,
      events: [report, { ...report, eventId: actionId }] }, now)).rejects.toMatchObject({ status: 409 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
  });
  it("assigns deployment metadata at ingest and never trusts browser release or synthetic flags", async () => {
    vi.stubEnv("SENTRY_RELEASE", "lenkanban@1.2.3");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "ABCDEF0");
    const s = await session();
    await ingestTelemetryBatch(s.actorKey, { sessionId, sessionToken: s.sessionToken,
      events: [event({ release: "PRIVATE", revision: "PRIVATE", synthetic: true })] }, now);
    const stored = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    expect(stored.payload).toMatchObject({ release: "lenkanban@1.2.3", revision: "abcdef0" });
    expect(stored.payload).not.toHaveProperty("synthetic");
    expect(JSON.stringify(stored)).not.toContain("PRIVATE");
    const row = { ...stored, id: "row1", requestId: null, errorId: null, projectId: null, taskId: null,
      operationId: null } as TelemetryEvent;
    expect(safeAdminEvent(row)?.payload).toMatchObject({ release: "lenkanban@1.2.3", revision: "abcdef0" });
    vi.stubEnv("TELEMETRY_SYNTHETIC", "true");
    await ingestTelemetryBatch(s.actorKey, { sessionId, sessionToken: s.sessionToken,
      events: [event({ synthetic: false })] }, now);
    const synthetic = db.telemetryEvent.createMany.mock.calls[1][0].data[0];
    expect(synthetic.payload.synthetic).toBe(true);
    expect(safeAdminEvent({ ...row, payload: synthetic.payload })).toBeNull();
    db.telemetryEvent.findMany.mockResolvedValue([{ ...row, payload: synthetic.payload }]);
    expect((await readAdminTelemetry({}, now)).items).toEqual([]);
  });

  it("pseudonymizes by actor and fails closed before any query", async () => {
    expect(telemetryActorKey("actorA")).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(telemetryActorKey("actorA")).not.toBe(telemetryActorKey("actorB"));
    expect(telemetryActorKey("actor private@example.org")).toBeNull();
    vi.stubEnv("TELEMETRY_ENABLED", "false");
    expect(telemetryActorKey("actorA")).toBeNull();
    await projectChecklistTelemetry("receipt1");
    await projectPendingChecklistTelemetry();
    await expect(startTelemetrySession("actor", sessionId)).rejects.toMatchObject({ status: 503 });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.checklistOperationReceipt.findMany).not.toHaveBeenCalled();
  });

  it("does not extend or rebind a session and requires exact signed expiry", async () => {
    const s = await session();
    expect(s.sessionToken).toMatch(/^v1\.\d{13}\.[a-f0-9]{64}$/);
    db.telemetrySession.findUnique.mockResolvedValue({ id: sessionId, actorKey: s.actorKey, expiresAt: new Date(now.getTime() + 1000) });
    await expect(ingestTelemetryBatch(s.actorKey, { sessionId, sessionToken: s.sessionToken, events: [event()] }, now))
      .rejects.toMatchObject({ status: 401 });
    await expect(startTelemetrySession(telemetryActorKey("actorB")!, sessionId, now)).rejects.toMatchObject({ status: 401 });
    expect(db.telemetrySession.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it("rejects old actor A proof after expired binding deletion and UUID rebind to B", async () => {
    const a = await session();
    const later = new Date(now.getTime() + TELEMETRY_SESSION_MS + 1);
    const b = await session("actorB", later); // models deletion then a fresh binding
    const queries = db.$transaction.mock.calls.length;
    await expect(ingestTelemetryBatch(b.actorKey, { sessionId, sessionToken: a.sessionToken, events: [event({ occurredAt: later.toISOString() })] }, later))
      .rejects.toMatchObject({ status: 401 });
    expect(db.$transaction).toHaveBeenCalledTimes(queries);
    await expect(ingestTelemetryBatch(b.actorKey, { sessionId, sessionToken: b.sessionToken, events: [event({ occurredAt: later.toISOString() })] }, later))
      .resolves.toEqual([eventId]);
  });

  it.each(["actor", "session", "signature", "future"])("rejects proof mismatch %s before database access", async (kind) => {
    const s = await session();
    const input = { sessionId, sessionToken: s.sessionToken, events: [event()] };
    let actor = s.actorKey;
    if (kind === "actor") actor = telemetryActorKey("actorB")!;
    if (kind === "session") { input.sessionId = actionId; input.events = [event({ sessionId: actionId })]; }
    if (kind === "signature") input.sessionToken = input.sessionToken.slice(0, -1) + (input.sessionToken.endsWith("0") ? "1" : "0");
    const clock = kind === "future" ? new Date(now.getTime() - TELEMETRY_SESSION_MS) : now;
    db.$transaction.mockClear();
    await expect(ingestTelemetryBatch(actor, input, clock)).rejects.toMatchObject({ status: 401 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([-300001, 300001])("rejects clock drift %s atomically", async (offset) => {
    const s = await session(); db.$transaction.mockClear();
    await expect(ingestTelemetryBatch(s.actorKey, { sessionId, sessionToken: s.sessionToken,
      events: [event(), event({ occurredAt: new Date(now.getTime() + offset).toISOString() })] }, now))
      .rejects.toMatchObject({ status: 400 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("reconstructs closed payload and acknowledges duplicates without extending receivedAt", async () => {
    const s = await session();
    const input = { sessionId, sessionToken: s.sessionToken, events: [event({ text: "PRIVATE", password: "PRIVATE" }), event()] };
    await expect(ingestTelemetryBatch(s.actorKey, input, now)).resolves.toEqual([eventId]);
    db.telemetryEvent.createMany.mockResolvedValue({ count: 0 });
    await expect(ingestTelemetryBatch(s.actorKey, input, new Date(now.getTime() + 1))).resolves.toEqual([eventId]);
    expect(db.telemetryEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(JSON.stringify(db.telemetryEvent.createMany.mock.calls)).not.toContain("PRIVATE");
    expect(db.telemetryEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({ source: "client", trust: "client_reported", category: "usage", receivedAt: now });
    db.$transaction.mockClear();
    await expect(ingestTelemetryBatch(s.actorKey, { ...input, events: [event({ trust: "authoritative" })] }, now))
      .rejects.toMatchObject({ status: 400 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])("marks unchanged or expired receipt, never publishes (expired=%s)", async (expired) => {
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt(expired
      ? { committedAt: new Date(now.getTime() - TELEMETRY_RETENTION_MS) } : { changed: false }));
    await projectChecklistTelemetry("receipt1");
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
    expect(db.checklistOperationReceipt.update).toHaveBeenCalledWith({ where: { id: "receipt1" }, data: { telemetryProjectedAt: now } });
  });

  it("locks receipt, projects authoritative safe metadata and never replays a projected receipt", async () => {
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt({ text: "PRIVATE" }));
    await projectChecklistTelemetry("receipt1");
    expect(db.$queryRaw.mock.calls[0][0].join("?")).toContain("FOR UPDATE");
    expect(db.telemetryEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({ eventId, operationId, source: "server", trust: "authoritative" });
    expect(JSON.stringify(db.telemetryEvent.createMany.mock.calls)).not.toContain("PRIVATE");
    db.telemetryEvent.createMany.mockClear();
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt({ telemetryProjectedAt: now }));
    await projectChecklistTelemetry("receipt1");
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
  });

  it("attaches deployment provenance to authoritative checklist projection", async () => {
    vi.stubEnv("SENTRY_RELEASE", "lenkanban@1.2.3");
    vi.stubEnv("TELEMETRY_SYNTHETIC", "true");
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt());
    await projectChecklistTelemetry("receipt1");
    const stored = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    expect(stored.payload).toMatchObject({ release: "lenkanban@1.2.3", synthetic: true });
    expect(safeAdminEvent({ id: "synthetic1", ...stored } as TelemetryEvent)).toBeNull();
  });

  it("swallows projection and repair failures without falsely marking receipt", async () => {
    db.checklistOperationReceipt.findUnique.mockResolvedValue(receipt());
    db.telemetryEvent.createMany.mockRejectedValue(Error("PRIVATE"));
    await expect(projectChecklistTelemetry("receipt1")).resolves.toBeUndefined();
    expect(db.checklistOperationReceipt.update).not.toHaveBeenCalled();
    db.checklistOperationReceipt.findMany.mockRejectedValue(Error("PRIVATE"));
    await expect(projectPendingChecklistTelemetry(1000)).resolves.toBeUndefined();
    expect(db.checklistOperationReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it("admin uses strict retention, stable cursor and sanitized closed DTO", async () => {
    const s = await session();
    const row = { id: "row2", actorKey: s.actorKey, eventId, receivedAt: now, occurredAt: now,
      event: "ui.action", category: "usage", source: "client", trust: "client_reported", actionId,
      sessionId, requestId: null, errorId: null, operationId: null, projectId: null, taskId: null,
      payload: { schemaVersion: 1, action: "task.checklist.toggle", seq: 0, text: "PRIVATE" } } satisfies TelemetryEvent;
    db.telemetryEvent.findMany.mockResolvedValue([row, { ...row, id: "row1" }]);
    const page = await readAdminTelemetry({ limit: 1, category: "usage" }, now);
    expect(JSON.stringify(page)).not.toContain("PRIVATE");
    expect(page.nextCursor).toBeTruthy();
    expect(db.telemetryEvent.findMany.mock.calls[0][0]).toMatchObject({
      where: { receivedAt: { gt: new Date(now.getTime() - TELEMETRY_RETENTION_MS) }, category: "usage" },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 2,
    });
    await readAdminTelemetry({ cursor: page.nextCursor! }, now);
    expect(db.telemetryEvent.findMany.mock.calls[1][0].where.OR).toEqual([
      { receivedAt: { lt: now } }, { receivedAt: now, id: { lt: "row2" } },
    ]);
    db.telemetryEvent.findMany.mockResolvedValue([{ ...row, trust: "authoritative" }]);
    expect((await readAdminTelemetry({}, now)).items).toEqual([]);
    await expect(readAdminTelemetry({ cursor: "not-json" }, now)).rejects.toMatchObject({ status: 400 });
    await expect(readAdminTelemetry({ limit: 101 }, now)).rejects.toMatchObject({ status: 400 });
  });

  it("cleanup bounds combined deletes and never deletes business receipts", async () => {
    db.telemetryEvent.findMany.mockResolvedValue([{ id: "old" }]);
    db.telemetryEvent.deleteMany.mockResolvedValue({ count: 4999 });
    db.telemetrySession.findMany.mockResolvedValue([{ id: sessionId }]);
    db.telemetrySession.deleteMany.mockResolvedValue({ count: 1 });
    await expect(cleanupTelemetry(now, 9000)).resolves.toEqual({ eventsDeleted: 4999, sessionsDeleted: 1 });
    expect(db.telemetryEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5000, where: { receivedAt: { lte: new Date(now.getTime() - TELEMETRY_RETENTION_MS) } } }));
    expect(db.telemetrySession.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1, where: { expiresAt: { lte: now } } }));
    expect(db.checklistOperationReceipt.update).not.toHaveBeenCalled();
  });
});
