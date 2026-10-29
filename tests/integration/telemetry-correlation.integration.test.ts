import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Issue #58: correlation and deduplication against an isolated PostgreSQL.
 *
 * Without TEST_DATABASE_URL this suite is skipped, not passed. The guard runs
 * before any PrismaClient is constructed, and every fixture is deleted by its
 * own run-scoped IDs and synthetic actor key.
 */

const injected = vi.hoisted(() => ({ database: undefined as PrismaClient | undefined }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    if (!injected.database) throw Error("Isolated telemetry database has not been initialized");
    return injected.database;
  },
}));

import {
  ingestTelemetryBatch, projectChecklistTelemetry, startTelemetrySession, telemetryActorKey,
} from "@/lib/telemetry/store";
import { readTelemetryError } from "@/lib/telemetry/reports";
import { loopbackDatabaseUrl } from "./support/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

function assertIsolatedDatabase(value: string): void {
  const testUrl = new URL(value);
  const name = decodeURIComponent(testUrl.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(testUrl.protocol)
    || !name.endsWith("_test") || name.includes("/") || name.includes("\\")) {
    throw Error("TEST_DATABASE_URL must name one PostgreSQL database ending in _test");
  }
  for (const applicationUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (applicationUrl && new URL(applicationUrl).hostname === testUrl.hostname) {
      throw Error("TEST_DATABASE_URL must use a hostname separate from application and production databases");
    }
  }
}

const runId = `wave40-${randomUUID()}`;
const actors = new Set<string>();
const actorKeys = new Set<string>();
const sessionIds = new Set<string>();
const eventIds = new Set<string>();
const receiptIds = new Set<string>();
let database: PrismaClient;

function actor() {
  const id = `${runId}-${randomUUID()}`;
  actors.add(id);
  const key = telemetryActorKey(id);
  if (!key) throw Error("Synthetic telemetry configuration unavailable");
  actorKeys.add(key);
  return { id, key };
}

async function session(key: string, now: Date) {
  const id = randomUUID();
  sessionIds.add(id);
  return startTelemetrySession(key, id, now);
}

function batch(
  binding: Awaited<ReturnType<typeof session>>,
  now: Date,
  actionId: string,
  event: "ui.action" | "client.request.result",
  extra: Record<string, unknown> = {},
) {
  const eventId = randomUUID();
  eventIds.add(eventId);
  return {
    sessionId: binding.sessionId,
    sessionToken: binding.sessionToken,
    events: [{
      schemaVersion: 1 as const, event, action: "task.checklist.toggle",
      eventId, actionId, sessionId: binding.sessionId,
      occurredAt: now.toISOString(), seq: event === "ui.action" ? 0 : 1,
      ...(event === "client.request.result" ? { outcome: "failure", durationMs: 5, statusCode: 500 } : {}),
      ...extra,
    }],
  };
}

