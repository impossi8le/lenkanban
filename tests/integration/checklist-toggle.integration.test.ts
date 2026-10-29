import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The service always receives the real transaction explicitly. Do not construct
// the application's unused global Prisma client just by importing its helpers.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { updateChecklistItem } from "@/lib/checklist-toggle";
import { ConflictError } from "@/lib/errors";
import { loopbackDatabaseUrl } from "./support/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const testRunId = `checklist-toggle-${randomUUID()}`;
function assertIsolatedDatabase(value: string) {
  const testUrl = new URL(value);
  const name = decodeURIComponent(testUrl.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(testUrl.protocol) || !name.endsWith("_test") || name.includes("/") || name.includes("\\")) {
    throw Error("TEST_DATABASE_URL must select one PostgreSQL database name ending in _test");
  }
  for (const applicationUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (applicationUrl && new URL(applicationUrl).hostname === testUrl.hostname) {
      throw Error("TEST_DATABASE_URL hostname must differ from application and production database hostnames");
    }
  }
}
// Missing explicit test URL skips everything before PrismaClient construction.
if (testDatabaseUrl) assertIsolatedDatabase(testDatabaseUrl);

let database: PrismaClient;
const userIds = new Set<string>();
const projectIds = new Set<string>();
interface Resource { projectId: string; taskId: string; itemId: string }
interface Fixture extends Resource { actorId: string; secondActorId: string }

async function resource(actorId: string, secondActorId: string): Promise<Resource> {
  const suffix = randomUUID();
  const projectId = `${testRunId}-project-${suffix}`;
  const columnId = `${testRunId}-column-${suffix}`;
  const taskId = `${testRunId}-task-${suffix}`;
  const itemId = `${testRunId}-item-${suffix}`;
  await database.project.create({ data: {
    id: projectId, name: `${testRunId}-${suffix}`, ownerId: actorId,
    members: { create: [{ userId: secondActorId, role: "MEMBER" }] },
    columns: { create: [{ id: columnId, name: "Synthetic queue", color: "#123456", position: 0, workflowKey: "TODO" }] },
  } });
  projectIds.add(projectId);
  await database.task.create({ data: {
    id: taskId, title: `${testRunId}-task`, projectId, columnId, createdById: actorId,
    rank: "0|0000000000000000002S", position: 0,
    checklistItems: { create: [{ id: itemId, text: "Synthetic checklist text", completed: false, position: 0 }] },
  } });
  return { projectId, taskId, itemId };
}
async function fixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const actorId = `${testRunId}-owner-${suffix}`;
  const secondActorId = `${testRunId}-member-${suffix}`;
  await database.user.create({ data: { id: actorId, email: `${suffix}-owner@${testRunId}.invalid`, name: testRunId } });
  userIds.add(actorId);
  await database.user.create({ data: { id: secondActorId, email: `${suffix}-member@${testRunId}.invalid`, name: testRunId } });
  userIds.add(secondActorId);
  return { actorId, secondActorId, ...await resource(actorId, secondActorId) };
}
function toggle(f: Resource & { actorId: string }, operationId: string, completed: boolean, client: Pick<PrismaClient, "$transaction"> = database) {
  return updateChecklistItem({ database: client, actorId: f.actorId, taskId: f.taskId, itemId: f.itemId,
    operationId, update: { completed }, context: { actionId: randomUUID(), requestId: randomUUID() } });
}

