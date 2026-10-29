import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({ database: {} as object, session: true, rate: vi.fn(), emit: vi.fn(), moved: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(stub.database, key) }) }));
vi.mock("next-auth", () => ({ getServerSession: async () => stub.session ? { user: { id: "actor", globalRole: "ADMIN" } } : null }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: stub.rate, rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: stub.emit, emitTaskMoved: stub.moved }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: stub.error }, dbLogger: { error: stub.error } }));

import { prepareLegacyTaskScalarBatch } from "./task-command";
import { POST } from "@/app/api/tasks/bulk-update/route";

function fixture() {
  const identity = { id: "custom / задача", projectId: "project" };
  const stored = { ...identity, priority: "MEDIUM", version: 19, deadline: new Date("2026-10-20T00:00:00Z") as Date | null };
  const state = { task: structuredClone(stored) };
  const options = { role: "ADMIN", relation: "owner", outerRelation: "owner", marker: [] as unknown,
    queryFailure: false, actor: true, task: true, onTaskLock: undefined as undefined | (() => Promise<void>) };
  const calls: string[] = [];
  let working = state;
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); return [{ id: "project" }]; }
      if (sql.includes('FROM "Task"')) { calls.push("task-lock"); await options.onTaskLock?.(); return options.task ? [{ id: stored.id, projectId: stored.projectId, priority: stored.priority, version: stored.version }] : []; }
      if (sql.includes('FROM "User"')) { calls.push("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }]; }
      throw new Error("Unexpected SQL");
    }),
    user: { findUnique: vi.fn(async () => { calls.push("fresh-actor"); return options.actor ? { id: "actor", globalRole: options.role } : null; }) },
    project: { findUnique: vi.fn(async () => { calls.push("fresh-project"); return { id: "project", ownerId: options.relation === "owner" ? "actor" : "someone", members: options.relation === "member" ? [{ userId: "actor", role: "MEMBER" }] : [] }; }) },
    taskRequest: { findMany: vi.fn(async () => { calls.push("marker"); if (options.queryFailure) throw new Error("synthetic-private-storage"); return options.marker; }) },
    taskAssignee: { findMany: vi.fn(async () => { expect(calls).toContain("task-lock"); return [{ userId: "actor" }]; }) },
    task: { update: vi.fn(async ({ data }: { data: { priority?: string; deadline?: Date | null } }) => { calls.push("write"); Object.assign(working.task, data); return working.task; }) },
    activity: { create: vi.fn() },
  };
  let reads = 0;
  const database = {
    task: { findMany: vi.fn(async () => { reads++; const task = reads === 1 ? stored : state.task; return [{ ...task, project: { id: "project", ownerId: options.outerRelation === "owner" ? "actor" : "someone", members: options.outerRelation === "member" ? [{ userId: "actor" }] : [] } }]; }) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => { working = structuredClone(state); const result = await callback(tx); Object.assign(state, working); return result; },
  };
  return { stored, state, options, calls, tx, database, prepare: (restricted: boolean) => prepareLegacyTaskScalarBatch({ tx: tx as unknown as Prisma.TransactionClient, actorId: "actor", expectedTasks: [identity], ...(restricted ? { requireOwnerOrMember: true as const } : {}) }) };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, updates: object = { priority: "HIGH" }, duplicate = false, taskIds?: string[]) {
  stub.database = f.database;
  return POST(new Request("http://localhost/api/tasks/bulk-update", { method: "POST", body: JSON.stringify({ taskIds: taskIds ?? (duplicate ? [f.stored.id, f.stored.id] : [f.stored.id]), updates }) }) as never);
}
function noEffects(f: Fixture) { expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(stub.emit).not.toHaveBeenCalled(); expect(stub.moved).not.toHaveBeenCalled(); }
beforeEach(() => { vi.clearAllMocks(); stub.session = true; stub.rate.mockResolvedValue(undefined); });

describe("shared helper server-only POST restriction", () => {
  it.each(["owner", "member"])("allows current ADMIN %s using bounded facts before marker", async relation => {
    const f = fixture(); f.options.relation = relation; await expect(f.prepare(true)).resolves.toHaveLength(1);
    expect(f.calls).toEqual(["project-lock", "task-lock", "actor-lock", "fresh-actor", "fresh-project", "marker"]);
    expect(f.tx.project.findUnique).toHaveBeenCalledWith({ where: { id: "project" }, select: { ownerId: true, members: { where: { userId: "actor" }, select: { userId: true }, take: 1 } } });
  });
  it("rejects current ADMIN outsider before marker", async () => {
    const f = fixture(); f.options.relation = "outsider";
    await expect(f.prepare(true)).rejects.toMatchObject({ name: "NotFoundError" }); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noEffects(f);
  });
  it("preserves default PATCH global ADMIN bypass when restriction is absent", async () => {
    const f = fixture(); f.options.relation = "outsider";
    await expect(f.prepare(false)).resolves.toHaveLength(1); expect(f.tx.project.findUnique).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).toHaveBeenCalledOnce();
  });
  it.each(["owner", "member", "outsider"])("retains common USER policy for %s without invented grants", async relation => {
    const f = fixture(); f.options.role = "USER"; f.options.relation = relation;
    if (relation === "outsider") { await expect(f.prepare(true)).rejects.toMatchObject({ name: "NotFoundError" }); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); }
    else await expect(f.prepare(true)).resolves.toHaveLength(1);
    expect(f.tx.project.findUnique).toHaveBeenCalledOnce();
  });
});

