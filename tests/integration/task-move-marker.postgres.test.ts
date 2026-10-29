import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { createBase36RankService, formatRank, RANK_MAX } from "@/features/kanban/rank/rank-service";
import { moveTask } from "@/features/kanban/server/move-task-service";
import { PrismaMoveRepository } from "@/features/kanban/server/prisma-move-repository";
import { createCanonicalTaskRelocationPort, relocateTaskToColumn } from "@/features/kanban/server/task-relocation";
import { loopbackDatabaseUrl } from "./support/test-database";

const testUrl = process.env.TEST_DATABASE_URL, guardedDescribe = testUrl ? describe : describe.skip;
if (testUrl) {
  const parsed = new URL(testUrl), name = decodeURIComponent(parsed.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !name.endsWith("_test") || name.includes("/") || name.includes("\\")) throw Error("TEST_DATABASE_URL must select one PostgreSQL database ending in _test");
  for (const applicationUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) if (applicationUrl && new URL(applicationUrl).hostname === parsed.hostname) throw Error("TEST_DATABASE_URL hostname must differ from application and production hostnames");
}
const runId = `move-marker-${randomUUID()}`, ranks = createBase36RankService();
const users = new Set<string>(), projects = new Set<string>(), tasks = new Set<string>();
let database: PrismaClient;
async function fixture() {
  const suffix = randomUUID(), actorId = `${runId}-actor-${suffix}`, ownerId = `${runId}-owner-${suffix}`;
  for (const id of [actorId, ownerId]) { await database.user.create({ data: { id, name: runId, email: `${id}@synthetic.invalid`, globalRole: id === actorId ? "ADMIN" : "USER" } }); users.add(id); }
  const projectId = `${runId}-project-${suffix}`, sourceId = `${runId}-src-${suffix}`, destinationId = `${runId}-dst-${suffix}`;
  const taskId = `${runId}-task-${suffix}`, sourceSiblingId = `${runId}-sibling-${suffix}`, destinationSiblingId = `${runId}-dest-${suffix}`;
  await database.project.create({ data: { id: projectId, name: runId, ownerId, columns: { create: [{ id: sourceId, name: "Source", color: "#111111", workflowKey: "TODO", position: 0 }, { id: destinationId, name: "Destination", color: "#222222", workflowKey: "IN_PROGRESS", position: 1 }] } } }); projects.add(projectId);
  for (const [id, columnId, rank, position] of [[taskId, sourceId, formatRank(100n), 1024], [sourceSiblingId, sourceId, formatRank(200n), 2048], [destinationSiblingId, destinationId, formatRank(100n), 1024]] as const) {
    await database.task.create({ data: { id, projectId, columnId, title: runId, rank, position, version: 0 } }); tasks.add(id);
  }
  return { actorId, ownerId, projectId, sourceId, destinationId, taskId, sourceSiblingId, destinationSiblingId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function move(f: Fixture, operationId = randomUUID(), toColumnId = f.destinationId, beforeTaskId: string | null = f.destinationSiblingId, afterTaskId: string | null = null) {
  return moveTask({ taskId: f.taskId, request: { operationId, expectedVersion: 0, toColumnId, beforeTaskId, afterTaskId }, ranks, repository: new PrismaMoveRepository(database, { taskId: f.taskId, toColumnId, operationId, actorId: f.actorId }) });
}
async function mark(f: Fixture, taskId = f.taskId) { await database.taskRequest.create({ data: { taskId, contractVersion: 1, state: "DRAFT", authorId: f.actorId, executorId: null } }); }
async function snapshot(f: Fixture) {
  return { tasks: await database.task.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } }), project: await database.project.findUniqueOrThrow({ where: { id: f.projectId } }), activities: await database.activity.count({ where: { task: { projectId: f.projectId } } }), receipts: await database.taskMoveOperation.count({ where: { projectId: f.projectId } }) };
}
guardedDescribe("PostgreSQL guarded DnD and canonical relocation", () => {
  beforeAll(() => { const url = new URL(testUrl!); url.searchParams.set("connection_limit", "5"); database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(url) }); });
  afterAll(async () => {
    if (!database) return;
    try {
      await database.taskRequest.deleteMany({ where: { taskId: { in: [...tasks] } } });
      await database.taskMoveOperation.deleteMany({ where: { projectId: { in: [...projects] } } });
      await database.project.deleteMany({ where: { id: { in: [...projects] }, name: runId } });
      await database.user.deleteMany({ where: { id: { in: [...users] }, name: runId } });
    } finally { await database.$disconnect(); }
  });
  it("rejects a now-marked historical DnD replay and same-column canonical no-op without changing the committed snapshot", async () => {
    const f = await fixture(), operationId = randomUUID(); await move(f, operationId); await mark(f); const before = await snapshot(f);
    await expect(move(f, operationId)).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" });
    await expect(database.$transaction(tx => relocateTaskToColumn({ taskId: f.taskId, expectedProjectId: f.projectId, toColumnId: f.destinationId, expectedVersion: 1, operationId: randomUUID(), ranks, port: createCanonicalTaskRelocationPort(tx, ranks, f.actorId) }))).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" });
    expect(await snapshot(f)).toEqual(before);
  });
  it("rejects ordinary same-column sibling position/rank writes atomically", async () => {
    const f = await fixture(); await mark(f, f.sourceSiblingId); const before = await snapshot(f);
    await expect(move(f, randomUUID(), f.sourceId, f.sourceSiblingId, null)).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); expect(await snapshot(f)).toEqual(before);
  });
  it("rejects a marked destination sibling on genuinely exhausted canonical append rank space", async () => {
    const f = await fixture(); await database.task.update({ where: { id: f.destinationSiblingId }, data: { rank: formatRank(RANK_MAX - 1n) } }); await mark(f, f.destinationSiblingId); const before = await snapshot(f);
    expect(ranks.between(formatRank(RANK_MAX - 1n), null)).toBeNull();
    await expect(database.$transaction(tx => relocateTaskToColumn({ taskId: f.taskId, expectedProjectId: f.projectId, toColumnId: f.destinationId, expectedVersion: 0, operationId: randomUUID(), ranks, port: createCanonicalTaskRelocationPort(tx, ranks, f.actorId) }))).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); expect(await snapshot(f)).toEqual(before);
  });
  it("rechecks revoked ADMIN after waiting for the Project lock, ahead of marked replay", async () => {
    const f = await fixture(), operationId = randomUUID(); await move(f, operationId); await mark(f); const before = await snapshot(f);
    let release!: () => void, ready!: (pid: number) => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<number>(resolve => { ready = resolve; });
    const blocker = database.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id"=${f.projectId} FOR UPDATE`; const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; ready(row.pid); await unlocked; }, { timeout: 20_000 });
    let outcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const pid = await Promise.race([locked, blocker.then(() => { throw Error("Blocker ended before ready"); })]); outcome = Promise.allSettled([move(f, operationId)]);
      let waiting = false; const deadline = Date.now() + 4_000;
      do { const [row] = await database.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`; waiting = row.waiting; if (!waiting) await delay(20); } while (!waiting && Date.now() < deadline);
      expect(waiting).toBe(true); await database.user.update({ where: { id: f.actorId }, data: { globalRole: "USER" } });
    } finally { release(); const [result] = await Promise.allSettled([blocker, ...(outcome ? [outcome] : [])]); if (result.status === "rejected") throw result.reason; }
    expect(await outcome).toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "TASK_NOT_FOUND" }) })]); expect(await snapshot(f)).toEqual(before);
  }, 30_000);
});