// Hold the exact actor/operation advisory lock, then use PostgreSQL's blocking
// graph to verify that BOTH service transactions overlap before releasing it.
async function queuedCommands(actorId: string, operationId: string, start: () => ReturnType<typeof toggle>[]) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const unlocked = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const key = JSON.stringify(["checklist-toggle-v1", actorId, operationId.toLowerCase()]);
  const blocker = database.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS locked`;
    const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(backend.pid); await unlocked;
  }, { timeout: 20_000 });
  let outcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof toggle>>>[]> | undefined;
  try {
    const pid = await Promise.race([locked, blocker.then(() => { throw Error("Advisory blocker ended before becoming ready"); })]);
    outcomes = Promise.allSettled(start());
    const deadline = Date.now() + 4_000;
    let waiting = 0;
    do {
      const [state] = await database.$queryRaw<{ count: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        ) SELECT count(*)::int AS count FROM blocked
      `;
      waiting = state.count;
      if (waiting >= 2) break;
      await delay(20);
    } while (Date.now() < deadline);
    expect(waiting, "Both checklist commands must wait on the actor/operation advisory lock").toBeGreaterThanOrEqual(2);
  } finally {
    release();
    // Drain every started promise even if overlap verification/blocker fails.
    const [finishedBlocker] = await Promise.allSettled([blocker, ...(outcomes ? [outcomes] : [])]);
    if (finishedBlocker.status === "rejected") throw finishedBlocker.reason;
  }
  return outcomes!;
}

function faultingDatabase(stage: "activity" | "receipt") {
  const failure = new Error(`Synthetic failure after real ${stage} insertion`);
  const observed = { itemWritten: false, activityWritten: false, receiptWritten: false };
  const wrappedDatabase = {
    $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => database.$transaction(async tx => {
      const items = new Proxy(tx.taskChecklistItem, { get(target, property, receiver) {
        if (property === "update") return async (args: Prisma.TaskChecklistItemUpdateArgs) => {
          const result = await target.update(args); observed.itemWritten = true; return result;
        };
        return Reflect.get(target, property, receiver);
      } });
      const activity = new Proxy(tx.activity, { get(target, property, receiver) {
        if (property === "create") return async (args: Prisma.ActivityCreateArgs) => {
          const result = await target.create(args); observed.activityWritten = true;
          if (stage === "activity") throw failure;
          return result;
        };
        return Reflect.get(target, property, receiver);
      } });
      const receipts = new Proxy(tx.checklistOperationReceipt, { get(target, property, receiver) {
        if (property === "create") return async (args: Prisma.ChecklistOperationReceiptCreateArgs) => {
          const result = await target.create(args); observed.receiptWritten = true;
          if (stage === "receipt") throw failure;
          return result;
        };
        return Reflect.get(target, property, receiver);
      } });
      return callback(new Proxy(tx, { get(target, property, receiver) {
        if (property === "taskChecklistItem") return items;
        if (property === "activity") return activity;
        if (property === "checklistOperationReceipt") return receipts;
        return Reflect.get(target, property, receiver);
      } }));
    }),
  } as unknown as Pick<PrismaClient, "$transaction">;
  return { client: wrappedDatabase, observed, failure };
}

