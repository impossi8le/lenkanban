import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { createTaskCommandService } from "@/lib/task-command";
import { loopbackDatabaseUrl } from "./support/test-database";

const testUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = testUrl ? describe : describe.skip;
const runId = `task-command-${randomUUID()}`;
if (testUrl) {
  const parsed = new URL(testUrl); const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !name.endsWith("_test") || name.includes("/") || name.includes("\\")) throw Error("TEST_DATABASE_URL must name one PostgreSQL database ending in _test");
  for (const applicationUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (applicationUrl && new URL(applicationUrl).hostname === parsed.hostname) throw Error("TEST_DATABASE_URL hostname must differ from application and production hostnames");
  }
}
let database: PrismaClient;
const userIds = new Set<string>(), projectIds = new Set<string>();
type Fixture = { actorId: string; memberId: string; projectId: string; columnId: string; taskId: string };
type Result = Awaited<ReturnType<ReturnType<typeof createTaskCommandService>["saveDetails"]>>;
async function fixture(): Promise<Fixture> {
  const suffix = randomUUID(), actorId = `${runId}-owner-${suffix}`, memberId = `${runId}-member-${suffix}`;
  for (const id of [actorId, memberId]) { await database.user.create({ data: { id, email: `${id}@synthetic.invalid`, name: runId } }); userIds.add(id); }
  const projectId = `${runId}-project-${suffix}`, columnId = `${runId}-column-${suffix}`, taskId = `${runId}-task-${suffix}`;
  await database.project.create({ data: { id: projectId, ownerId: actorId, name: `${runId}-${suffix}`, members: { create: { userId: memberId, role: "MEMBER" } }, columns: { create: { id: columnId, name: "Synthetic queue", color: "#123456", workflowKey: "TODO", position: 0 } } } }); projectIds.add(projectId);
  await database.task.create({ data: { id: taskId, title: "Original", projectId, columnId, createdById: actorId, position: 1024, rank: "0|0000000000000000002S", priority: "MEDIUM", version: 0 } });
  return { actorId, memberId, projectId, columnId, taskId };
}
function save(f: Fixture, operationId = randomUUID(), title = "Updated", actorId = f.actorId, expectedVersion = 0, client: Pick<PrismaClient, "$transaction"> = database) {
  return createTaskCommandService(client).saveDetails({ actorId, taskId: f.taskId, operationId, expectedVersion, changes: { title } });
}
// Hold the common Project lock; inspect the recursive blocking graph to prove
// both transactions overlap, including a second caller waiting on the first's
// actor/operation advisory lock. Promise.all alone is not that evidence.
async function queued(f: Fixture, start: () => Promise<Result>[]) {
  let release!: () => void, ready!: (pid: number) => void;
  const unlocked = new Promise<void>(resolve => { release = resolve; }); const locked = new Promise<number>(resolve => { ready = resolve; });
  const blocker = database.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.projectId} FOR UPDATE`;
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; ready(row.pid); await unlocked;
  }, { timeout: 20_000 });
  let outcomes: Promise<PromiseSettledResult<Result>[]> | undefined;
  try {
    const pid = await Promise.race([locked, blocker.then(() => { throw Error("Blocker ended before ready"); })]); outcomes = Promise.allSettled(start());
    const deadline = Date.now() + 4_000; let waiting = 0;
    do {
      const [state] = await database.$queryRaw<{ count: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        ) SELECT count(*)::int AS count FROM blocked
      `;
      waiting = state.count; if (waiting >= 2) break; await delay(20);
    } while (Date.now() < deadline);
    expect(waiting, "Both commands must actually wait behind the held Project lock").toBeGreaterThanOrEqual(2);
  } finally { release(); const [finished] = await Promise.allSettled([blocker, ...(outcomes ? [outcomes] : [])]); if (finished.status === "rejected") throw finished.reason; }
  return outcomes!;
}

