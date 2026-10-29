import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ database: undefined as PrismaClient | undefined }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    if (!injected.database) throw Error("Isolated retention database has not been initialized");
    return injected.database;
  },
}));
import { cleanupTelemetry, readAdminTelemetry, telemetryActorKey } from "@/lib/telemetry/store";
import { TELEMETRY_RETENTION_MS } from "@/lib/telemetry/http";

const value = process.env.TEST_DATABASE_URL;
if (value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.2"
    || url.port !== "55439" || decodeURIComponent(url.pathname) !== "/lenkanban_acceptance_test") {
    throw Error("Explicit approved isolated acceptance PostgreSQL URL required");
  }
  for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (other && new URL(other).hostname === url.hostname) {
      throw Error("Test hostname must differ from application/production hostname");
    }
  }
}

// cleanupTelemetry deliberately operates on the whole telemetry store. A historic
// clock plus an eligibility preflight isolates its actual DELETEs from current
// suites without replacing Prisma or changing the production cleanup predicate.
const now = new Date("1901-02-01T12:00:00.000Z");
const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_MS);
const prefix = `retention-${randomUUID()}`;
const userId = `${prefix}-user`, projectId = `${prefix}-project`, taskId = `${prefix}-task`;
const activityId = `${prefix}-activity`, receiptId = `${prefix}-receipt`;
const eventIds = new Set<string>(), sessionIds = new Set<string>();
let db: PrismaClient;
let actorKey: string;
let businessBefore: { activity: unknown; receipt: unknown; task: unknown };

async function event(receivedAt: Date, occurredAt: Date) {
  const id = `${prefix}-${randomUUID()}`;
  eventIds.add(id);
  await db.telemetryEvent.create({ data: {
    id, actorKey, eventId: randomUUID(), requestId: randomUUID(), projectId,
    receivedAt, occurredAt, event: "api.request.completed", category: "diagnostic",
    source: "server", trust: "server_observed",
    // The data is synthetic, but synthetic:true would intentionally hide the
    // record in safeAdminEvent and mask the read-retention assertion.
    payload: { schemaVersion: 1, route: "/api/tasks/:id", method: "GET", statusCode: 200, durationMs: 1 },
  } });
  return id;
}

async function session(expiresAt: Date, createdAt: Date) {
  const id = randomUUID();
  sessionIds.add(id);
  await db.telemetrySession.create({ data: { id, actorKey, expiresAt, createdAt } });
  return id;
}

async function businessRows() {
  return {
    activity: await db.activity.findUniqueOrThrow({ where: { id: activityId } }),
    receipt: await db.checklistOperationReceipt.findUniqueOrThrow({ where: { id: receiptId } }),
    task: await db.task.findUniqueOrThrow({ where: { id: taskId } }),
  };
}