describeWithDatabase("PostgreSQL correlation, isolation and deduplication (#58)", () => {
  beforeAll(() => {
    assertIsolatedDatabase(testDatabaseUrl!);
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_HMAC_SECRET", "isolated-synthetic-telemetry-secret-32-characters");
    const url = new URL(testDatabaseUrl!);
    url.searchParams.set("connection_limit", "5");
    database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(url) });
    injected.database = database;
  });

  afterAll(async () => {
    try {
      if (!database) return;
      if (eventIds.size && actorKeys.size) {
        await database.telemetryEvent.deleteMany({ where: { eventId: { in: [...eventIds] }, actorKey: { in: [...actorKeys] } } });
      }
      if (receiptIds.size && actors.size) {
        await database.checklistOperationReceipt.deleteMany({ where: { id: { in: [...receiptIds] }, actorId: { in: [...actors] } } });
      }
      if (sessionIds.size && actorKeys.size) {
        await database.telemetrySession.deleteMany({ where: { id: { in: [...sessionIds] }, actorKey: { in: [...actorKeys] } } });
      }
    } finally {
      if (database) await database.$disconnect();
      injected.database = undefined;
      vi.unstubAllEnvs();
    }
  });

  it("keeps two simultaneous actors' events and proofs apart", async () => {
    const a = actor();
    const b = actor();
    const now = new Date();
    const [bindingA, bindingB] = await Promise.all([session(a.key, now), session(b.key, now)]);
    const actionId = randomUUID();
    const [bodyA, bodyB] = [batch(bindingA, now, actionId, "ui.action"), batch(bindingB, now, actionId, "ui.action")];
    await Promise.all([ingestTelemetryBatch(a.key, bodyA, now), ingestTelemetryBatch(b.key, bodyB, now)]);

    expect(await database.telemetryEvent.count({ where: { actorKey: a.key } })).toBe(1);
    expect(await database.telemetryEvent.count({ where: { actorKey: b.key } })).toBe(1);
    // The same client actionId does not link the two actors.
    const rows = await database.telemetryEvent.findMany({ where: { actionId } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.actorKey)).size).toBe(2);
    // A's proof cannot be used with B's actor key.
    await expect(ingestTelemetryBatch(b.key, bodyA, now)).rejects.toMatchObject({ status: 401 });
  });

  it("does not count a repeated delivery twice and keeps the first receivedAt", async () => {
    const a = actor();
    const now = new Date();
    const binding = await session(a.key, now);
    const input = batch(binding, now, randomUUID(), "client.request.result");
    const id = input.events[0].eventId;
    await Promise.all(Array.from({ length: 10 }, () => ingestTelemetryBatch(a.key, input, now)));
    const rows = await database.telemetryEvent.findMany({ where: { actorKey: a.key, eventId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].receivedAt).toEqual(now);
    expect(rows[0].payload).toMatchObject({ schemaVersion: 1, outcome: "failure", statusCode: 500 });
  });

  it("projects one authoritative event per operationId even after a later retry", async () => {
    const a = actor();
    const now = new Date();
    const operationId = randomUUID();
    const eventId = randomUUID();
    const receiptId = `receipt-${randomUUID()}`;
    receiptIds.add(receiptId);
    eventIds.add(eventId);
    await database.checklistOperationReceipt.create({ data: {
      id: receiptId, actorId: a.id, operationId, taskId: `task-${randomUUID()}`,
      itemId: `item-${randomUUID()}`, projectId: `project-${randomUUID()}`,
      completed: true, changed: true, eventId, committedAt: now,
    } });
    await projectChecklistTelemetry(receiptId);
    await projectChecklistTelemetry(receiptId);
    const rows = await database.telemetryEvent.findMany({ where: { actorKey: a.key, operationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "task.checklist.updated", trust: "authoritative", eventId });
  });

  it("verifies a client error chain only against the same actor, request and action", async () => {
    const a = actor();
    const now = new Date();
    const binding = await session(a.key, now);
    const actionId = randomUUID();
    const requestId = randomUUID();
    const errorId = randomUUID();
    await ingestTelemetryBatch(a.key, batch(binding, now, actionId, "ui.action"), now);
    await ingestTelemetryBatch(a.key, batch(binding, now, actionId, "client.request.result", { requestId, errorId }), now);
    // Track before writing so afterAll also cleans up when a later assertion fails.
    const serverEventId = randomUUID();
    eventIds.add(serverEventId);
    await database.telemetryEvent.create({ data: {
      actorKey: a.key, eventId: serverEventId, requestId, actionId, errorId,
      receivedAt: now, occurredAt: now, event: "api.request.completed",
      category: "diagnostic", source: "server", trust: "server_observed",
      payload: {
        schemaVersion: 1, route: "/api/tasks/:id/checklist/:itemId", method: "PATCH",
        statusCode: 500, durationMs: 5, outcome: "failure", errorCode: "HTTP_5XX",
      },
    } });
    const detail = await readTelemetryError(errorId, {}, new Date(now.getTime() + 1000));
    expect(detail?.linkage).toBe("server_verified");
    expect(detail?.events.every(event => event.actionId === actionId)).toBe(true);
    expect(detail?.events.every(event => event.requestId === requestId)).toBe(true);
  });
});

// Without TEST_DATABASE_URL the suite above is skipped: skipped is not passed.