describe("actual legacy bulk POST", () => {
  it.each(["owner", "member"])("preserves custom IDs, duplicates, deadline clear and ADMIN %s", async relation => {
    const f = fixture(); f.options.relation = relation; f.options.outerRelation = relation;
    const response = await run(f, { priority: "CRITICAL", deadline: null }, true);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { success: true, updatedCount: 1 } });
    expect(f.tx.task.update).toHaveBeenCalledExactlyOnceWith({ where: { id: f.stored.id }, data: { priority: "CRITICAL", deadline: null } });
    expect(f.state.task.version).toBe(19); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(stub.emit).toHaveBeenCalledOnce();
  });
  it("retains deadline Date conversion", async () => {
    const f = fixture(); expect((await run(f, { deadline: "2026-11-01T12:34:56.000Z" })).status).toBe(200);
    expect(f.tx.task.update).toHaveBeenCalledWith({ where: { id: f.stored.id }, data: { deadline: new Date("2026-11-01T12:34:56.000Z") } });
  });
  it("refuses empty updates at validation, matching the sibling bulk PATCH", async () => {
    const f = fixture(); const response = await run(f, {}); expect(response.status).toBe(422); noEffects(f);
  });
  it("guards noop updates without inventing writes", async () => {
    const f = fixture(); const response = await run(f, { priority: "MEDIUM" }); expect(response.status).toBe(200);
    expect(f.tx.taskRequest.findMany).toHaveBeenCalledOnce(); expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled();
  });
  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"])("rejects %s before writing", async state => {
    const f = fixture(); f.stored.id = "legacy-task"; f.state.task.id = "legacy-task";
    f.options.marker = [{ taskId: f.stored.id, contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" }];
    // Route inventories the new ID and preflight preserves that identity.
    const response = await run(f, { priority: "HIGH" }); expect(response.status).toBe(409); noEffects(f);
  });
  it.each([undefined, {}, [null], [{ taskId: "custom / задача" }]].map(value => ({ value })))("rejects malformed storage %#", async ({ value }) => {
    const f = fixture(); f.options.marker = value;
    const response = await run(f); expect(response.status).toBe(409); noEffects(f);
  });
  it.each(["query", "delegate"])("maps %s failure to safe500 without raw fallback", async mode => {
    const f = fixture(); if (mode === "query") f.options.queryFailure = true; else Reflect.deleteProperty(f.tx, "taskRequest");
    const response = await run(f); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); noEffects(f);
    expect(stub.error).toHaveBeenCalledWith(expect.objectContaining({ event: expect.any(String), route: "/api/tasks/bulk-update" }));
  });
  it("checks a later marked target before writing priority/deadline on the first", async () => {
    const f = fixture(); const second = { ...f.stored, id: "second-task" };
    f.database.task.findMany.mockResolvedValueOnce([f.stored, second].map(task => ({ ...task, project: { id: "project", ownerId: "actor", members: [] } })));
    f.tx.$queryRaw.mockImplementation(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) return [f.stored, second].map(({ id, projectId, priority, version }) => ({ id, projectId, priority, version }));
      return [{ id: "actor" }];
    });
    f.options.marker = [{ taskId: second.id, contractVersion: 1, state: "DRAFT", authorId: "author", executorId: null }];
    expect((await run(f, { priority: "CRITICAL", deadline: null }, false, [f.stored.id, second.id])).status).toBe(409); noEffects(f);
    expect(f.database.task.findMany).toHaveBeenCalledOnce();
  });
  it("keeps safe500 if diagnostic sink throws and never uses raw console fallback", async () => {
    const f = fixture(); f.options.queryFailure = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stub.error.mockImplementationOnce(() => { throw new Error("synthetic-private-sink"); });
    const response = await run(f); expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); expect(consoleError).not.toHaveBeenCalled(); noEffects(f);
  });
  it("preserves outer ADMIN outsider403 compatibility without reaching tx", async () => {
    const f = fixture(); f.options.outerRelation = "outsider";
    expect((await run(f)).status).toBe(403); expect(f.tx.$queryRaw).not.toHaveBeenCalled(); noEffects(f);
  });
  it("rechecks ADMIN membership revoked while waiting for Task lock before marker", async () => {
    const f = fixture(); f.options.relation = "member"; let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    f.options.onTaskLock = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const pending = run(f); await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    f.options.relation = "outsider"; release(); expect((await pending).status).toBe(404);
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noEffects(f);
  });
  it("uses locked priority rather than stale inventory for a no-op", async () => {
    const f = fixture(); let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(r => { entered = r; }); f.options.onTaskLock = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const pending = run(f, { priority: "HIGH" }); await waiting; f.stored.priority = "HIGH"; release();
    expect((await pending).status).toBe(200); expect(f.tx.task.update).not.toHaveBeenCalled();
  });
  it("preserves auth/rate/status validation boundaries", async () => {
    const f = fixture(); stub.session = false; expect((await run(f)).status).toBe(401); expect(stub.rate).not.toHaveBeenCalled();
    stub.session = true; stub.rate.mockRejectedValueOnce(new Error("limit")); expect((await run(f)).status).toBe(429);
    expect((await run(f, { status: "DONE" })).status).toBe(422); expect(f.database.task.findMany).not.toHaveBeenCalled(); noEffects(f);
  });
});