describe.skipIf(!value)("real PostgreSQL telemetry retention and physical deletion", () => {
  beforeAll(async () => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_HMAC_SECRET", "isolated-retention-synthetic-secret-32-characters");
    db = new PrismaClient({ datasources: { db: { url: value! } } });
    injected.database = db;
    await db.$connect();
    actorKey = telemetryActorKey(userId)!;
    expect(actorKey).toMatch(/^v1:[a-f0-9]{64}$/);
    await db.user.create({ data: { id: userId, name: "Synthetic retention", email: `${userId}@example.invalid` } });
    const columnId = `${prefix}-column`;
    await db.project.create({ data: { id: projectId, name: "Synthetic retention", ownerId: userId,
      columns: { create: { id: columnId, name: "Synthetic", workflowKey: "TODO", position: 0, color: "#000000" } } } });
    await db.task.create({ data: { id: taskId, projectId, columnId, title: "Synthetic retention",
      createdById: userId, rank: "0000000000000000000001", createdAt: new Date(cutoff.getTime() - 1) } });
    await db.activity.create({ data: { id: activityId, taskId, userId, action: "created", createdAt: new Date(cutoff.getTime() - 1) } });
    await db.checklistOperationReceipt.create({ data: { id: receiptId, actorId: userId, operationId: randomUUID(),
      taskId, itemId: `${prefix}-item`, projectId, completed: true, changed: true, eventId: randomUUID(),
      committedAt: new Date(cutoff.getTime() - 1) } });
    businessBefore = await businessRows();
  });

  beforeEach(async () => {
    // Fail before invoking a global cleanup if another historic fixture is
    // eligible. Never delete pre-existing rows to make the test pass.
    expect(await db.telemetryEvent.count({ where: { receivedAt: { lte: cutoff } } })).toBe(0);
    expect(await db.telemetrySession.count({ where: { expiresAt: { lte: now } } })).toBe(0);
  });

  afterEach(async () => {
    if (!db || !actorKey) return;
    await db.telemetryEvent.deleteMany({ where: { id: { in: [...eventIds] }, actorKey } });
    await db.telemetrySession.deleteMany({ where: { id: { in: [...sessionIds] }, actorKey } });
    eventIds.clear(); sessionIds.clear();
  });

  afterAll(async () => {
    try {
      if (!db) return;
      // Own identities only, including partial setup failure. Business rows have
      // been asserted before this fixture teardown, not merely counted globally.
      await db.telemetryEvent.deleteMany({ where: { id: { startsWith: prefix }, actorKey } });
      await db.telemetrySession.deleteMany({ where: { id: { in: [...sessionIds] }, actorKey } });
      await db.checklistOperationReceipt.deleteMany({ where: { id: receiptId, actorId: userId } });
      await db.project.deleteMany({ where: { id: projectId, ownerId: userId } });
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      injected.database = undefined;
      if (db) await db.$disconnect();
      vi.unstubAllEnvs();
    }
  });

  it("excludes the 30-day boundary before cleanup and deletes by receivedAt, not occurredAt or business createdAt", async () => {
    const expired = await event(new Date(cutoff.getTime() - 1), new Date(now.getTime() - 1));
    const boundary = await event(cutoff, new Date(now.getTime() - 1));
    const fresh = await event(new Date(cutoff.getTime() + 1), new Date(cutoff.getTime() - TELEMETRY_RETENTION_MS));
    const report = await readAdminTelemetry({ projectId, from: cutoff.toISOString(), to: now.toISOString() }, now);
    expect(report.items.map(item => item.id)).toEqual([fresh]);
    expect(await db.telemetryEvent.count({ where: { id: { in: [expired, boundary] }, actorKey } })).toBe(2);

    expect(await cleanupTelemetry(now, 10)).toEqual({ eventsDeleted: 2, sessionsDeleted: 0 });
    expect(await db.telemetryEvent.findMany({ where: { id: { in: [expired, boundary, fresh] }, actorKey }, select: { id: true } })).toEqual([{ id: fresh }]);
    expect(await businessRows()).toEqual(businessBefore);
    expect(await cleanupTelemetry(now, 10)).toEqual({ eventsDeleted: 0, sessionsDeleted: 0 });
  });

  it("shares the finite batch budget between events and expired sessions and preserves fresh rows", async () => {
    const older = await event(new Date(cutoff.getTime() - 2), now);
    const later = await event(new Date(cutoff.getTime() - 1), now);
    const boundary = await event(cutoff, now);
    const fresh = await event(new Date(cutoff.getTime() + 1), new Date("1800-01-01T00:00:00.000Z"));
    const expiredSession = await session(new Date(now.getTime() - 1), new Date(now.getTime() - 2));
    const boundarySession = await session(now, new Date(now.getTime() - 2));
    const freshSession = await session(new Date(now.getTime() + 1), new Date("1800-01-01T00:00:00.000Z"));

    expect(await cleanupTelemetry(now, 2)).toEqual({ eventsDeleted: 2, sessionsDeleted: 0 });
    expect(await db.telemetryEvent.count({ where: { id: { in: [older, later] }, actorKey } })).toBe(0);
    expect(await db.telemetryEvent.count({ where: { id: boundary, actorKey } })).toBe(1);
    expect(await db.telemetrySession.count({ where: { id: { in: [expiredSession, boundarySession] }, actorKey } })).toBe(2);
    expect(await cleanupTelemetry(now, 2)).toEqual({ eventsDeleted: 1, sessionsDeleted: 1 });
    expect(await db.telemetrySession.findUnique({ where: { id: expiredSession } })).toBeNull();
    expect(await db.telemetrySession.count({ where: { id: boundarySession, actorKey } })).toBe(1);
    expect(await cleanupTelemetry(now, 2)).toEqual({ eventsDeleted: 0, sessionsDeleted: 1 });
    expect(await cleanupTelemetry(now, 2)).toEqual({ eventsDeleted: 0, sessionsDeleted: 0 });
    expect(await db.telemetryEvent.findUniqueOrThrow({ where: { id: fresh } })).toMatchObject({ actorKey });
    expect(await db.telemetrySession.findUniqueOrThrow({ where: { id: freshSession } })).toMatchObject({ actorKey });
    expect(await businessRows()).toEqual(businessBefore);
  });
});