describeWithDatabase("PostgreSQL checklist operation idempotency and atomicity", () => {
  beforeAll(() => {
    const isolated = new URL(testDatabaseUrl!); isolated.searchParams.set("connection_limit", "5");
    database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(isolated) });
  });
  afterAll(async () => {
    if (!database) return;
    try {
      // Receipt has no resource FKs: explicitly remove ONLY this run's actors and projects.
      if (userIds.size && projectIds.size) await database.checklistOperationReceipt.deleteMany({ where: { actorId: { in: [...userIds] }, projectId: { in: [...projectIds] } } });
      if (projectIds.size) await database.project.deleteMany({ where: { id: { in: [...projectIds] }, name: { contains: testRunId } } });
      if (userIds.size) await database.user.deleteMany({ where: { id: { in: [...userIds] }, email: { contains: testRunId } } });
    } finally { await database.$disconnect(); }
  });

  it("commits one item change, Activity and receipt for two genuinely overlapping identical commands", async () => {
    const f = await fixture(); const operationId = randomUUID();
    const outcomes = await queuedCommands(f.actorId, operationId, () => [toggle(f, operationId, true), toggle(f, operationId, true)]);
    expect(outcomes.every(value => value.status === "fulfilled")).toBe(true);
    const results = outcomes.flatMap(value => value.status === "fulfilled" ? [value.value] : []);
    expect(results.filter(value => value.changed && !value.replayed)).toHaveLength(1);
    expect(results.filter(value => value.replayed && !value.changed)).toHaveLength(1);
    expect(results[0].receiptId).toBe(results[1].receiptId);
    expect((await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } })).completed).toBe(true);
    expect(await database.activity.count({ where: { taskId: f.taskId, action: "checklist_item_completed" } })).toBe(1);
    const receipts = await database.checklistOperationReceipt.findMany({ where: { actorId: f.actorId, operationId } });
    expect(receipts).toHaveLength(1); expect(receipts[0]).toMatchObject({ taskId: f.taskId, itemId: f.itemId, changed: true, completed: true });
    expect(JSON.stringify(receipts)).not.toContain("Synthetic checklist text");
  }, 30_000);

  it("replays an old intent after another actor's opposite toggle without undoing the new state", async () => {
    const f = await fixture(); const firstOperation = randomUUID();
    const first = await toggle(f, firstOperation, true);
    await toggle({ ...f, actorId: f.secondActorId }, randomUUID(), false);
    const replay = await toggle(f, firstOperation, true);
    expect(replay).toMatchObject({ replayed: true, changed: false, receiptId: first.receiptId, item: { completed: false } });
    expect((await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } })).completed).toBe(false);
    expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(2);
    expect(await database.checklistOperationReceipt.count({ where: { taskId: f.taskId } })).toBe(2);
  });

  it("serializes one operation reused across different projects into one winner and one conflict", async () => {
    const f = await fixture(); const other = await resource(f.actorId, f.secondActorId); const operationId = randomUUID();
    const outcomes = await queuedCommands(f.actorId, operationId, () => [toggle(f, operationId, true), toggle({ ...other, actorId: f.actorId }, operationId, true)]);
    expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find(value => value.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason instanceof ConflictError).toBe(true);
    const items = await database.taskChecklistItem.findMany({ where: { id: { in: [f.itemId, other.itemId] } } });
    expect(items.filter(value => value.completed)).toHaveLength(1);
    expect(await database.activity.count({ where: { taskId: { in: [f.taskId, other.taskId] } } })).toBe(1);
    expect(await database.checklistOperationReceipt.count({ where: { actorId: f.actorId, operationId } })).toBe(1);
  }, 30_000);

  it("persists a no-op receipt without changing the item timestamp or writing Activity", async () => {
    const f = await fixture(); const operationId = randomUUID();
    const before = await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } });
    const result = await toggle(f, operationId, false);
    expect(result).toMatchObject({ changed: false, replayed: false });
    expect(await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } })).toEqual(before);
    expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(0);
    expect(await database.checklistOperationReceipt.findUniqueOrThrow({ where: { actorId_operationId: { actorId: f.actorId, operationId } }, select: { changed: true, completed: true } })).toEqual({ changed: false, completed: false });
  });

  it.each(["activity", "receipt"] as const)("rolls back real item/Activity/receipt writes on injected %s failure and allows retry", async (stage) => {
    const f = await fixture(); const operationId = randomUUID(); const fault = faultingDatabase(stage);
    const before = await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } });
    await expect(toggle(f, operationId, true, fault.client)).rejects.toBe(fault.failure);
    expect(fault.observed.itemWritten).toBe(true); expect(fault.observed.activityWritten).toBe(true);
    if (stage === "receipt") expect(fault.observed.receiptWritten).toBe(true);
    expect(await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } })).toEqual(before);
    expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(0);
    expect(await database.checklistOperationReceipt.count({ where: { actorId: f.actorId, operationId } })).toBe(0);
    expect((await toggle(f, operationId, true)).changed).toBe(true);
    expect((await toggle(f, operationId, true)).replayed).toBe(true);
    expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(1);
    expect(await database.checklistOperationReceipt.count({ where: { actorId: f.actorId, operationId } })).toBe(1);
  });
});