databaseDescribe("PostgreSQL Task scalar command atomicity", () => {
  beforeAll(() => { const url = new URL(testUrl!); url.searchParams.set("connection_limit", "5"); database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(url) }); });
  afterAll(async () => {
    if (!database) return;
    try {
      await database.taskCommandOperation.deleteMany({ where: { actorId: { in: [...userIds] } } });
      await database.project.deleteMany({ where: { id: { in: [...projectIds] }, name: { startsWith: runId } } });
      await database.user.deleteMany({ where: { id: { in: [...userIds] }, name: runId } });
    } finally { await database.$disconnect(); }
  });
  it("serializes the same UUID into one mutation/activity/receipt and a historical replay", async () => {
    const f = await fixture(), operationId = randomUUID(); const results = await queued(f, () => [save(f, operationId), save(f, operationId)]);
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const values = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []); expect(values.filter(result => result.ack.replayed)).toHaveLength(1); expect(values.filter(result => result.ack.changed && !result.ack.replayed)).toHaveLength(1);
    expect((await database.task.findUniqueOrThrow({ where: { id: f.taskId } })).version).toBe(1);
    expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(1);
    expect(await database.taskCommandOperation.count({ where: { actorId: f.actorId, operationId } })).toBe(1);
  }, 30_000);
  it("allows only one of two overlapping different UUID commands at the same expected version", async () => {
    const f = await fixture(); const results = await queued(f, () => [save(f, randomUUID(), "First"), save(f, randomUUID(), "Second")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "STALE_TASK_VERSION" } });
    expect((await database.task.findUniqueOrThrow({ where: { id: f.taskId } })).version).toBe(1); expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(1); expect(await database.taskCommandOperation.count({ where: { actorId: f.actorId } })).toBe(1);
  }, 30_000);
  it("rolls back actual task/activity/receipt inserts when mandatory persistence rejects", async () => {
    for (const stage of ["activity", "receipt"] as const) {
      const f = await fixture(), operationId = randomUUID(); const original = await database.task.findUniqueOrThrow({ where: { id: f.taskId } }); const failure = Error(`Synthetic ${stage} failure`); let inserted = false;
      const failing = { $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => database.$transaction(tx => operation(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "activity" && stage === "activity") return new Proxy(target.activity, { get(delegate, key, delegateReceiver) { if (key === "create") return async (args: Prisma.ActivityCreateArgs) => { await delegate.create(args); inserted = true; throw failure; }; return Reflect.get(delegate, key, delegateReceiver); } });
          if (property === "taskCommandOperation" && stage === "receipt") return new Proxy(target.taskCommandOperation, { get(delegate, key, delegateReceiver) { if (key === "create") return async (args: Prisma.TaskCommandOperationCreateArgs) => { await delegate.create(args); inserted = true; throw failure; }; return Reflect.get(delegate, key, delegateReceiver); } });
          return Reflect.get(target, property, receiver);
        },
      })), options)) as unknown as PrismaClient["$transaction"] };
      await expect(save(f, operationId, "Rollback", f.actorId, 0, failing)).rejects.toBe(failure); expect(inserted).toBe(true);
      const after = await database.task.findUniqueOrThrow({ where: { id: f.taskId } }); expect(after.title).toBe(original.title); expect(after.version).toBe(original.version); expect(after.updatedAt).toEqual(original.updatedAt);
      expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(0); expect(await database.taskCommandOperation.count({ where: { actorId: f.actorId, operationId } })).toBe(0);
    }
  });
  it("requires current membership even before returning an existing historical receipt", async () => {
    const f = await fixture(), operationId = randomUUID(); await save(f, operationId, "Member edit", f.memberId);
    await database.projectMember.deleteMany({ where: { projectId: f.projectId, userId: f.memberId } });
    await expect(save(f, operationId, "Member edit", f.memberId)).rejects.toMatchObject({ name: "NotFoundError" });
    expect((await database.task.findUniqueOrThrow({ where: { id: f.taskId } })).version).toBe(1); expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(1);
  });
});
