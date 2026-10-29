import { beforeEach, describe, expect, it, vi } from "vitest";

// Use real project access for both permitted mutations and revoked-access denials.
const runtime = vi.hoisted(() => ({ database: {} as object, authenticated: true, role: "ADMIN", notify: vi.fn(), automation: vi.fn(), load: vi.fn(), emit: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError, requireApiUser: async () => { if (!runtime.authenticated) throw new UnauthorizedError(); return { id: "actor", globalRole: runtime.role, name: "Actor", email: "actor@example.test" }; } };
});
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskAssigned: runtime.notify }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: runtime.automation }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: runtime.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: runtime.emit }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: runtime.warn }, dbLogger: { error: vi.fn() } }));

import { PUT } from "./route";

const people = ["old", "new", "another", "owner"].map(id => ({ id, name: `Name-${id}`, email: `${id}@example.test`, avatarUrl: null }));
function fixture(taskId = "task") {
  const state = { assignees: ["old"], activities: [] as unknown[], version: 7, title: "Committed current title" };
  let working = state;
  const options = { marker: [] as unknown, actor: true, role: "USER", access: true, support: true, project: true, task: true, drift: false,
    members: ["old", "new", "another"], eligibleOwner: true, outerAccess: true, outerTask: true, outerEligibility: true,
    storageFailure: false, auditFailure: false, snapshotMissing: false, onTaskLock: undefined as undefined | (() => Promise<void>) };
  const calls: string[] = [];
  const owner = (ids: string[], allowed = true) => allowed && ids.includes("owner") ? { ownerId: "owner" } : null;
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('JOIN "ResponsibleGroup"')) return options.support ? [{ id: "group", userId: "actor" }] : [];
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); return options.project ? [{ id: "project" }] : []; }
      if (sql.includes('FROM "Task"')) { calls.push("task-lock"); await options.onTaskLock?.(); return options.task ? [{ id: taskId, projectId: options.drift ? "different" : "project", priority: "MEDIUM", version: 7 }] : []; }
      calls.push("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }];
    }),
    user: {
      findUnique: vi.fn(async () => { calls.push("fresh-actor"); return options.actor ? { id: "actor", globalRole: options.role } : null; }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => people.filter(person => where.id.in.includes(person.id))),
    },
    project: {
      findUnique: vi.fn(async () => { calls.push("access"); return { id: "project", ownerId: "owner", members: options.access ? [{ role: "MEMBER" }] : [] }; }),
      findFirst: vi.fn(async ({ where }: { where: { ownerId: { in: string[] } } }) => { calls.push("eligible-owner"); return owner(where.ownerId.in, options.eligibleOwner); }),
    },
    projectMember: { findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => { calls.push("eligible-members"); return options.members.filter(id => where.userId.in.includes(id)).map(userId => ({ userId })); }) },
    taskRequest: { findMany: vi.fn(async () => { calls.push("marker"); if (options.storageFailure) throw new Error("synthetic-private-storage"); return options.marker; }) },
    taskAssignee: {
      findMany: vi.fn(async () => { calls.push("current-assignees"); return working.assignees.map(userId => ({ userId, user: { ...people.find(person => person.id === userId)! } })); }),
      deleteMany: vi.fn(async () => { calls.push("delete"); working.assignees = []; }),
      createMany: vi.fn(async ({ data }: { data: { taskId: string; userId: string }[] }) => { calls.push("create"); working.assignees = data.map(item => item.userId); }),
    },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => { calls.push("audit"); if (options.auditFailure) throw new Error("synthetic-private-audit"); working.activities.push(data); }) },
    task: { findUnique: vi.fn(async () => { calls.push("snapshot"); return options.snapshotMissing ? null : { id: taskId, projectId: "project", project: { id: "project" }, version: working.version, title: working.title, assignees: working.assignees.map(userId => ({ userId, user: { ...people.find(person => person.id === userId)! } })), tags: [], checklistItems: [] }; }) },
  };
  const database = {
    task: { findUnique: vi.fn(async () => options.outerTask ? { id: taskId, projectId: "project", title: "Stale outer title", project: { id: "project", ownerId: "owner" } } : null) },
    projectMember: {
      findFirst: vi.fn(async () => options.outerAccess ? { userId: "actor" } : null),
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => options.outerEligibility ? ["old", "new", "another"].filter(id => where.userId.in.includes(id)).map(userId => ({ userId })) : []),
    },
    project: { findFirst: vi.fn(async ({ where }: { where: { ownerId: { in: string[] } } }) => owner(where.ownerId.in, options.outerEligibility)) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => { working = structuredClone(state); const result = await callback(tx); Object.assign(state, working); calls.push("commit"); return result; },
  };
  const invoke = (userIds: unknown = ["new"]) => { runtime.database = database; return PUT(new Request("http://localhost/api/tasks/task/assignees", { method: "PUT", body: JSON.stringify({ userIds }) }), { params: Promise.resolve({ id: taskId }) }); };
  return { state, options, calls, tx, database, invoke };
}
type Fixture = ReturnType<typeof fixture>;
const marker = (taskId: string, state = "DRAFT") => ({ taskId, contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" });
function noEffects(f: Fixture) {
  expect(f.tx.taskAssignee.findMany).not.toHaveBeenCalled(); expect(f.tx.taskAssignee.deleteMany).not.toHaveBeenCalled(); expect(f.tx.taskAssignee.createMany).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled();
  expect(runtime.notify).not.toHaveBeenCalled(); expect(runtime.automation).not.toHaveBeenCalled(); expect(runtime.load).not.toHaveBeenCalled(); expect(runtime.emit).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.authenticated = true; runtime.role = "ADMIN";
  runtime.notify.mockResolvedValue(undefined); runtime.automation.mockResolvedValue(undefined); runtime.load.mockResolvedValue({ project: { id: "project" } }); runtime.emit.mockResolvedValue(undefined); runtime.warn.mockImplementation(() => {});
});

describe("actual guarded legacy assignee PUT", () => {
  it("denies an ordinary board member assigning themselves or anyone else", async () => {
    const f = fixture(); f.options.support = false; runtime.role = "USER";
    expect((await f.invoke(["new"])).status).toBe(404);
    noEffects(f);
    expect(f.tx.taskAssignee.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.projectMember.findMany).not.toHaveBeenCalled();
  });
  it("denies revoked project membership before assignee children with real access", async () => {
    const f = fixture(); const before = structuredClone(f.state);
    f.options.access = false;
    expect((await f.invoke()).status).toBe(404);
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
    noEffects(f); expect(f.state).toEqual(before);
  });
  it("guards before requested membership/current links and commits precise history and fresh DTO/title", async () => {
    const f = fixture(); runtime.notify.mockImplementation(async () => { expect(f.calls).toContain("commit"); });
    const response = await f.invoke(); expect(response.status).toBe(200);
    expect(f.calls.slice(0, 9)).toEqual(["project-lock", "task-lock", "actor-lock", "fresh-actor", "access", "marker", "eligible-members", "eligible-owner", "current-assignees"]);
    expect(f.state.activities).toEqual([
      expect.objectContaining({ action: "assigned", newValue: { assigneeId: "new", assigneeName: "Name-new" } }),
      expect.objectContaining({ action: "unassigned", oldValue: { assigneeId: "old", assigneeName: "Name-old" } }),
    ]);
    expect((await response.json()).data).toMatchObject({ title: "Committed current title", version: 7, assignees: [{ userId: "new" }] });
    expect(runtime.notify).toHaveBeenCalledWith(expect.objectContaining({ taskTitle: "Committed current title", projectId: "project", assigneeId: "new" }));
    expect(f.database.task.findUnique).toHaveBeenCalledOnce(); expect(f.calls.indexOf("snapshot")).toBeLessThan(f.calls.indexOf("commit"));
  });
  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"])("denies %s even for current ADMIN before tx child checks", async state => {
    const f = fixture(); f.options.role = "ADMIN"; f.options.marker = [marker("task", state)];
    const response = await f.invoke(); expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toMatch(/authorId|executorId|synthetic-private/);
    expect(f.tx.projectMember.findMany).not.toHaveBeenCalled(); expect(f.tx.project.findFirst).not.toHaveBeenCalled(); noEffects(f);
  });
  it.each([undefined, {}, [null], [{ ...marker("task"), contractVersion: 2 }]].map(value => ({ value })))("rejects malformed marker result %#", async ({ value }) => {
    const f = fixture(); f.options.marker = value; expect((await f.invoke()).status).toBe(409); noEffects(f);
  });
  it.each(["query", "delegate"])("fails closed on storage %s", async mode => {
    const f = fixture(); if (mode === "query") f.options.storageFailure = true; else Reflect.deleteProperty(f.tx, "taskRequest");
    const response = await f.invoke(); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); noEffects(f);
  });
  it.each([[], ["old"]].map(ids => ({ ids })))("guards clear/noop $ids", async ({ ids }) => {
    const f = fixture(); f.options.marker = [marker("task")]; expect((await f.invoke(ids)).status).toBe(409); noEffects(f);
  });
  it("preserves noop without writes/history/new assignment effects", async () => {
    const f = fixture(); expect((await f.invoke(["old", "old"])).status).toBe(200);
    expect(f.tx.taskAssignee.deleteMany).not.toHaveBeenCalled(); expect(f.tx.taskAssignee.createMany).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled(); expect(runtime.automation).not.toHaveBeenCalled(); expect(runtime.emit).toHaveBeenCalledOnce();
  });
  it("preserves legacy multiple owner/member assignments, dedup and version", async () => {
    const f = fixture("задача / legacy"); expect((await f.invoke(["owner", "new", "another", "new"])).status).toBe(200);
    expect(f.state.assignees).toEqual(["owner", "new", "another"]); expect(f.state.version).toBe(7); expect(runtime.notify).toHaveBeenCalledTimes(3); expect(f.state.activities).toHaveLength(4);
    expect(f.tx.taskAssignee.createMany).toHaveBeenCalledWith({ data: ["owner", "new", "another"].map(userId => ({ taskId: "задача / legacy", userId })) });
  });
  it("clears current assignees with only unassignment audit", async () => {
    const f = fixture(); expect((await f.invoke([])).status).toBe(200); expect(f.state.assignees).toEqual([]); expect(f.tx.taskAssignee.createMany).not.toHaveBeenCalled(); expect(f.state.activities).toHaveLength(1); expect(runtime.notify).not.toHaveBeenCalled(); expect(runtime.automation).not.toHaveBeenCalled();
  });
  it.each(["actor", "access", "project", "task", "drift"] as const)("denies fresh %s before marker/children", async field => {
    const f = fixture(); if (field === "drift") f.options.drift = true; else f.options[field] = false;
    expect((await f.invoke()).status).toBe(field === "drift" ? 409 : 404); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noEffects(f);
  });
  it.each(["access", "member", "owner"])("rechecks %s revoked while waiting for resource locks", async mode => {
    const f = fixture(); let entered!: () => void; let release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.options.onTaskLock = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const pending = f.invoke(mode === "owner" ? ["owner"] : ["new"]); await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    if (mode === "access") f.options.access = false; if (mode === "member") f.options.members = []; if (mode === "owner") f.options.eligibleOwner = false;
    release(); expect((await pending).status).toBe(mode === "access" ? 404 : 400); noEffects(f);
  });
  it("uses fresh current assignments rather than stale prior state", async () => {
    const f = fixture(); f.state.assignees = ["another"]; expect((await f.invoke(["old"])).status).toBe(200);
    expect(f.state.activities).toEqual([expect.objectContaining({ action: "assigned", newValue: { assigneeId: "old", assigneeName: "Name-old" } }), expect.objectContaining({ action: "unassigned", oldValue: { assigneeId: "another", assigneeName: "Name-another" } })]);
  });
  it.each(["audit", "snapshot"])("discards fake tx working state after mandatory %s failure", async failure => {
    const f = fixture(); const before = structuredClone(f.state); if (failure === "audit") f.options.auditFailure = true; else f.options.snapshotMissing = true;
    expect((await f.invoke()).status).toBe(failure === "audit" ? 500 : 404); expect(f.state).toEqual(before); expect(runtime.notify).not.toHaveBeenCalled(); expect(runtime.automation).not.toHaveBeenCalled(); expect(runtime.load).not.toHaveBeenCalled();
  });
  it.each(["notify-sync", "notify-async", "automation-sync", "automation-async", "load", "emit-sync", "emit-async", "logger"])("keeps committed200 and other effects on %s failure", async failure => {
    const f = fixture(); const error = new Error("synthetic-private-delivery");
    if (failure === "notify-sync") runtime.notify.mockImplementationOnce(() => { throw error; });
    if (failure === "notify-async") runtime.notify.mockRejectedValueOnce(error);
    if (failure === "automation-sync") runtime.automation.mockImplementation(() => { throw error; });
    if (failure === "automation-async") runtime.automation.mockRejectedValue(error);
    if (failure === "load") runtime.load.mockRejectedValue(error);
    if (failure === "emit-sync") runtime.emit.mockImplementation(() => { throw error; });
    if (failure === "emit-async" || failure === "logger") runtime.emit.mockRejectedValue(error);
    if (failure === "logger") runtime.warn.mockImplementation(() => { throw error; });
    const response = await f.invoke(["new", "another"]); expect(response.status).toBe(200); expect(f.state.activities).toHaveLength(3);
    expect(runtime.notify).toHaveBeenCalledTimes(2); expect(runtime.automation).toHaveBeenCalledOnce(); expect(runtime.load).toHaveBeenCalledOnce();
    if (failure !== "load") expect(runtime.emit).toHaveBeenCalledOnce();
  });
  it("drops crossproject realtime payload", async () => {
    const f = fixture(); runtime.load.mockResolvedValue({ project: { id: "different" } }); expect((await f.invoke()).status).toBe(200); expect(runtime.emit).not.toHaveBeenCalled(); expect(runtime.notify).toHaveBeenCalledOnce();
  });
  it("isolates response from automation top-level and nested mutations during deferred delivery", async () => {
    const f = fixture(); let entered!: () => void; let release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    runtime.load.mockImplementation(() => { entered(); return new Promise(resolve => { release = () => resolve(null); }); });
    runtime.automation.mockImplementation(async (event: { task: { title: string; version: number; assignees: { user: { name: string } }[] } }) => { event.task.title = "mutated"; event.task.version = 99; event.task.assignees[0].user.name = "mutated"; });
    const pending = f.invoke(); await waiting; release(); const response = await pending;
    expect((await response.json()).data).toMatchObject({ title: "Committed current title", version: 7, assignees: [{ user: { name: "Name-new" } }] });
  });
  it.each(["unauthenticated", "schema", "outer-access", "outer-eligibility", "missing"])("retains external %s validation/access", async mode => {
    const f = fixture(); if (mode === "unauthenticated") runtime.authenticated = false;
    if (mode === "outer-access") { runtime.role = "USER"; f.options.outerAccess = false; }
    if (mode === "outer-eligibility") f.options.outerEligibility = false; if (mode === "missing") f.options.outerTask = false;
    const response = await f.invoke(mode === "schema" ? [1] : ["new"]);
    expect(response.status).toBe(mode === "schema" ? 422 : mode === "unauthenticated" ? 401 : mode === "outer-access" ? 403 : mode === "missing" ? 404 : 400); expect(f.tx.$queryRaw).not.toHaveBeenCalled(); noEffects(f);
  });
});
