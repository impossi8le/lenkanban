import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; projectId: string; priority: string; version: number };
const api = vi.hoisted(() => ({ database: {} as object, authenticated: true, role: "ADMIN", emit: vi.fn(), moved: vi.fn() }));
// Quota SQL is exercised by adjacent route.rate-limit tests; retain this
// fixture's focused transactional/receipt/rollback assertions behind admission.
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => undefined, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(api.database, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: async () => {
  if (!api.authenticated) throw new Error("Unauthorized");
  return { id: "actor", globalRole: api.role };
} }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: api.emit, emitTaskMoved: api.moved }));

import { prepareLegacyTaskScalarBatch } from "./task-command";
import { PATCH } from "@/app/api/tasks/bulk/route";

const id = (n: number) => `c${String(n).padStart(24, "0")}`;
const validMarker = (taskId: string, state: string) => ({ taskId, contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" });
function fixture(count = 2) {
  const rows: Row[] = Array.from({ length: count }, (_, i) => ({ id: id(i + 1), projectId: i % 2 ? "project-a" : "project-z", priority: "MEDIUM", version: 9 }));
  const expected = rows.map(({ id, projectId }) => ({ id, projectId })).reverse();
  const state = { rows: structuredClone(rows), activities: [] as unknown[] };
  const options = { projects: undefined as unknown, tasks: undefined as unknown, markerRows: [] as unknown,
    actor: true, role: "USER", deniedProject: "", queryFailure: false, auditFailure: false,
    onTaskLock: undefined as undefined | (() => Promise<void>), onMarker: undefined as undefined | (() => void) };
  const calls: string[] = [], lockIds: string[][] = [];
  let working = state;
  let transactionActive = false;
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...params: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "User"')) { calls.push("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }]; }
      const ids = params.flatMap(p => p && typeof p === "object" && "values" in p ? (p as { values: string[] }).values : []);
      lockIds.push(ids); expect(sql).toContain('ORDER BY "id" FOR UPDATE');
      if (sql.includes('FROM "Project"')) { calls.push("projects-lock"); return options.projects ?? [...new Set(rows.map(r => r.projectId))].sort().map(id => ({ id })); }
      if (sql.includes('FROM "Task"')) { calls.push("tasks-lock"); await options.onTaskLock?.(); return options.tasks ?? working.rows; }
      throw new Error("Unexpected query");
    }),
    user: { findUnique: vi.fn(async () => { calls.push("fresh-actor"); return options.actor ? { id: "actor", globalRole: options.role } : null; }) },
    project: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { calls.push(`access:${where.id}`); return { id: where.id, ownerId: options.deniedProject === where.id ? "outsider" : "actor", members: [] }; }) },
    taskRequest: { findMany: vi.fn(async ({ where }: { where: { taskId: { in: string[] } } }) => {
      calls.push("marker"); options.onMarker?.(); if (options.queryFailure) throw new Error("synthetic-private-storage");
      return Array.isArray(options.markerRows) ? options.markerRows.filter(row => row && typeof row === "object" && "taskId" in row ? where.taskId.in.includes(row.taskId as string) : true) : options.markerRows;
    }) },
    task: { findMany: vi.fn(async () => {
      expect(transactionActive).toBe(true);
      return working.rows.map(row => ({ ...row, project: { id: row.projectId } }));
    }), update: vi.fn(async ({ where, data }: { where: { id: string }; data: { priority: string } }) => {
      calls.push("write"); expect(Object.keys(data)).toEqual(["priority"]);
      const row = working.rows.find(r => r.id === where.id)!; Object.assign(row, data); return row;
    }) },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => { calls.push("audit"); if (options.auditFailure) throw new Error("synthetic-private-audit"); working.activities.push(data); return data; }) },
  };
  let reads = 0;
  const database = {
    task: { findMany: vi.fn(async () => { reads++; const source = reads === 1 ? rows : state.rows; return source.map(row => ({ ...row, project: { id: row.projectId, ownerId: "actor", members: [] } })); }) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state); transactionActive = true;
      try { const result = await callback(tx); Object.assign(state, working); return result; }
      finally { transactionActive = false; }
    },
  };
  const prepare = () => prepareLegacyTaskScalarBatch({ tx: tx as unknown as Prisma.TransactionClient, actorId: "actor", expectedTasks: expected });
  return { rows, expected, state, options, calls, lockIds, tx, database, prepare };
}
type Fixture = ReturnType<typeof fixture>;
function noWrites(f: Fixture) { expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(api.emit).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled(); }
beforeEach(() => { vi.clearAllMocks(); api.authenticated = true; api.role = "ADMIN"; });

