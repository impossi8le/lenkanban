import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma, type TaskRequestState } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loopbackDatabaseUrl } from "./support/test-database";

// No repository, lifecycle, ACL, role or SQL mocks. External delivery is isolated.
vi.mock("@/socket/request-queue-events", () => ({ emitRequestQueueInvalidation: vi.fn(async () => {}), emitRequestQueueSeenInvalidation: vi.fn(async () => {}) }));
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskRequestQueueEntered: vi.fn(async () => []) }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const original = new URL(testUrl), url = new URL(loopbackDatabaseUrl(original));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || url.port !== "3922" || url.pathname !== "/lenkanban_queue_unseen_20261028_test"
    || (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public")) {
    throw new Error("Queue acceptance requires its explicitly approved isolated PostgreSQL database");
  }
  for (const value of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL, process.env.E2E_DATABASE_URL]) {
    if (value && new URL(value).hostname === original.hostname) throw new Error("Test hostname must differ from application/production hostname");
  }
}

const runId = `queue-${randomUUID()}`;
const userIds = new Set<string>(), projectIds = new Set<string>(), departmentIds = new Set<string>(), profileIds = new Set<string>();
let db: PrismaClient<Prisma.PrismaClientOptions, "query">, observer: PrismaClient;
let queue: typeof import("@/lib/request-queue-unseen");
let lifecycle: typeof import("@/features/kanban/server/task-lifecycle-service");
let previousSingleton: PrismaClient | undefined;
const singleton = globalThis as unknown as { prisma: PrismaClient | undefined };
let queryCount = 0;
const queriesByTable: Record<string, number> = {};

async function fixture(options: { state?: TaskRequestState; epoch?: number; personal?: boolean; staffCount?: number } = {}) {
  const suffix = randomUUID(), id = (kind: string) => `${runId}-${kind}-${suffix}`;
  const f = { projectId: id("board"), departmentId: id("dept"), otherDepartmentId: id("otherdept"),
    authorId: id("author"), noRoleId: id("norole"), outsiderId: id("outsider"), blockedId: id("blocked"),
    taskId: id("task"), profileId: id("execute"), staffIds: Array.from({ length: options.staffCount ?? 2 }, (_, index) => id(`staff${index}`)),
    columns: ["new", "work", "wait", "resolved", "closed"].map(id) };
  projectIds.add(f.projectId); departmentIds.add(f.departmentId); departmentIds.add(f.otherDepartmentId); profileIds.add(f.profileId);
  const ids = [f.authorId, f.noRoleId, f.outsiderId, f.blockedId, ...f.staffIds]; ids.forEach(value => userIds.add(value));
  await db.$transaction(async tx => {
    await tx.department.createMany({ data: [f.departmentId, f.otherDepartmentId].map(value => ({ id: value, name: runId })) });
    await tx.user.createMany({ data: ids.map(value => ({ id: value, email: `${value}@synthetic.invalid`, name: runId,
      primaryDepartmentId: [f.authorId, f.outsiderId].includes(value) ? f.otherDepartmentId : f.departmentId,
      isBlocked: value === f.blockedId, blockedAt: value === f.blockedId ? new Date() : null,
    })) });
    await tx.project.create({ data: { id: f.projectId, name: runId, ownerId: f.authorId, departmentId: f.departmentId,
      lifecycleColumnMap: { contractVersion: 1, submittedColumnId: f.columns[0], inProgressColumnId: f.columns[1],
        needsInfoColumnId: f.columns[2], completedColumnId: f.columns[3], closedColumnId: f.columns[4] },
      columns: { create: f.columns.map((value, position) => ({ id: value, name: `Synthetic ${position}`, color: "#123456", position,
        workflowKey: ["TODO", "IN_PROGRESS", "COLUMN_wait", "REVIEW", "DONE"][position] })) },
    } });
    await tx.privilegeProfile.create({ data: { id: f.profileId, name: runId, permissions: ["request.execute", "request.read"] } });
    await tx.scopedPrivilegeAssignment.createMany({ data: [...f.staffIds, f.blockedId].map((value, index) => ({
      id: id(`grant${index}`), userId: value, profileId: f.profileId, scopeKind: "board", projectId: f.projectId,
    })) });
    const state = options.state ?? "DRAFT", assigned = !["DRAFT", "SUBMITTED", "CANCELLED"].includes(state);
    await tx.task.create({ data: { id: f.taskId, title: "Synthetic queue acceptance", projectId: f.projectId,
      columnId: state === "CLOSED" ? f.columns[4] : state === "COMPLETED" ? f.columns[3] : assigned ? f.columns[1] : f.columns[0],
      createdById: f.authorId, rank: "0|0000000000000000002S", position: 1024,
      request: { create: { contractVersion: 1, state, authorId: f.authorId, executorId: assigned ? f.staffIds[0] : null,
        queueEpoch: options.epoch ?? 0, audienceUserIds: options.personal ? [f.staffIds[1]] : [] } },
    } });
  });
  const service = lifecycle.createTaskLifecycleService(db);
  const transition = async (actorId: string, action: Parameters<typeof service.transition>[0]["action"], extra: { reason?: string } = {}) => {
    const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId }, select: { version: true } });
    return service.transition({ actorId, taskId: f.taskId, action, operationId: randomUUID(), expectedVersion: task.version, ...extra });
  };
  const view = (actorId: string, epoch = 1) => queue.markRequestQueueSeen(db,
    { actorId, expectedActorId: actorId, taskId: f.taskId, queueEpoch: epoch });
  return { ...f, service, transition, view };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function counts(f: Fixture, actorId: string) { return queue.readRequestQueueUnseenCounts(db, actorId, { projectId: f.projectId }); }
