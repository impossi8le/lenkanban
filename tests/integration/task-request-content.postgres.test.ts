import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { authorizeTaskRequestContentWrite, createTaskLifecycleService, deleteTaskLifecycleAware } from "@/features/kanban/server/task-lifecycle-service";
import { NotFoundError } from "@/lib/errors";

const value = process.env.TEST_DATABASE_URL;
if (value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.2" || url.port !== "55439"
    || decodeURIComponent(url.pathname) !== "/lenkanban_acceptance_test") throw Error("Explicit approved isolated acceptance PostgreSQL URL required");
  for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) if (other && new URL(other).hostname === url.hostname) throw Error("Test hostname must differ from application/production hostname");
}
let db: PrismaClient;
const prefix = `content-read-${randomUUID()}`;
const projects: string[] = [], groups: string[] = [], users: string[] = [];
async function fixture() {
  const suffix = randomUUID();
  const [author, executor, watcher, boardOnly] = ["author", "executor", "watcher", "board"].map(role => `${prefix}-${role}-${suffix}`);
  for (const id of [author, executor, watcher, boardOnly]) { await db.user.create({ data: { id, name: prefix, email: `${id}@example.invalid` } }); users.push(id); }
  const groupId = `${prefix}-g-${suffix}`, projectId = `${prefix}-p-${suffix}`, taskId = `${prefix}-t-${suffix}`, columnId = `${prefix}-c-${suffix}`;
  const lifecycleColumnMap = { contractVersion: 1, submittedColumnId: `${columnId}-new`, inProgressColumnId: `${columnId}-work`, needsInfoColumnId: columnId, completedColumnId: `${columnId}-solved`, closedColumnId: `${columnId}-closed` };
  await db.responsibleGroup.create({ data: { id: groupId, name: prefix, members: { create: { userId: executor } } } }); groups.push(groupId);
  // Canonical author and actual watcher deliberately have no board membership.
  await db.project.create({ data: { id: projectId, name: prefix, ownerId: boardOnly, responsibleGroupId: groupId, lifecycleColumnMap,
    columns: { create: [
      { id: lifecycleColumnMap.submittedColumnId, name: "New", workflowKey: "TODO", position: 0, color: "#000000" },
      { id: lifecycleColumnMap.inProgressColumnId, name: "Working", workflowKey: "IN_PROGRESS", position: 1, color: "#000000" },
      { id: columnId, name: "Waiting", workflowKey: "COLUMN_waiting", position: 2, color: "#000000" },
      { id: lifecycleColumnMap.completedColumnId, name: "Solved", workflowKey: "REVIEW", position: 3, color: "#000000" },
      { id: lifecycleColumnMap.closedColumnId, name: "Closed", workflowKey: "DONE", position: 4, color: "#000000" },
    ] } } }); projects.push(projectId);
  await db.task.create({ data: { id: taskId, title: prefix, projectId, columnId, rank: "0000000000000000000001", status: "IN_PROGRESS", createdById: author,
    watchers: { create: { userId: watcher } }, request: { create: { contractVersion: 1, state: "NEEDS_INFO", authorId: author, executorId: executor, needsInfoSince: new Date("2026-10-23T00:00:00Z"), pausedTotalMs: 123 } } } });
  return { author, executor, watcher, boardOnly, projectId, taskId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function authorize(f: Fixture, actorId: string, kind: "comment" | "attachment" = "comment", tx?: Prisma.TransactionClient) {
  const run = (client: Prisma.TransactionClient) => authorizeTaskRequestContentWrite({ tx: client, actorId, taskId: f.taskId, expectedProjectId: f.projectId, kind });
  return tx ? run(tx) : db.$transaction(run);
}
describe.skipIf(!value)("real PG authoritative common content reader", () => {
  beforeAll(async () => { db = new PrismaClient({ datasources: { db: { url: value! } } }); await db.$connect(); });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.taskCommandOperation.deleteMany({ where: { projectId: { in: projects } } });
      await db.taskRequest.deleteMany({ where: { task: { projectId: { in: projects } } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.responsibleGroup.deleteMany({ where: { id: { in: groups } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally { await db.$disconnect(); }
  });
  it("admits canonical author and actual watcher without board access, denies board-only, and never mutates lifecycle", async () => {
    const f = await fixture();
    const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } }), marker = await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } });
    for (const kind of ["comment", "attachment"] as const) {
      for (const actor of [f.author, f.executor, f.watcher]) expect(await authorize(f, actor, kind)).toEqual({ allowed: true, marked: true, state: "NEEDS_INFO" });
      await expect(authorize(f, f.boardOnly, kind)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(task);
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toEqual(marker);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(0);
  });
  it("honors real watcher revocation, actor blocking, deletion and CANCELLED/DRAFT privacy", async () => {
    const f = await fixture();
    expect((await authorize(f, f.watcher)).allowed).toBe(true);
    await db.taskWatcher.delete({ where: { taskId_userId: { taskId: f.taskId, userId: f.watcher } } });
    await expect(authorize(f, f.watcher)).rejects.toBeInstanceOf(NotFoundError);
    await db.user.update({ where: { id: f.author }, data: { isBlocked: true } });
    await expect(authorize(f, f.author)).rejects.toBeInstanceOf(NotFoundError);
    await db.user.update({ where: { id: f.author }, data: { isBlocked: false } });
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { state: "CANCELLED", needsInfoSince: null } });
    expect(await authorize(f, f.author)).toEqual({ allowed: false, code: "INVALID_TRANSITION" });
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { state: "DRAFT", executorId: null } });
    await expect(authorize(f, f.executor)).rejects.toBeInstanceOf(NotFoundError);
    expect((await authorize(f, f.author)).allowed).toBe(true);
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { deletedAt: new Date() } });
    await expect(authorize(f, f.author)).rejects.toBeInstanceOf(NotFoundError);
  });
  it("holds the actual watcher row against DELETE until content transaction commits", async () => {
    const f = await fixture();
    let release!: () => void, held!: (pid: number) => void, started!: (pid: number) => void;
    const released = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { held = resolve; }), mutationReady = new Promise<number>(resolve => { started = resolve; });
    const holder = db.$transaction(async tx => {
      expect((await authorize(f, f.watcher, "attachment", tx)).allowed).toBe(true);
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; held(row.pid); await released;
    }, { timeout: 15000 });
    let mutation: Promise<unknown> | undefined, primaryFailed = false;
    try {
      const holderPid = await Promise.race([ready, holder.then(() => { throw Error("Holder ended before ready"); })]);
      mutation = db.$transaction(async tx => {
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; started(row.pid);
        return tx.taskWatcher.delete({ where: { taskId_userId: { taskId: f.taskId, userId: f.watcher } } });
      }, { timeout: 15000 });
      const mutationPid = await Promise.race([mutationReady, mutation.then(() => { throw Error("Mutation ended before observation"); })]);
      let blocked = false; const deadline = Date.now() + 5000;
      do {
        const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT ${holderPid} = ANY(pg_blocking_pids(${mutationPid}::integer)) AS blocked`;
        blocked = row.blocked; if (!blocked) await delay(20);
      } while (!blocked && Date.now() < deadline);
      expect(blocked, "actual watcher DELETE must wait on content transaction").toBe(true);
    } catch (error) { primaryFailed = true; throw error; }
    finally {
      release(); const results = await Promise.allSettled([holder, ...(mutation ? [mutation] : [])]);
      if (!primaryFailed) for (const result of results) if (result.status === "rejected") throw result.reason;
    }
    await expect(authorize(f, f.watcher)).rejects.toBeInstanceOf(NotFoundError);
  });
  it("uses the same task read grant for lifecycle metadata and author description/reopen, without giving watcher status rights", async () => {
    const f = await fixture(), service = createTaskLifecycleService(db);
    expect((await service.snapshot({ actorId: f.author, taskId: f.taskId })).permissions).toMatchObject({ isAuthor: true, canParticipate: true, canExecute: false });
    expect((await service.snapshot({ actorId: f.watcher, taskId: f.taskId })).permissions).toMatchObject({ isAuthor: false, canParticipate: true, canExecute: false });
    await expect(service.snapshot({ actorId: f.boardOnly, taskId: f.taskId })).rejects.toBeInstanceOf(NotFoundError);
    const before = await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } });
    await service.transition({ actorId: f.author, taskId: f.taskId, operationId: randomUUID(), expectedVersion: 0, action: "edit_description", description: "synthetic canonical description" });
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toEqual(before);
    await expect(service.transition({ actorId: f.watcher, taskId: f.taskId, operationId: randomUUID(), expectedVersion: 1, action: "take" })).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { state: "CLOSED", needsInfoSince: null } });
    await service.transition({ actorId: f.author, taskId: f.taskId, operationId: randomUUID(), expectedVersion: 1, action: "reopen", reason: "synthetic reason" });
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toMatchObject({ state: "IN_PROGRESS", executorId: f.executor });
    await db.taskWatcher.delete({ where: { taskId_userId: { taskId: f.taskId, userId: f.watcher } } });
    await expect(service.snapshot({ actorId: f.watcher, taskId: f.taskId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.transition({ actorId: f.watcher, taskId: f.taskId, operationId: randomUUID(), expectedVersion: 2, action: "request_info", reason: "denied" })).rejects.toBeInstanceOf(NotFoundError);
  });
  it("keeps ADMIN deleted metadata readable while denying commands before ACK and preserving authorized DELETE no-op", async () => {
    const f = await fixture(), service = createTaskLifecycleService(db);
    await db.user.update({ where: { id: f.author }, data: { globalRole: "ADMIN" } });
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { state: "CANCELLED", needsInfoSince: null, deletedAt: new Date() } });
    expect(await service.snapshot({ actorId: f.author, taskId: f.taskId })).toMatchObject({ deleted: true, state: "CANCELLED" });
    const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    for (const action of ["edit_description", "reopen"] as const) await expect(service.transition({ actorId: f.author, taskId: f.taskId, operationId: randomUUID(), expectedVersion: 0, action, ...(action === "edit_description" ? { description: "denied" } : { reason: "denied" }) })).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.$transaction(tx => deleteTaskLifecycleAware({ tx, actorId: f.author, taskId: f.taskId, expectedProjectId: f.projectId }))).toEqual({ logical: true, changed: false, state: "CANCELLED" });
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(0);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(0);
  });
  it("lets a second snapshot on the same board finish while the first waits on another held Task", async () => {
    const f = await fixture(), service = createTaskLifecycleService(db);
    const first = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    const secondId = `${f.taskId}-second`;
    await db.task.create({ data: { id: secondId, title: prefix, projectId: f.projectId, columnId: first.columnId, rank: "0000000000000000000002", createdById: f.author,
      request: { create: { contractVersion: 1, state: "SUBMITTED", authorId: f.author } } } });
    let release!: () => void, held!: (pid: number) => void;
    const released = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { held = resolve; });
    const holder = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${f.taskId} FOR UPDATE`;
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; held(row.pid); await released;
    }, { timeout: 15000 });
    let pending: Promise<unknown> | undefined, second: Promise<unknown> | undefined, primaryFailed = false, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const holderPid = await Promise.race([ready, holder.then(() => { throw Error("Holder ended before ready"); })]);
      pending = service.snapshot({ actorId: f.author, taskId: f.taskId });
      void pending.catch(() => undefined); // Drain original below; avoid an early unhandled rejection.
      let blocked = false; const deadline = Date.now() + 3000;
      do {
        const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${holderPid} = ANY(pg_blocking_pids(a.pid))) AS blocked`;
        blocked = row.blocked; if (!blocked) await delay(20);
      } while (!blocked && Date.now() < deadline);
      expect(blocked, "first snapshot must actually wait on the held Task").toBe(true);
      second = service.snapshot({ actorId: f.author, taskId: secondId });
      const snapshot = await Promise.race([second, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Sibling snapshot blocked behind unrelated Task")), 2000); })]);
      expect(snapshot).toMatchObject({ taskId: secondId, marked: true });
    } catch (error) { primaryFailed = true; throw error; }
    finally {
      if (timer) clearTimeout(timer);
      release(); const results = await Promise.allSettled([holder, ...(pending ? [pending] : []), ...(second ? [second] : [])]);
      if (!primaryFailed) for (const result of results) if (result.status === "rejected") throw result.reason;
    }
  });
});
