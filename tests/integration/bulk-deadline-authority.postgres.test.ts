import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ database: {} as object, actorId: "", attempted: 0, emit: vi.fn(), automation: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("next-auth", () => ({ getServerSession: async () => ({ user: { id: runtime.actorId } }) }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: runtime.emit, emitTaskUpdated: runtime.emit }));
vi.mock("@/lib/automation-processor", () => ({ processBulkMoveAutomation: runtime.automation }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), warn: vi.fn() }, dbLogger: { error: vi.fn() } }));
import { POST } from "@/app/api/tasks/bulk-update/route";

const value = process.env.TEST_DATABASE_URL;
if (value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.2" || url.port !== "55439" || decodeURIComponent(url.pathname) !== "/lenkanban_acceptance_test") throw Error("Explicit approved isolated acceptance PostgreSQL URL required");
  for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) if (other && new URL(other).hostname === url.hostname) throw Error("Test hostname must differ from application hostname");
}
let db: PrismaClient;
const prefix = `deadline105-${randomUUID()}`, projects: string[] = [], groups: string[] = [], users: string[] = [];
async function fixture(allAssigned = false, role: "USER" | "ADMIN" = "USER") {
  const suffix = randomUUID(), actorId = `${prefix}-actor-${suffix}`, otherId = `${prefix}-other-${suffix}`, projectId = `${prefix}-p-${suffix}`, groupId = `${prefix}-g-${suffix}`;
  for (const id of [actorId, otherId]) { await db.user.create({ data: { id, email: `${id}@example.invalid`, name: prefix, globalRole: id === actorId ? role : "USER" } }); users.push(id); }
  await db.responsibleGroup.create({ data: { id: groupId, name: prefix, members: { create: { userId: actorId } } } }); groups.push(groupId);
  const source = `${projectId}-source`, target = `${projectId}-target`;
  await db.project.create({ data: { id: projectId, name: prefix, ownerId: actorId, responsibleGroupId: groupId,
    columns: { create: [{ id: source, name: "Source", workflowKey: "TODO", position: 0, color: "#000000" }, { id: target, name: "Target", workflowKey: "DONE", position: 1, color: "#000000" }] } } }); projects.push(projectId);
  const taskIds = [`${projectId}-a`, `${projectId}-b`];
  for (const [index, id] of taskIds.entries()) await db.task.create({ data: { id, title: prefix, projectId, columnId: source, createdById: actorId, deadline: new Date("2026-10-20T00:00:00Z"), rank: `0|0000000000000000000${index + 1}`, position: index * 1024,
    assignees: { create: { userId: index === 0 || allAssigned ? actorId : otherId } } } });
  runtime.actorId = actorId; runtime.attempted = 0;
  // Deterministic route input order from REAL database rows: authorized first,
  // denied second. Observe attempted writes but keep all work in actual PG TX.
  runtime.database = {
    task: { findMany: async (args: Prisma.TaskFindManyArgs) => (await db.task.findMany(args)).sort((a,b) => a.id.localeCompare(b.id)) },
    $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => callback(new Proxy(tx, { get(client, key, receiver) {
      if (key === "task") return new Proxy(client.task, { get(delegate, method, delegateReceiver) {
        if (method === "update") return async (args: Prisma.TaskUpdateArgs) => { runtime.attempted++; return delegate.update(args); };
        if (method === "updateMany") return async (args: Prisma.TaskUpdateManyArgs) => { runtime.attempted++; return delegate.updateMany(args); };
        return Reflect.get(delegate, method, delegateReceiver);
      } });
      return Reflect.get(client, key, receiver);
    } }))),
  };
  const run = (updates: object, ids = taskIds) => POST(new Request("http://localhost/api/tasks/bulk-update", { method: "POST", body: JSON.stringify({ taskIds: ids, updates }) }) as never);
  return { actorId, otherId, projectId, source, target, taskIds, run };
}
describe.skipIf(!value)("real PG bulk deadline sole-executor authority", () => {
  beforeAll(async () => { db = new PrismaClient({ datasources: { db: { url: value! } } }); await db.$connect(); });
  beforeEach(() => { runtime.emit.mockClear(); runtime.automation.mockClear(); });
  afterAll(async () => {
    if (!db) return;
    try { await db.project.deleteMany({ where: { id: { in: projects } } }); await db.responsibleGroup.deleteMany({ where: { id: { in: groups } } }); await db.user.deleteMany({ where: { id: { in: users } } }); }
    finally { await db.$disconnect(); }
  });
  it("rolls back an earlier task and relocation Activity/revision when a later author is not executor", async () => {
    for (const mixed of [false, true]) for (const deadline of [null, "2026-11-01T12:00:00.000Z"]) {
      const f = await fixture();
      const before = await db.task.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } });
      expect((await f.run({ deadline, ...(mixed ? { columnId: f.target } : {}) })).status).toBe(404);
      expect(runtime.attempted).toBeGreaterThan(0);
      expect(await db.task.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } })).toEqual(before);
      expect(await db.activity.count({ where: { taskId: { in: f.taskIds } } })).toBe(0);
      expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).boardRevision).toBe(0);
      expect(runtime.emit).not.toHaveBeenCalled(); expect(runtime.automation).not.toHaveBeenCalled();
    }
  });
  it("allows only the actual sole executor including ADMIN and denies ambiguous assignment", async () => {
    for (const role of ["USER", "ADMIN"] as const) {
      const f = await fixture(true, role);
      expect((await f.run({ deadline: null, columnId: f.target })).status).toBe(200);
      expect(await db.task.findMany({ where: { projectId: f.projectId }, select: { deadline: true, columnId: true } })).toEqual([{ deadline: null, columnId: f.target }, { deadline: null, columnId: f.target }]);
      await db.taskAssignee.create({ data: { taskId: f.taskIds[0], userId: f.otherId } });
      expect((await f.run({ deadline: "2026-11-01T12:00:00.000Z" }, [f.taskIds[0]])).status).toBe(404);
    }
  });
  it("rechecks assignments after a real Task lock wait instead of trusting the outer precheck", async () => {
    const f = await fixture(true);
    let release!: () => void, held!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { held = resolve; });
    const writer = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${f.taskIds[0]} FOR UPDATE`;
      await tx.taskAssignee.deleteMany({ where: { taskId: f.taskIds[0] } }); await tx.taskAssignee.create({ data: { taskId: f.taskIds[0], userId: f.otherId } });
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; held(row.pid); await gate;
    }, { timeout: 15000 });
    let pending: Promise<Response> | undefined, primaryFailed = false;
    try {
      const writerPid = await Promise.race([ready, writer.then(() => { throw Error("Writer ended before ready"); })]);
      pending = f.run({ deadline: null }, [f.taskIds[0]]); void pending.catch(() => undefined);
      let blocked = false; const deadline = Date.now() + 3000;
      do { const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${writerPid} = ANY(pg_blocking_pids(a.pid))) AS blocked`; blocked = row.blocked; if (!blocked) await delay(20); } while (!blocked && Date.now() < deadline);
      expect(blocked, "bulk transaction must really wait on assignment writer's Task lock").toBe(true);
      release(); await writer; expect((await pending).status).toBe(404);
      expect((await db.task.findUniqueOrThrow({ where: { id: f.taskIds[0] } })).deadline).toEqual(new Date("2026-10-20T00:00:00Z"));
      expect(runtime.emit).not.toHaveBeenCalled(); expect(runtime.automation).not.toHaveBeenCalled();
    } catch (error) { primaryFailed = true; throw error; }
    finally { release(); const results = await Promise.allSettled([writer, ...(pending ? [pending] : [])]); if (!primaryFailed) for (const result of results) if (result.status === "rejected") throw result.reason; }
  });
});
