import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { createTaskLifecycleService } from "@/features/kanban/server/task-lifecycle-service";
import { loopbackDatabaseUrl } from "./support/test-database";

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const parsed = new URL(testUrl), name = decodeURIComponent(parsed.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !name.endsWith("_test") || /[/\\]/.test(name)) throw Error("Dedicated PostgreSQL _test database required");
  for (const app of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) if (app && new URL(app).hostname === parsed.hostname) throw Error("Test hostname must differ from application hostname");
}
const runId = `lifecycle-col-${randomUUID()}`;
let db: PrismaClient;
const users: string[] = [], projects: string[] = [], groups: string[] = [];
async function fixture(state: "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "CLOSED" = "DRAFT") {
  const suffix = randomUUID(), projectId = `${runId}-p-${suffix}`, authorId = `${runId}-a-${suffix}`, executorId = `${runId}-e-${suffix}`, groupId = `${runId}-g-${suffix}`, taskId = `${runId}-t-${suffix}`;
  for (const id of [authorId, executorId]) { await db.user.create({ data: { id, email: `${id}@synthetic.invalid`, name: runId } }); users.push(id); }
  await db.responsibleGroup.create({ data: { id: groupId, name: runId, members: { create: { userId: executorId } } } }); groups.push(groupId);
  const ids = ["new", "work", "wait", "resolved", "closed"].map(role => `${runId}-${role}-${suffix}`);
  const lifecycleColumnMap = { contractVersion: 1, submittedColumnId: ids[0], inProgressColumnId: ids[1], needsInfoColumnId: ids[2], completedColumnId: ids[3], closedColumnId: ids[4] };
  await db.project.create({ data: { id: projectId, name: runId, ownerId: authorId, responsibleGroupId: groupId, lifecycleColumnMap,
    columns: { create: ids.map((id, position) => ({ id, name: `Synthetic ${position}`, color: "#123456", position, workflowKey: ["TODO", "IN_PROGRESS", "COLUMN_wait", "REVIEW", "DONE"][position] })) } } }); projects.push(projectId);
  await db.task.create({ data: { id: taskId, projectId, columnId: state === "DRAFT" ? ids[0] : state === "COMPLETED" ? ids[3] : state === "CLOSED" ? ids[4] : ids[1], title: "Synthetic lifecycle", createdById: authorId, rank: "0|0000000000000000002S", position: 1024,
    request: { create: { contractVersion: 1, state, authorId, executorId: state === "DRAFT" ? null : executorId } } } });
  const service = createTaskLifecycleService(db, { notifyQueueEntered: async () => [] });
  const transition = async (actorId: string, action: "submit" | "take" | "request_info" | "answer_info" | "complete" | "close" | "reopen", response?: { commentId: string }, reason?: string) => {
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    return service.transition({ actorId, taskId, action, operationId: randomUUID(), expectedVersion: task.version, ...(response ? { response } : {}), ...(reason ? { reason } : {}) });
  };
  return { projectId, groupId, authorId, executorId, taskId, ids, service, transition };
}
(testUrl ? describe : describe.skip)("PostgreSQL atomic lifecycle column placement", () => {
  beforeAll(() => { db = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(new URL(testUrl!)) }); });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.taskCommandOperation.deleteMany({ where: { actorId: { in: users } } });
      await db.taskRequest.deleteMany({ where: { task: { projectId: { in: projects } } } });
      await db.project.deleteMany({ where: { id: { in: projects }, name: runId } });
      await db.responsibleGroup.deleteMany({ where: { id: { in: groups }, name: runId } });
      await db.user.deleteMany({ where: { id: { in: users }, name: runId } });
    } finally { await db.$disconnect(); }
  });
  it("persists the whole lifecycle roundtrip in canonical columns and ends solved, never closed", async () => {
    const f = await fixture();
    await f.transition(f.authorId, "submit");
    await f.transition(f.executorId, "take");
    await f.transition(f.executorId, "request_info");
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ columnId: f.ids[2], status: "COLUMN_wait", version: 3 });
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toMatchObject({ state: "NEEDS_INFO", executorId: f.executorId, needsInfoSince: expect.any(Date) });
    const comment = await db.chatMessage.create({ data: { taskId: f.taskId, authorId: f.authorId, contentText: "Synthetic answer" } });
    await f.transition(f.authorId, "answer_info", { commentId: comment.id });
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ columnId: f.ids[1], status: "IN_PROGRESS", version: 4 });
    await f.transition(f.executorId, "complete");
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ columnId: f.ids[3], status: "IN_REVIEW", version: 5 });
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toMatchObject({ state: "COMPLETED", needsInfoSince: null });
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(5);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(5);
  });
  it("rolls back marker, column, rank, revision and receipt when mandatory Activity fails", async () => {
    const f = await fixture("IN_PROGRESS"), original = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    const failure = Error("Synthetic Activity failure"); let inserted = false;
    const failing = { $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => db.$transaction(tx => operation(new Proxy(tx, {
      get(target, key, receiver) {
        if (key === "activity") return new Proxy(target.activity, { get(delegate, property, delegateReceiver) {
          if (property === "create") return async (args: Prisma.ActivityCreateArgs) => { await delegate.create(args); inserted = true; throw failure; };
          return Reflect.get(delegate, property, delegateReceiver);
        } });
        return Reflect.get(target, key, receiver);
      },
    })), options)) as PrismaClient["$transaction"] };
    await expect(createTaskLifecycleService(failing).transition({ actorId: f.executorId, taskId: f.taskId, action: "request_info", expectedVersion: 0, operationId: randomUUID() })).rejects.toBe(failure);
    expect(inserted).toBe(true);
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(original);
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toMatchObject({ state: "IN_PROGRESS", needsInfoSince: null });
    expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).boardRevision).toBe(0);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(0);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(0);
  });
  it("persists one explicit close and reopens CLOSED for its author with reason", async () => {
    const f = await fixture("COMPLETED"), operationId = randomUUID();
    const input = { actorId: f.executorId, taskId: f.taskId, action: "close" as const, expectedVersion: 0, operationId };
    await f.service.transition(input);
    expect((await f.service.transition(input)).ack).toMatchObject({ state: "CLOSED", replayed: true });
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ columnId: f.ids[4], status: "DONE", version: 1 });
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(1);
    await f.transition(f.authorId, "reopen", undefined, "Synthetic reopen reason");
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ columnId: f.ids[1], status: "IN_PROGRESS", version: 2 });
  });
  it("revokes historical close authority when group leader membership is removed, preserving read access", async () => {
    const f = await fixture("COMPLETED"), leaderId = f.projectId.replace("-p-", "-l-");
    await db.user.create({ data: { id: leaderId, email: `${leaderId}@synthetic.invalid`, name: runId } }); users.push(leaderId);
    await db.responsibleGroupMember.create({ data: { groupId: f.groupId, userId: leaderId } });
    await db.responsibleGroup.update({ where: { id: f.groupId }, data: { leaderId } });
    await db.projectMember.create({ data: { projectId: f.projectId, userId: leaderId } });
    // Board discovery alone is not task read; retain a separate ordinary reader
    // grant so this case isolates revoked close authority, including replay.
    await db.taskWatcher.create({ data: { taskId: f.taskId, userId: leaderId } });
    const input = { actorId: leaderId, taskId: f.taskId, action: "close" as const, expectedVersion: 0, operationId: randomUUID() };
    await f.service.transition(input);
    await db.responsibleGroupMember.delete({ where: { groupId_userId: { groupId: f.groupId, userId: leaderId } } });
    expect((await f.service.snapshot({ actorId: leaderId, taskId: f.taskId })).permissions).toMatchObject({ canParticipate: true, isResponsibleGroupLeader: false, canClose: false });
    await expect(f.service.transition(input)).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(1);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(1);
  });
  it("reopens CLOSED into the group queue when the former executor is blocked", async () => {
    const f = await fixture("CLOSED");
    await db.user.update({ where: { id: f.executorId }, data: { isBlocked: true, blockedAt: new Date() } });
    await f.transition(f.authorId, "reopen", undefined, "Synthetic blocked executor reason");
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ columnId: f.ids[0], status: "TODO", version: 1 });
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toMatchObject({ state: "SUBMITTED", executorId: null });
  });
  it.each(["leader", "membership"] as const)("holds %s authority rows through commit against an overlapping revocation", async resource => {
    const f = await fixture("COMPLETED"), leaderId = f.projectId.replace("-p-", "-l-");
    await db.user.create({ data: { id: leaderId, email: `${leaderId}@synthetic.invalid`, name: runId } }); users.push(leaderId);
    await db.responsibleGroupMember.create({ data: { groupId: f.groupId, userId: leaderId } });
    await db.responsibleGroup.update({ where: { id: f.groupId }, data: { leaderId } });
    await db.projectMember.create({ data: { projectId: f.projectId, userId: leaderId } });
    await db.taskWatcher.create({ data: { taskId: f.taskId, userId: leaderId } });
    let release!: () => void, reached!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<number>(resolve => { reached = resolve; });
    const client = { $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => db.$transaction(async tx => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      return operation(new Proxy(tx, { get(target, key, receiver) {
        if (key === "activity") return new Proxy(target.activity, { get(delegate, property, delegateReceiver) {
          if (property === "create") return async (args: Prisma.ActivityCreateArgs) => { reached(backend.pid); await gate; return delegate.create(args); };
          return Reflect.get(delegate, property, delegateReceiver);
        } });
        return Reflect.get(target, key, receiver);
      } }));
    }, { ...options, timeout: 20_000 })) as PrismaClient["$transaction"] };
    const input = { actorId: leaderId, taskId: f.taskId, action: "close" as const, expectedVersion: 0, operationId: randomUUID() };
    const closing = createTaskLifecycleService(client).transition(input);
    let revoking: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([ready, closing.then(() => { throw Error("Close ended before the authority overlap gate"); })]);
      revoking = resource === "leader"
        ? db.responsibleGroup.update({ where: { id: f.groupId }, data: { leaderId: null } })
        : db.responsibleGroupMember.delete({ where: { groupId_userId: { groupId: f.groupId, userId: leaderId } } });
      // Start the Prisma thenable before observing actual database blocking.
      revoking = Promise.resolve(revoking);
      let waiting = 0;
      const deadline = Date.now() + 4_000;
      do {
        const [row] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
        waiting = row.count; if (waiting > 0) break; await delay(20);
      } while (Date.now() < deadline);
      expect(waiting, "Revocation must really block on the close transaction's held row lock").toBeGreaterThan(0);
    } finally {
      release();
      const results = await Promise.allSettled([closing, ...(revoking ? [revoking] : [])]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    expect((await f.service.snapshot({ actorId: leaderId, taskId: f.taskId })).permissions).toMatchObject({ canParticipate: true, isResponsibleGroupLeader: false, canClose: false });
    await expect(f.service.transition(input)).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(1);
  }, 30_000);
});