async function closeAndDisableExecutor(f: Fixture, alreadyTaken = false) {
  if (!alreadyTaken) await f.transition(f.staffIds[0], "take");
  await f.transition(f.staffIds[0], "complete");
  await f.transition(f.staffIds[0], "close");
  await db.user.update({ where: { id: f.staffIds[0] }, data: { isBlocked: true, blockedAt: new Date() } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitForWaiter(blockerPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await observer.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))
    ) AS blocked`;
    if (row.blocked) return;
    await delay(20);
  }
  throw new Error("Expected queue-view PostgreSQL lock waiter was not observed");
}

(testUrl ? describe : describe.skip)("PostgreSQL per-actor request queue arrivals", () => {
  beforeAll(async () => {
    const url = new URL(loopbackDatabaseUrl(testUrl!)); url.searchParams.set("connection_limit", "8");
    db = new PrismaClient({ datasourceUrl: url.toString(), log: [{ emit: "event", level: "query" }],
      transactionOptions: { maxWait: 10_000, timeout: 30_000 } });
    db.$on("query", event => {
      queryCount++;
      const table = /\b(?:FROM|INTO|UPDATE)\s+(?:"public"\.)?"([^"]+)"/.exec(event.query)?.[1] ?? "other";
      queriesByTable[table] = (queriesByTable[table] ?? 0) + 1;
    });
    observer = new PrismaClient({ datasourceUrl: url.toString() });
    await db.$connect(); await observer.$connect();
    const [shape] = await db.$queryRaw<{ database: string; table: string | null; check: boolean }[]>`
      SELECT current_database() AS database, to_regclass('public."TaskRequestQueueSeen"')::text AS "table",
        EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid = '"TaskRequest"'::regclass
          AND conname = 'TaskRequest_queueEpoch_nonnegative_check') AS "check"`;
    expect(shape).toEqual({ database: "lenkanban_queue_unseen_20261028_test", table: '"TaskRequestQueueSeen"', check: true });
    // Dynamic imports occur after the guard and bind the real singleton to this
    // dedicated client. No application database client is constructed or used.
    previousSingleton = singleton.prisma; singleton.prisma = db;
    queue = await import("@/lib/request-queue-unseen");
    lifecycle = await import("@/features/kanban/server/task-lifecycle-service");
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.$transaction(async tx => {
        await tx.taskCommandOperation.deleteMany({ where: { actorId: { in: [...userIds] }, projectId: { in: [...projectIds] } } });
        await tx.scopedPrivilegeAssignment.deleteMany({ where: { userId: { in: [...userIds] }, projectId: { in: [...projectIds] } } });
        await tx.taskRequest.deleteMany({ where: { task: { projectId: { in: [...projectIds] } } } });
        await tx.project.deleteMany({ where: { id: { in: [...projectIds] }, name: runId } });
        await tx.privilegeProfile.deleteMany({ where: { id: { in: [...profileIds] }, name: runId } });
        await tx.user.deleteMany({ where: { id: { in: [...userIds] }, name: runId, email: { endsWith: "@synthetic.invalid" } } });
        await tx.department.deleteMany({ where: { id: { in: [...departmentIds] }, name: runId } });
      });
      expect(await db.user.count({ where: { id: { in: [...userIds] } } })).toBe(0);
    } finally { singleton.prisma = previousSingleton; await observer?.$disconnect(); await db.$disconnect(); }
  });

  it("persists individual receipts across clients, concurrent retries and reload without business writes", async () => {
    const f = await fixture(); await f.transition(f.authorId, "submit");
    const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    expect((await counts(f, f.staffIds[0])).total).toBe(1); expect((await counts(f, f.staffIds[1])).total).toBe(1);
    expect(await Promise.all([f.view(f.staffIds[0]), f.view(f.staffIds[0])]))
      .toEqual(expect.arrayContaining([{ changed: true, stale: false }, { changed: false, stale: false }]));
    const first = await db.taskRequestQueueSeen.findUniqueOrThrow({ where: { taskId_userId: { taskId: f.taskId, userId: f.staffIds[0] } } });
    expect(await queue.markRequestQueueSeen(observer, { actorId: f.staffIds[0], expectedActorId: f.staffIds[0], taskId: f.taskId, queueEpoch: 1 }))
      .toEqual({ changed: false, stale: false });
    expect(await db.taskRequestQueueSeen.findUniqueOrThrow({ where: { taskId_userId: { taskId: f.taskId, userId: f.staffIds[0] } } })).toEqual(first);
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect((await counts(f, f.staffIds[0])).total).toBe(0); expect((await counts(f, f.staffIds[1])).total).toBe(1);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(1);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(1);
  });
  it("keeps launch-old epoch zero seen and self-marks only a genuine submit command actor", async () => {
    const old = await fixture({ state: "SUBMITTED" });
    expect(await queue.readRequestQueueArrivalMap(db, old.staffIds[0], [old.taskId])).toEqual(new Map([[old.taskId, { epoch: 0, unseen: false }]]));
    expect((await counts(old, old.staffIds[0])).total).toBe(0);
    const f = await fixture(); const command = { actorId: f.authorId, taskId: f.taskId, action: "submit" as const, operationId: randomUUID(), expectedVersion: 0 };
    await f.service.transition(command); expect((await f.service.transition(command)).ack.replayed).toBe(true);
    expect((await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).queueEpoch).toBe(1);
    expect(await db.taskRequestQueueSeen.findMany({ where: { taskId: f.taskId }, select: { userId: true } })).toEqual([{ userId: f.authorId }]);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(1);
  });
  it("claim clears every eligible actor and canonical return creates a new epoch invalidating old receipts", async () => {
    const f = await fixture(); await f.transition(f.authorId, "submit"); await f.view(f.staffIds[1]);
    await f.transition(f.staffIds[0], "take");
    for (const actorId of f.staffIds) expect((await counts(f, actorId)).total).toBe(0);
    expect(await f.view(f.staffIds[1])).toEqual({ changed: false, stale: true });
    await closeAndDisableExecutor(f, true);
    expect((await counts(f, f.staffIds[1])).total).toBe(0);
    const returned = await f.transition(f.authorId, "reopen", { reason: "Synthetic executor unavailable" });
    expect(returned.ack).toMatchObject({ state: "SUBMITTED", executorId: null });
    expect((await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).queueEpoch).toBe(2);
    expect(await db.taskRequestQueueSeen.findMany({ where: { taskId: f.taskId }, select: { userId: true } })).toEqual([{ userId: f.authorId }]);
    expect(await f.view(f.staffIds[1], 1)).toEqual({ changed: false, stale: true });
    expect((await counts(f, f.staffIds[1])).total).toBe(1);
    expect(await f.view(f.staffIds[1], 2)).toEqual({ changed: true, stale: false });
  });
  it("rejects a stale actor assertion before any database query or write", async () => {
    const f = await fixture(); await f.transition(f.authorId, "submit"); const before = queryCount;
    await expect(queue.markRequestQueueSeen(db, { actorId: f.staffIds[0], expectedActorId: f.staffIds[1], taskId: f.taskId, queueEpoch: 1 }))
      .rejects.toMatchObject({ name: "ForbiddenError" });
    expect(queryCount).toBe(before);
    expect(await db.taskRequestQueueSeen.count({ where: { taskId: f.taskId } })).toBe(1);
  });
  it("denies unreadable, non-executor, blocked and unselected personal readers without receipts", async () => {
    const f = await fixture({ personal: true }); await f.transition(f.authorId, "submit");
    await db.taskWatcher.create({ data: { taskId: f.taskId, userId: f.staffIds[0] } });
    for (const actorId of [f.outsiderId, f.noRoleId, f.blockedId, f.staffIds[0]]) {
      await expect(f.view(actorId)).rejects.toMatchObject({ name: "NotFoundError" });
      expect(await db.taskRequestQueueSeen.count({ where: { taskId: f.taskId, userId: actorId } })).toBe(0);
    }
    expect(await f.view(f.staffIds[1])).toEqual({ changed: true, stale: false });
    const general = await fixture(); await general.transition(general.authorId, "submit");
    await db.user.update({ where: { id: general.noRoleId }, data: { globalRole: "ADMIN" } });
    await expect(general.view(general.noRoleId)).rejects.toMatchObject({ name: "NotFoundError" });
    await db.scopedPrivilegeAssignment.deleteMany({ where: { projectId: general.projectId, userId: general.staffIds[0] } });
    await expect(general.view(general.staffIds[0])).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("composes the global executor-read ACL with queue projection, watchers, ADMIN and fresh grant revocation", async () => {
    const f = await fixture({ state: "SUBMITTED", epoch: 1 });
    const noQueue = async (actorId: string, readable: boolean) => {
      expect(await queue.readRequestQueueArrivalMap(db, actorId, [f.taskId])).toEqual(readable
        ? new Map([[f.taskId, { epoch: 1, unseen: false }]]) : new Map());
      expect((await counts(f, actorId)).total).toBe(0);
      await expect(f.view(actorId)).rejects.toMatchObject({ name: "NotFoundError" });
      expect(await db.taskRequestQueueSeen.count({ where: { taskId: f.taskId, userId: actorId } })).toBe(0);
    };
    // Being active staff, or receiving an old read-only profile, grants no
    // foreign task projection. This uses the real shared ACL, not a stub.
    await noQueue(f.noRoleId, false);
    const readProfileId = `${runId}-read-${randomUUID()}`;
    profileIds.add(readProfileId);
    await db.privilegeProfile.create({ data: { id: readProfileId, name: runId, permissions: ["request.read"] } });
    await db.scopedPrivilegeAssignment.create({ data: { id: `${runId}-readgrant-${randomUUID()}`, userId: f.noRoleId, profileId: readProfileId,
      scopeKind: "board", projectId: f.projectId } });
    await noQueue(f.noRoleId, false);
    // An explicit execute grant without actual staff membership is insufficient.
    await db.scopedPrivilegeAssignment.create({ data: { id: `${runId}-outsidergrant-${randomUUID()}`, userId: f.outsiderId, profileId: f.profileId,
      scopeKind: "board", projectId: f.projectId } });
    await noQueue(f.outsiderId, false);
    await db.taskWatcher.create({ data: { taskId: f.taskId, userId: f.noRoleId } });
    await noQueue(f.noRoleId, true);
    await db.taskWatcher.deleteMany({ where: { taskId: f.taskId, userId: f.noRoleId } });
    await db.user.update({ where: { id: f.noRoleId }, data: { globalRole: "ADMIN" } });
    await noQueue(f.noRoleId, true);
    expect((await queue.readRequestQueueArrivalMap(db, f.staffIds[0], [f.taskId])).get(f.taskId))
      .toEqual({ epoch: 1, unseen: true });
    expect((await counts(f, f.staffIds[0])).total).toBe(1);
    await db.scopedPrivilegeAssignment.deleteMany({ where: { projectId: f.projectId, userId: f.staffIds[0] } });
    await noQueue(f.staffIds[0], false);
  });
  it("rechecks the epoch after a real PostgreSQL lock wait behind a return transaction", async () => {
    const f = await fixture(); await f.transition(f.authorId, "submit"); await f.view(f.staffIds[1]); await closeAndDisableExecutor(f);
    const gate = deferred<void>(), reached = deferred<number>();
    const host = { $transaction: ((run: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => db.$transaction(async tx => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      return run(new Proxy(tx, { get(target, key, receiver) {
        if (key === "activity") return new Proxy(target.activity, { get(delegate, property, delegateReceiver) {
          if (property === "create") return async (args: Prisma.ActivityCreateArgs) => { reached.resolve(backend.pid); await gate.promise; return delegate.create(args); };
          return Reflect.get(delegate, property, delegateReceiver);
        } });
        return Reflect.get(target, key, receiver);
      } }));
    }, options)) as PrismaClient["$transaction"] };
    const version = (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).version;
    const returning = lifecycle.createTaskLifecycleService(host).transition({ actorId: f.authorId, taskId: f.taskId,
      action: "reopen", operationId: randomUUID(), expectedVersion: version, reason: "Synthetic concurrent return" });
    let viewing: ReturnType<Fixture["view"]> | undefined;
    try {
      const pid = await Promise.race([reached.promise, returning.then(() => { throw new Error("Return missed the concurrency gate"); })]);
      viewing = f.view(f.staffIds[1], 1); void viewing.catch(() => {});
      await waitForWaiter(pid);
    } finally { gate.resolve(); }
    await returning;
    expect(await viewing).toEqual({ changed: false, stale: true });
    expect((await counts(f, f.staffIds[1])).total).toBe(1);
    expect(await db.taskRequestQueueSeen.count({ where: { taskId: f.taskId, userId: f.staffIds[1] } })).toBe(0);
  });
  it("rolls back business state and receipts on epoch exhaustion, with the real CHECK rejecting negatives", async () => {
    const f = await fixture({ state: "CLOSED", epoch: 2147483647 });
    await db.user.update({ where: { id: f.staffIds[0] }, data: { isBlocked: true, blockedAt: new Date() } });
    await db.taskRequestQueueSeen.create({ data: { taskId: f.taskId, userId: f.staffIds[1] } });
    const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    const marker = await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } });
    const revision = (await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).boardRevision;
    await expect(f.transition(f.authorId, "reopen", { reason: "Synthetic overflow" })).rejects.toMatchObject({ code: "VERSION_EXHAUSTED" });
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toEqual(marker);
    expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).boardRevision).toBe(revision);
    expect(await db.taskRequestQueueSeen.count({ where: { taskId: f.taskId, userId: f.staffIds[1] } })).toBe(1);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(0);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(0);
    await expect(db.$executeRaw`UPDATE "TaskRequest" SET "queueEpoch" = -1 WHERE "taskId" = ${f.taskId}`).rejects.toThrow();
    expect((await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).queueEpoch).toBe(2147483647);
  });
  it("enforces seen foreign keys and cascades only its parent request or user receipts", async () => {
    const f = await fixture(); await f.transition(f.authorId, "submit"); await f.view(f.staffIds[1]);
    await expect(db.taskRequestQueueSeen.create({ data: { taskId: `${f.taskId}-missing`, userId: f.staffIds[1] } })).rejects.toMatchObject({ code: "P2003" });
    await db.taskRequest.delete({ where: { taskId: f.taskId } });
    expect(await db.taskRequestQueueSeen.count({ where: { taskId: f.taskId } })).toBe(0);
    const second = await fixture({ state: "SUBMITTED", epoch: 1 });
    await second.view(second.staffIds[1]);
    await db.scopedPrivilegeAssignment.deleteMany({ where: { projectId: second.projectId, userId: second.staffIds[1] } });
    await db.user.delete({ where: { id: second.staffIds[1] } });
    expect(await db.taskRequestQueueSeen.count({ where: { taskId: second.taskId, userId: second.staffIds[1] } })).toBe(0);
    expect(await db.taskRequest.count({ where: { taskId: second.taskId } })).toBe(1);
  });
  it("reports 391-recipient real database duration and query counts without a timing threshold", async () => {
    const f = await fixture({ state: "SUBMITTED", epoch: 1, staffCount: 391 });
    queryCount = 0; for (const key of Object.keys(queriesByTable)) delete queriesByTable[key];
    const started = performance.now();
    const recipients = await queue.readRequestQueueRecipientIds(db, f.taskId, f.projectId);
    const elapsedMs = performance.now() - started;
    expect(new Set(recipients)).toEqual(new Set(f.staffIds));
    console.info("REQUEST_QUEUE_RECIPIENT_BENCHMARK", JSON.stringify({ recipients: recipients.length,
      elapsedMs: Math.round(elapsedMs * 100) / 100, queries: queryCount, queriesByTable: { ...queriesByTable } }));
    const defaultBudgetClient = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testUrl!),
      transactionOptions: { timeout: 5000, maxWait: 10_000 }, log: [{ emit: "event", level: "query" }] });
    let takeQueries = 0; defaultBudgetClient.$on("query", () => { takeQueries++; });
    try {
      await defaultBudgetClient.$connect();
      const service = lifecycle.createTaskLifecycleService(defaultBudgetClient);
      const command = { actorId: f.staffIds[0], taskId: f.taskId, action: "take" as const, operationId: randomUUID(), expectedVersion: 0 };
      const takeStarted = performance.now();
      const result = await service.transition(command);
      const takeElapsedMs = performance.now() - takeStarted, takeQueryCount = takeQueries;
      expect(result.ack).toMatchObject({ changed: true, state: "IN_PROGRESS", executorId: f.staffIds[0], version: 1 });
      expect((await service.transition(command)).ack.replayed).toBe(true);
      expect((await counts(f, f.staffIds[0])).total).toBe(0);
      expect((await counts(f, f.staffIds[390])).total).toBe(0);
      console.info("REQUEST_QUEUE_DEFAULT_TX_BENCHMARK", JSON.stringify({ eligibleActors: f.staffIds.length,
        transactionTimeoutMs: 5000, elapsedMs: Math.round(takeElapsedMs * 100) / 100, queries: takeQueryCount, committed: true }));
    } finally { await defaultBudgetClient.$disconnect(); }
  }, 60_000);
});