describe("prepareLegacyTaskScalarBatch real preflight", () => {
  it("locks all sorted projects then all sorted tasks before actor/access/markers, deduplicates input", async () => {
    const f = fixture(); f.expected.push({ ...f.expected[0] });
    expect(await f.prepare()).toEqual(f.rows);
    expect(f.calls).toEqual(["projects-lock", "tasks-lock", "actor-lock", "fresh-actor", "access:project-a", "access:project-z", "marker"]);
    expect(f.lockIds).toEqual([["project-a", "project-z"], [id(1), id(2)]]);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(3); noWrites(f);
  });
  it("snapshots caller identity before await and returns copied locked rows", async () => {
    const f = fixture(); f.options.tasks = f.rows;
    f.options.onTaskLock = async () => { f.expected[0].projectId = "mutated-caller"; };
    f.options.onMarker = () => { f.rows[0].priority = "HIGH"; };
    const result = await f.prepare(); expect(result[0].priority).toBe("MEDIUM");
    result[0].priority = "LOW"; expect(f.rows[0].priority).toBe("HIGH");
  });
  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"])("denies last marked %s target for ADMIN before mutation", async state => {
    const f = fixture(); f.options.role = "ADMIN"; f.options.markerRows = [validMarker(id(2), state)];
    await expect(f.prepare()).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); noWrites(f);
  });
  it.each([undefined, {}, [null], [{ taskId: id(2) }], [{ ...validMarker(id(2), "DRAFT"), extra: "private" }]].map(value => ({ value })))("fails closed malformed batch %#", async ({ value }) => {
    const f = fixture(); f.options.markerRows = value;
    // undefined is an actual malformed query result, not a missing option/default.
    f.tx.taskRequest.findMany.mockImplementationOnce(async () => { f.calls.push("marker"); return value; });
    await expect(f.prepare()).rejects.toMatchObject({ code: "INVALID_REQUEST_MARKER" }); noWrites(f);
  });
  it.each(["query", "delegate"])("propagates storage %s failure", async mode => {
    const f = fixture(); if (mode === "query") f.options.queryFailure = true; else Reflect.deleteProperty(f.tx, "taskRequest");
    await expect(f.prepare()).rejects.toThrow(); expect(f.calls).toContain("fresh-actor"); noWrites(f);
  });
  it.each(["projects", "tasks", "actor", "access"])("denies missing/revoked %s before marker", async mode => {
    const f = fixture(); if (mode === "projects") f.options.projects = []; if (mode === "tasks") f.options.tasks = [];
    if (mode === "actor") f.options.actor = false; if (mode === "access") f.options.deniedProject = "project-z";
    await expect(f.prepare()).rejects.toMatchObject({ name: "NotFoundError" }); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noWrites(f);
  });
  it.each(["drift", "duplicate", "extra", "version", "getter"])("rejects invalid locked row %s", async mode => {
    const f = fixture(); const changed = { ...f.rows[0] };
    if (mode === "drift") changed.projectId = "changed-project";
    if (mode === "version") changed.version = NaN;
    if (mode === "getter") Object.defineProperty(changed, "priority", { get: () => { throw new Error("getter must not execute"); }, enumerable: true });
    f.options.tasks = mode === "duplicate" ? [changed, changed] : mode === "extra" ? [{ ...changed, private: "secret" }, f.rows[1]] : [changed, f.rows[1]];
    if (mode === "drift") await expect(f.prepare()).rejects.toMatchObject({ code: "IDENTITY_CHANGED" }); else await expect(f.prepare()).rejects.toThrow("Invalid locked task batch");
    expect(f.tx.user.findUnique).not.toHaveBeenCalled(); noWrites(f);
  });
  it("waits for all Task locks before fresh role/access check", async () => {
    const f = fixture(); f.options.role = "ADMIN"; let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    f.options.onTaskLock = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const result = f.prepare().then(() => null, (error: unknown) => error);
    await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    f.options.role = "USER"; f.options.deniedProject = "project-z"; release();
    expect(await result).toMatchObject({ name: "NotFoundError" }); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noWrites(f);
  });
  it("checks 201 targets in bounded marker queries, with no board-size cap", async () => {
    const f = fixture(201); expect(await f.prepare()).toHaveLength(201);
    expect(f.tx.taskRequest.findMany.mock.calls.map(([arg]) => arg.where.taskId.in.length)).toEqual([200, 1]);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(3);
  });
  it("still guards target201 across service query chunks before writes", async () => {
    const f = fixture(201); f.options.markerRows = [validMarker(id(201), "DRAFT")];
    await expect(f.prepare()).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); noWrites(f);
    expect(f.tx.taskRequest.findMany.mock.calls.map(([arg]) => arg.where.taskId.in.length)).toEqual([200, 1]);
  });
});

