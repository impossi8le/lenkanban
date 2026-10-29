import { beforeEach, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
const boundary = vi.hoisted(() => ({ db: {} as object, auth: vi.fn(), read: vi.fn(), load: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(boundary.db, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: boundary.auth, UnauthorizedError }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: boundary.read }));
vi.mock("@/lib/project-status-policy", () => ({ lockProjectStatusAuthority: async () => {} }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: boundary.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: boundary.emit }));
import { POST, DELETE, GET } from "./route";
const context = { params: Promise.resolve({ id: "task" }) };
function request(method = "POST", body: unknown = { userId: "target" }) { return new Request("http://localhost/api/tasks/task/messages/watchers", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
function fixture() {
  const options = { outer: true, readable: true, blocked: false, actor: true, role: "USER" as "USER" | "ADMIN", personal: false, author: "author", executor: "executor" as string | null, departmentLeader: false, groupLeader: false,
    state: "IN_PROGRESS", deleted: false, malformed: false, legacy: false, identity: false, cas: true, activityFailure: false, commitFailure: false, mutationFailure: false, missingTable: false, targetActive: true, groupActive: true, emptyGroup: false,
    groupUsers: ["target", "other"] as string[] };
  const state = { watchers: [] as string[], version: 3, activities: [] as object[] }; let working = structuredClone(state); const trace: string[] = [];
  function task() { return { id: "task", projectId: "project", request: options.legacy ? null : { taskId: "task", contractVersion: options.malformed ? 2 : 1, state: options.state,
    authorId: options.author, executorId: options.executor, needsInfoSince: null, pausedTotalMs: 0, deletedAt: options.deleted ? new Date() : null, audienceUserIds: options.personal ? ["selected"] : [] },
    project: { department: { archivedAt: null, leaderId: options.departmentLeader ? "actor" : null }, responsibleGroup: { archivedAt: null, leaderId: options.groupLeader ? "actor" : null, members: [{ userId: "actor" }] } } }; }
  const watcher = {
    findMany: vi.fn(async ({ where }: { where: { userId?: { in: string[] } } }) => { if (options.missingTable) throw Object.assign(Error("synthetic"), { code: "P2021" }); return working.watchers.filter(id => !where.userId || where.userId.in.includes(id)).map(userId => ({ userId, user: { name: "Name " + userId } })); }),
    createMany: vi.fn(async ({ data }: { data: { userId: string }[] }) => { trace.push("write"); if (options.mutationFailure) throw Error("synthetic"); let count = 0; for (const row of data) if (!working.watchers.includes(row.userId)) { working.watchers.push(row.userId); count++; } return { count }; }),
    deleteMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => { trace.push("write"); const before = working.watchers.length; working.watchers = working.watchers.filter(id => !where.userId.in.includes(id)); return { count: before - working.watchers.length }; }),
  };
  const user = { findUnique: vi.fn(async () => options.actor ? { id: "actor", globalRole: options.role, isBlocked: options.blocked, blockedAt: null } : null),
    findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => options.targetActive ? (where.id?.in ?? ["target"]).map(id => ({ id, name: "Name " + id, primaryDepartment: { name: "Department" } })) : []) };
  const responsibleGroup = { findMany: vi.fn(async ({ select }: { select: { members?: unknown } }) => options.groupActive ? [{ id: "group", name: "Group", members: (options.emptyGroup ? [] : options.groupUsers).map(userId => ({ userId })), _count: { members: options.groupUsers.length } }].map(row => select.members ? row : { id: row.id, name: row.name, _count: row._count }) : []) };
  const tx = { user, responsibleGroup, taskWatcher: watcher,
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => { const sql = strings.join("?");
      if (sql.includes('FROM "Project"')) { trace.push("project-lock"); return [{ id: "project" }]; }
      if (sql.includes('FROM "Task"')) { trace.push("task-lock"); return [{ id: "task", projectId: options.identity ? "foreign" : "project", version: working.version }]; }
      if (sql.includes('FROM "Department"')) { trace.push("department-lock"); return []; }
      if (sql.includes('FROM "ResponsibleGroupMember"')) { trace.push("membership-lock"); expect(sql).toContain("FOR SHARE OF gm, u"); return (options.emptyGroup ? [] : options.groupUsers).map(userId => ({ userId })); }
      if (sql.includes('FROM "ResponsibleGroup"')) return options.groupActive ? [{ id: "group" }] : [];
      if (sql.includes('TaskWatcher') && options.missingTable) throw Object.assign(Error("synthetic"), { code: "P2021" });
      return [];
    }),
    task: { findFirst: vi.fn(async () => { trace.push("fresh-read"); return options.readable ? task() : null; }), updateMany: vi.fn(async () => { if (!options.cas) return { count: 0 }; working.version++; return { count: 1 }; }) },
    activity: { create: vi.fn(async ({ data }: { data: object }) => { if (options.activityFailure) throw Error("synthetic"); working.activities.push(data); return data; }) },
  };
  const db = { user, responsibleGroup, taskWatcher: watcher, task: { findFirst: vi.fn(async () => options.outer ? task() : null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => { working = structuredClone(state); const result = await callback(tx); if (options.commitFailure) throw Error("synthetic"); Object.assign(state, working); return result; }) };
  boundary.db = db;
  return { options, state, tx, db, trace };
}
beforeEach(() => { vi.resetAllMocks(); boundary.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); boundary.read.mockImplementation(async (_actor, where) => ({ AND: [where, { persistedSharedRead: true }] })); boundary.load.mockResolvedValue({ id: "task", projectId: "project" }); });
it("adds people and current group members once, without changing audience/executor, with one batch version", async () => {
  const f = fixture(); f.options.personal = true; f.options.author = "actor";
  const response = await POST(request("POST", { userIds: ["target", "target"], groupIds: ["group"] }), context);
  expect(response.status).toBe(201); expect((await response.json()).data).toEqual({ userIds: ["other", "target"], added: 2 });
  expect(f.state.watchers).toEqual(["other", "target"]); expect(f.state.version).toBe(4); expect(f.state.activities).toHaveLength(2);
  expect(f.tx.taskWatcher.createMany).toHaveBeenCalledOnce(); expect(f.tx.task.updateMany).toHaveBeenCalledOnce(); expect(boundary.emit).toHaveBeenCalledOnce();
  expect(f.options.executor).toBe("executor"); expect(f.options.personal).toBe(true);
  expect(f.trace.indexOf("project-lock")).toBeLessThan(f.trace.indexOf("task-lock")); expect(f.trace.indexOf("fresh-read")).toBeLessThan(f.trace.indexOf("write"));
  expect(f.trace.indexOf("department-lock")).toBeLessThan(f.trace.indexOf("fresh-read")); expect(f.trace.indexOf("membership-lock")).toBeLessThan(f.trace.indexOf("write"));
  expect(boundary.read).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "actor" }), { id: "task" }, f.tx);
});
it.each(["author", "executor", "department", "group", "admin"])("permits personal management by %s", async kind => {
  const f = fixture(); f.options.personal = true;
  if (kind === "author") f.options.author = "actor"; if (kind === "executor") f.options.executor = "actor"; if (kind === "department") f.options.departmentLeader = true;
  if (kind === "group") f.options.groupLeader = true; if (kind === "admin") { f.options.role = "ADMIN"; boundary.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" }); }
  expect((await POST(request(), context)).status).toBe(201);
});
it("does not let a read-only personal watcher or selected reader grant access", async () => { const f = fixture(); f.options.personal = true; expect((await POST(request(), context)).status).toBe(403); expect(f.tx.taskWatcher.createMany).not.toHaveBeenCalled(); });
it("allows a personal watcher to remove self but not other people", async () => { const f = fixture(); f.options.personal = true; f.state.watchers = ["actor", "target"];
  expect((await DELETE(request("DELETE"), context)).status).toBe(403);
  expect((await DELETE(request("DELETE", { userId: "actor" }), context)).status).toBe(200); expect(f.state.watchers).toEqual(["target"]);
});
it("relation retries add no duplicate activity/version, and remove is idempotent", async () => { const f = fixture(); await POST(request(), context); await POST(request(), context); expect(f.state.version).toBe(4); expect(f.state.activities).toHaveLength(1); await DELETE(request("DELETE"), context); await DELETE(request("DELETE"), context); expect(f.state.version).toBe(5); expect(f.state.activities).toHaveLength(2); });
it.each(["cas", "activity", "commit", "write"])("rolls back the whole group on %s failure", async reason => { const f = fixture(); if (reason === "cas") f.options.cas = false; if (reason === "activity") f.options.activityFailure = true; if (reason === "commit") f.options.commitFailure = true; if (reason === "write") f.options.mutationFailure = true;
  expect((await POST(request("POST", { groupIds: ["group"] }), context)).status).toBe(reason === "cas" ? 409 : 500); expect(f.state).toEqual({ watchers: [], version: 3, activities: [] });
});
it.each(["inactive", "empty", "tooLarge", "blockedTarget"])("rejects %s group selection without a partial write", async reason => { const f = fixture(); if (reason === "inactive") f.options.groupActive = false; if (reason === "empty") f.options.emptyGroup = true; if (reason === "tooLarge") f.options.groupUsers = Array.from({ length: 201 }, (_, i) => "user-" + i); if (reason === "blockedTarget") f.options.targetActive = false;
  expect((await POST(request("POST", { groupIds: ["group"] }), context)).status).toBe(422); expect(f.tx.taskWatcher.createMany).not.toHaveBeenCalled();
});
it.each(["blocked", "missing", "revoked", "deleted", "draft", "malformed", "identity"])("revalidates %s before writing", async reason => { const f = fixture(); if (reason === "blocked") f.options.blocked = true; if (reason === "missing") f.options.actor = false; if (reason === "revoked") f.options.readable = false; if (reason === "deleted") f.options.deleted = true; if (reason === "draft") { f.options.state = "DRAFT"; f.options.executor = null; } if (reason === "malformed") f.options.malformed = true; if (reason === "identity") f.options.identity = true;
  expect((await POST(request(), context)).status).toBe(["identity", "malformed"].includes(reason) ? 409 : reason === "draft" ? 422 : 404); expect(f.tx.taskWatcher.createMany).not.toHaveBeenCalled();
});
it("conceals unreadable tasks before entering a transaction", async () => { const f = fixture(); f.options.outer = false; expect((await POST(request(), context)).status).toBe(404); expect(f.db.$transaction).not.toHaveBeenCalled(); });
it("keeps legacy task version unchanged", async () => { const f = fixture(); f.options.legacy = true; await POST(request(), context); expect(f.state.version).toBe(3); expect(f.state.activities).toHaveLength(1); });
it("does not replace a committed result if realtime fails", async () => { const f = fixture(); boundary.load.mockRejectedValue(Error("synthetic")); expect((await POST(request(), context)).status).toBe(201); expect(f.state.watchers).toEqual(["target"]); });
it("returns names/canManage without unrelated user fields", async () => { const f = fixture(); f.state.watchers.push("target"); await POST(request(), context); const response = await GET(new Request("http://localhost"), context); expect((await response.json()).data).toEqual({ items: [{ userId: "target", name: "Name target" }], canManage: true }); expect(response.headers.get("cache-control")).toBe("no-store"); });
it("bounds active people/groups candidates and conceals them from a read-only personal watcher", async () => { const f = fixture(); const response = await GET(new Request("http://localhost?view=candidates&search=Target"), context); expect(response.status).toBe(200); const data = (await response.json()).data; expect(data.users).toEqual([{ id: "target", name: "Name target", departmentName: "Department" }]); expect(data.groups).toEqual([{ id: "group", name: "Group", memberCount: 2 }]); expect(f.tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, where: { isBlocked: false, blockedAt: null, name: { contains: "Target", mode: "insensitive" } } }));
  f.options.personal = true; expect((await GET(new Request("http://localhost?view=candidates"), context)).status).toBe(403);
});
it.each([{}, { userIds: [] }, { userIds: ["target"], memberIds: ["forged"] }, { groupIds: Array(21).fill("group") }, { userId: "" }])("validates before auth %#", async body => { fixture(); expect((await POST(request("POST", body), context)).status).toBe(422); expect(boundary.auth).not.toHaveBeenCalled(); });
it.each([POST, DELETE])("preserves invalid JSON", async handler => { fixture(); expect((await handler(new Request("http://localhost", { method: "POST", body: "{" }), context)).status).toBe(400); });
it.each([new UnauthorizedError(), new ForbiddenError()])("preserves auth failure %#", async error => { fixture(); boundary.auth.mockRejectedValue(error); expect((await POST(request(), context)).status).toBe(error instanceof ForbiddenError ? 403 : 401); });
it("reports missing watcher storage explicitly", async () => { const f = fixture(); f.options.missingTable = true; expect((await POST(request(), context)).status).toBe(503); });
