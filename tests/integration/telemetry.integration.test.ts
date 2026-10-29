import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { TELEMETRY_RETENTION_MS, TELEMETRY_SESSION_MS } from "@/lib/telemetry/http";
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

const actors = new Set<string>();
const actorKeys = new Set<string>();
const sessionIds = new Set<string>();
const eventIds = new Set<string>();
const receiptIds = new Set<string>();
let database: PrismaClient;

function actor() {
  const id = `telemetry-test-${randomUUID()}`;
  actors.add(id);
  const key = telemetryActorKey(id);
  if (!key) throw Error("Synthetic telemetry configuration unavailable");
  actorKeys.add(key);
  return { id, key };
}

async function session(key: string, now: Date, id: string = randomUUID()) {
  sessionIds.add(id);
  return startTelemetrySession(key, id, now);
}

function batch(binding: Awaited<ReturnType<typeof session>>, now: Date, id = randomUUID()) {
  eventIds.add(id);
  return {
    sessionId: binding.sessionId,
    sessionToken: binding.sessionToken,
    events: [{
      schemaVersion: 1, event: "ui.action", action: "task.checklist.toggle",
      eventId: id, actionId: randomUUID(), sessionId: binding.sessionId,
      occurredAt: now.toISOString(), seq: 0,
    }],
  };
}

describeWithDatabase("PostgreSQL telemetry persistence and actor-bound proofs", () => {
  beforeAll(() => {
    // No fallback to DATABASE_URL. Guard runs before constructing any client.
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
      // Every deletion is restricted by both tracked fixture identity and its
      // own synthetic actor; other parallel suites' analytics are untouched.
      if (eventIds.size && actorKeys.size) {
        await database.telemetryEvent.deleteMany({ where: {
          eventId: { in: [...eventIds] }, actorKey: { in: [...actorKeys] },
        } });
      }
      if (receiptIds.size && actors.size) {
        await database.checklistOperationReceipt.deleteMany({ where: {
          id: { in: [...receiptIds] }, actorId: { in: [...actors] },
        } });
      }
      if (sessionIds.size && actorKeys.size) {
        await database.telemetrySession.deleteMany({ where: {
          id: { in: [...sessionIds] }, actorKey: { in: [...actorKeys] },
        } });
      }
    } finally {
      if (database) await database.$disconnect();
      injected.database = undefined;
      vi.unstubAllEnvs();
    }
  });

  it("deduplicates 20 concurrent deliveries and preserves first receivedAt on retry", async () => {
    const a = actor();
    const now = new Date();
    const binding = await session(a.key, now);
    const input = batch(binding, now);
    // Drain every request even when one fails, before fixture cleanup begins.
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => ingestTelemetryBatch(a.key, input, now)));
    expect(outcomes.every(result => result.status === "fulfilled")).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") expect(outcome.value).toEqual([input.events[0].eventId]);
    }
    const where = { actorKey: a.key, eventId: input.events[0].eventId };
    expect(await database.telemetryEvent.count({ where })).toBe(1);
    const original = await database.telemetryEvent.findFirstOrThrow({ where });
    expect(original.receivedAt).toEqual(now);
    await ingestTelemetryBatch(a.key, input, new Date(now.getTime() + 1000));
    expect((await database.telemetryEvent.findFirstOrThrow({ where })).receivedAt).toEqual(original.receivedAt);
    // This uses one real client pool, without claiming independent replicas.
  }, 30_000);

  it("rejects expired actor A proof after deleting its binding and rebinding the UUID to B", async () => {
    const a = actor();
    const b = actor();
    const now = new Date();
    const oldBinding = await session(a.key, now);
    const later = new Date(now.getTime() + TELEMETRY_SESSION_MS + 1);
    await database.telemetrySession.deleteMany({ where: {
      id: oldBinding.sessionId, actorKey: a.key, expiresAt: { lte: later },
    } });
    const newBinding = await session(b.key, later, oldBinding.sessionId);
    const oldInput = batch(oldBinding, later);
    await expect(ingestTelemetryBatch(b.key, oldInput, later)).rejects.toMatchObject({ status: 401 });
    expect(await database.telemetryEvent.count({ where: { eventId: oldInput.events[0].eventId } })).toBe(0);
    const freshInput = batch(newBinding, later);
    await expect(ingestTelemetryBatch(b.key, freshInput, later)).resolves.toEqual([freshInput.events[0].eventId]);
    expect(await database.telemetryEvent.count({ where: { actorKey: b.key, eventId: freshInput.events[0].eventId } })).toBe(1);
  });

  it("durably marks changed/noop/expired receipts and cannot resurrect purged projections", async () => {
    const a = actor();
    const now = new Date();
    const fixtures = [
      { changed: true, committedAt: now, shouldPublish: true },
      { changed: false, committedAt: now, shouldPublish: false },
      { changed: true, committedAt: new Date(now.getTime() - TELEMETRY_RETENTION_MS - 1000), shouldPublish: false },
    ];
    for (const fixture of fixtures) {
      const id = `telemetry-receipt-${randomUUID()}`;
      const eventId = randomUUID();
      receiptIds.add(id);
      eventIds.add(eventId);
      await database.checklistOperationReceipt.create({ data: {
        id, actorId: a.id, operationId: randomUUID(), taskId: `task-${randomUUID()}`,
        itemId: `item-${randomUUID()}`, projectId: `project-${randomUUID()}`,
        completed: true, changed: fixture.changed, eventId, committedAt: fixture.committedAt,
      } });
      await projectChecklistTelemetry(id);
      const receipt = await database.checklistOperationReceipt.findUniqueOrThrow({ where: { id } });
      expect(receipt.telemetryProjectedAt).not.toBeNull();
      expect(await database.telemetryEvent.count({ where: { actorKey: a.key, eventId } }))
        .toBe(fixture.shouldPublish ? 1 : 0);
      await database.telemetryEvent.deleteMany({ where: { actorKey: a.key, eventId } });
      await projectChecklistTelemetry(id);
      expect(await database.telemetryEvent.count({ where: { actorKey: a.key, eventId } })).toBe(0);
      expect((await database.checklistOperationReceipt.findUniqueOrThrow({ where: { id } })).telemetryProjectedAt)
        .toEqual(receipt.telemetryProjectedAt);
    }
  });
});