function route(f: Fixture, taskIds = f.rows.map(r => r.id), updates: object = { priority: "HIGH" }) {
  api.database = f.database;
  return PATCH(new Request("http://localhost/api/tasks/bulk", { method: "PATCH", body: JSON.stringify({ taskIds, updates }) }));
}
describe("actual priority-only bulk PATCH", () => {
  it.each([false, true])("preserves envelope and duplicate-input compatibility (duplicate=%s)", async duplicate => {
    const f = fixture(); const ids = f.rows.map(r => r.id); if (duplicate) ids.push(ids[0]);
    const response = await route(f, ids); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { success: true, updatedCount: 2 } });
    expect(f.tx.task.update).toHaveBeenCalledTimes(2); expect(f.state.activities).toHaveLength(2); expect(f.state.rows.every(r => r.version === 9)).toBe(true);
    expect(f.calls.indexOf("write")).toBeGreaterThan(f.calls.lastIndexOf("marker")); expect(api.emit).toHaveBeenCalledTimes(2);
  });
  it.each(["HIGH", "LOW"])("uses locked priority %s instead of pretransaction MEDIUM", async current => {
    const f = fixture(1); f.state.rows[0].priority = current;
    const response = await route(f); expect(response.status).toBe(200);
    expect(f.tx.task.update).toHaveBeenCalledTimes(current === "HIGH" ? 0 : 1);
    expect(f.state.activities).toEqual(current === "HIGH" ? [] : [expect.objectContaining({ oldValue: { priority: "LOW" }, newValue: { priority: "HIGH" } })]);
  });
  it.each([false, true])("rejects last marked target atomically even when earlier priority is noop=%s", async noop => {
    const f = fixture(); if (noop) f.state.rows[0].priority = "HIGH";
    f.options.markerRows = [validMarker(id(2), "IN_PROGRESS")];
    const before = structuredClone(f.state); const response = await route(f); expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/authorId|executorId|private/); expect(f.state).toEqual(before); noWrites(f);
  });
  it("guards target200 at the accepted request bound before any earlier target can be written", async () => {
    const f = fixture(200); f.options.markerRows = [validMarker(id(200), "DRAFT")];
    expect((await route(f)).status).toBe(409); noWrites(f);
    expect(f.tx.taskRequest.findMany.mock.calls.map(([arg]) => arg.where.taskId.in.length)).toEqual([200]);
  });
  it("uses a priority changed during Task lock wait for Activity oldValue", async () => {
    const f = fixture(1); let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    f.options.tasks = f.rows;
    f.options.onTaskLock = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const pending = route(f); await waiting;
    expect(f.tx.task.update).not.toHaveBeenCalled(); f.rows[0].priority = "LOW"; release();
    expect((await pending).status).toBe(200);
    expect(f.state.activities).toEqual([expect.objectContaining({ oldValue: { priority: "LOW" }, newValue: { priority: "HIGH" } })]);
  });
  it.each(["malformed", "storage", "access", "identity", "unauthenticated"])("maps %s without partial write/effects", async mode => {
    const f = fixture(); let status = 409;
    if (mode === "malformed") f.options.markerRows = [{ taskId: id(2) }];
    if (mode === "storage") { f.options.queryFailure = true; status = 500; }
    if (mode === "access") { f.options.deniedProject = "project-z"; status = 404; }
    if (mode === "identity") f.options.tasks = [{ ...f.rows[0], projectId: "different" }, f.rows[1]];
    if (mode === "unauthenticated") { api.authenticated = false; status = 401; }
    const response = await route(f); expect(response.status).toBe(status); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); noWrites(f);
  });
  it("does not turn audit failure into a committed partial bulk result", async () => {
    const f = fixture(); const before = structuredClone(f.state); f.options.auditFailure = true;
    expect((await route(f)).status).toBe(500); expect(f.state).toEqual(before); expect(api.emit).not.toHaveBeenCalled();
  });
  it("retains status-only 422 validation before auth or database work", async () => {
    const f = fixture(); expect((await route(f, f.rows.map(r => r.id), { status: "DONE" })).status).toBe(422);
    expect(f.database.task.findMany).not.toHaveBeenCalled(); expect(f.tx.$queryRaw).not.toHaveBeenCalled(); noWrites(f);
  });
});
