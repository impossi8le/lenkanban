import { evaluateLegacyProjectAccess } from "@/lib/access-policy";
import { getProjectAccess } from "@/lib/project-access";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the isolated legacy writer preflight through its legacy access seam.
// The real project-access denial is checked separately below.
vi.mock("@/lib/project-access", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/project-access")>();
  return { ...actual, getProjectAccess: vi.fn(async (...args: Parameters<typeof actual.getProjectAccess>) => {
    const [actor, projectId, database] = args;
    if (actor.globalRole === "ADMIN") return actual.getProjectAccess(...args);
    const project = await database!.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true, members: { where: { userId: actor.id }, select: { role: true }, take: 1 } },
    });
    const access = evaluateLegacyProjectAccess(actor, project ? {
      ownerId: project.ownerId, membershipRole: project.members[0]?.role ?? null,
    } : null);
    return { projectId, canRead: access.canRead.allowed, canWrite: access.canWrite.allowed, canManageMembers: access.canManageMembers.allowed };
  }) };
});
const runtime = vi.hoisted(() => ({ database: {} as object, authenticated: true, role: "ADMIN", automation: vi.fn(), load: vi.fn(), emit: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: async () => {
  if (!runtime.authenticated) throw new Error("Unauthorized");
  return { id: "actor", globalRole: runtime.role };
} }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: runtime.automation }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: runtime.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: runtime.emit }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: runtime.warn }, dbLogger: { error: vi.fn() } }));

import { PUT } from "./route";

const tagId = (n: number) => `c${String(n).padStart(24, "0")}`;
const tags = [1, 2, 3].map(n => ({ id: tagId(n), projectId: "project", name: `synthetic-private-tag-${n}` }));
const marker = (taskId: string, state = "DRAFT") => ({ taskId, contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" });
function fixture(taskId = "task") {
  const state = { tagIds: [tagId(1)], activities: [] as unknown[], version: 9 };
  let working = state;
  const options = { markerRows: [] as unknown, actor: true, role: "USER", access: true, project: true, task: true, drift: false,
    outerAccess: true, outerTask: true, storageFailure: false, auditFailure: false, snapshotMissing: false,
    onTaskLock: undefined as undefined | (() => Promise<void>) };
  const calls: string[] = [];
  const links = (ids: string[]) => ids.map(id => ({ taskId, tag: { ...tags.find(tag => tag.id === id)! } }));
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); return options.project ? [{ id: "project" }] : []; }
      if (sql.includes('FROM "Task"')) { calls.push("task-lock"); await options.onTaskLock?.(); return options.task ? [{ id: taskId, projectId: options.drift ? "other-project" : "project", priority: "MEDIUM", version: 9 }] : []; }
      calls.push("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => { calls.push("fresh-actor"); return options.actor ? { id: "actor", globalRole: options.role } : null; }) },
    project: { findUnique: vi.fn(async () => { calls.push("access"); return { id: "project", ownerId: options.access ? "actor" : "outsider", members: [] }; }) },
    taskRequest: { findMany: vi.fn(async () => { calls.push("marker"); if (options.storageFailure) throw new Error("synthetic-private-storage"); return options.markerRows; }) },
    tag: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; projectId: string } }) => { calls.push("tag-validation"); return tags.filter(tag => tag.projectId === where.projectId && where.id.in.includes(tag.id)); }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { calls.push("tag-name"); return tags.find(tag => tag.id === where.id) ?? null; }),
    },
    taskTag: {
      findMany: vi.fn(async () => { calls.push("current-links"); return links(working.tagIds); }),
      deleteMany: vi.fn(async () => { calls.push("delete-links"); working.tagIds = []; }),
      createMany: vi.fn(async ({ data }: { data: { taskId: string; tagId: string }[] }) => { calls.push("create-links"); working.tagIds = data.map(link => link.tagId); }),
    },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => { calls.push("audit"); if (options.auditFailure) throw new Error("synthetic-private-audit"); working.activities.push(data); }) },
    task: { findUnique: vi.fn(async () => { calls.push("snapshot"); return options.snapshotMissing ? null : { id: taskId, projectId: "project", project: { id: "project" }, version: working.version, tags: links(working.tagIds), assignees: [], checklistItems: [] }; }) },
  };
  const database = {
    task: { findUnique: vi.fn(async () => options.outerTask ? { id: taskId, projectId: "project", project: { id: "project", ownerId: options.outerAccess ? "actor" : "outsider", members: [] }, tags: links([tagId(1)]) } : null) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state); const result = await callback(tx); Object.assign(state, working); calls.push("commit"); return result;
    },
  };
  const invoke = (tagIds: unknown = [tagId(2)]) => {
    runtime.database = database;
    return PUT(new Request("http://localhost/api/tasks/task/tags", { method: "PUT", body: JSON.stringify({ tagIds }) }), { params: Promise.resolve({ id: taskId }) });
  };
  return { state, options, tx, calls, database, invoke };
}
type Fixture = ReturnType<typeof fixture>;
function noChildEffects(f: Fixture) {
  expect(f.tx.tag.findMany).not.toHaveBeenCalled(); expect(f.tx.taskTag.findMany).not.toHaveBeenCalled();
  expect(f.tx.taskTag.deleteMany).not.toHaveBeenCalled(); expect(f.tx.taskTag.createMany).not.toHaveBeenCalled();
  expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(runtime.automation).not.toHaveBeenCalled(); expect(runtime.load).not.toHaveBeenCalled(); expect(runtime.emit).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.authenticated = true; runtime.role = "ADMIN";
  runtime.automation.mockResolvedValue(undefined); runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } });
  runtime.emit.mockResolvedValue(undefined); runtime.warn.mockImplementation(() => {});
});

describe("guarded task tag replacement actual route", () => {
  it("preserves the real nonmember denial before tag children", async () => {
    const f = fixture(); const before = structuredClone(f.state);
    f.options.access = false;
    const actual = await vi.importActual<typeof import("@/lib/project-access")>("@/lib/project-access");
    vi.mocked(getProjectAccess).mockImplementationOnce(actual.getProjectAccess);
    expect((await f.invoke()).status).toBe(404);
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
    noChildEffects(f); expect(f.state).toEqual(before);
  });
  it("guards under resource locks before child reads and commits Activity/response snapshot together", async () => {
    const f = fixture(); runtime.emit.mockImplementation(() => { expect(f.calls).toContain("commit"); });
    const actual = await vi.importActual<typeof import("@/lib/project-access")>("@/lib/project-access");
    vi.mocked(getProjectAccess).mockImplementationOnce(actual.getProjectAccess);
    const response = await f.invoke(); expect(response.status).toBe(200);
    expect(f.calls.slice(0, 8)).toEqual(["project-lock", "task-lock", "actor-lock", "fresh-actor", "access", "marker", "tag-validation", "current-links"]);
    expect(f.state.tagIds).toEqual([tagId(2)]); expect(f.state.version).toBe(9);
    expect(f.state.activities).toEqual([
      expect.objectContaining({ action: "tag_added", oldValue: null, newValue: { tagId: tagId(2), tagName: tags[1].name } }),
      expect.objectContaining({ action: "tag_removed", oldValue: { tagId: tagId(1), tagName: tags[0].name }, newValue: null }),
    ]);
    expect(await response.json()).toMatchObject({ data: { id: "task", version: 9, tags: [{ tag: { id: tagId(2) } }] } });
    expect(f.database.task.findUnique).toHaveBeenCalledOnce(); expect(f.tx.task.findUnique).toHaveBeenCalledOnce();
    expect(f.calls.indexOf("snapshot")).toBeLessThan(f.calls.indexOf("commit")); expect(runtime.automation).toHaveBeenCalledOnce(); expect(runtime.emit).toHaveBeenCalledOnce();
  });
  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"])("denies %s for ADMIN before validation/links/write", async state => {
    const f = fixture(); f.options.role = "ADMIN"; f.options.markerRows = [marker("task", state)];
    const response = await f.invoke(); expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toMatch(/authorId|executorId|synthetic-private/); noChildEffects(f);
  });
  it.each([undefined, {}, [null], [{ ...marker("task"), contractVersion: 2 }]].map(value => ({ value })))("fails closed malformed marker result %#", async ({ value }) => {
    const f = fixture(); f.options.markerRows = value; expect((await f.invoke()).status).toBe(409); noChildEffects(f);
  });
  it.each(["query", "delegate"])("fails storage %s safely", async mode => {
    const f = fixture(); if (mode === "query") f.options.storageFailure = true; else Reflect.deleteProperty(f.tx, "taskRequest");
    const response = await f.invoke(); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); noChildEffects(f);
  });
  it.each(["clear", "noop"])("guards marked %s before replacement", async mode => {
    const f = fixture(); f.options.markerRows = [marker("task")]; expect((await f.invoke(mode === "clear" ? [] : [tagId(1)])).status).toBe(409); noChildEffects(f);
  });
  it.each(["clear", "noop"])("preserves unmarked legacy %s delete/create semantics", async mode => {
    const f = fixture(); expect((await f.invoke(mode === "clear" ? [] : [tagId(1)])).status).toBe(200);
    expect(f.tx.taskTag.deleteMany).toHaveBeenCalledOnce(); expect(f.tx.taskTag.createMany).toHaveBeenCalledTimes(mode === "clear" ? 0 : 1);
    expect(f.state.activities).toHaveLength(mode === "clear" ? 1 : 0); expect(runtime.automation).not.toHaveBeenCalled();
  });
  it.each([[tagId(9)], [tagId(2), tagId(2)]].map(value => ({ value })))("keeps invalid/duplicate tag IDs400 %# after guard", async ({ value }) => {
    const f = fixture(); expect((await f.invoke(value)).status).toBe(400);
    expect(f.calls.indexOf("tag-validation")).toBeGreaterThan(f.calls.indexOf("marker")); expect(f.tx.taskTag.findMany).not.toHaveBeenCalled();
    expect(f.tx.taskTag.deleteMany).not.toHaveBeenCalled(); expect(runtime.emit).not.toHaveBeenCalled();
  });
  it("computes removed and added tags from fresh locked links, not outer snapshot", async () => {
    const f = fixture(); f.state.tagIds = [tagId(3)]; expect((await f.invoke([tagId(1)])).status).toBe(200);
    expect(f.state.activities).toEqual([
      expect.objectContaining({ action: "tag_added", newValue: { tagId: tagId(1), tagName: tags[0].name } }),
      expect.objectContaining({ action: "tag_removed", oldValue: { tagId: tagId(3), tagName: tags[2].name } }),
    ]);
  });
  it.each(["actor", "access", "project", "task", "drift"] as const)("rejects fresh %s before marker/child reads", async field => {
    const f = fixture(); if (field === "drift") f.options.drift = true; else f.options[field] = false;
    expect((await f.invoke()).status).toBe(field === "drift" ? 409 : 404); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noChildEffects(f);
  });
  it("checks revoked access after a deferred Task lock", async () => {
    const f = fixture(); let entered!: () => void; let release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.options.onTaskLock = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const pending = f.invoke(); await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled(); f.options.access = false; release();
    expect((await pending).status).toBe(404); noChildEffects(f);
  });
  it("keeps custom Unicode Task IDs with absent marker", async () => {
    const f = fixture("задача / legacy"); expect((await f.invoke()).status).toBe(200); expect(f.state.activities).toHaveLength(2);
  });
  it.each(["audit", "snapshot"])("discards fake tx writes if mandatory %s fails", async failure => {
    const f = fixture(); const before = structuredClone(f.state); if (failure === "audit") f.options.auditFailure = true; else f.options.snapshotMissing = true;
    expect((await f.invoke()).status).toBe(failure === "audit" ? 500 : 404); expect(f.state).toEqual(before);
    expect(runtime.automation).not.toHaveBeenCalled(); expect(runtime.emit).not.toHaveBeenCalled();
  });
  it.each(["automation-sync", "automation-async", "load", "emit-sync", "emit-async", "logger"])("keeps committed200 after %s failure", async failure => {
    const f = fixture(); const error = new Error("synthetic-private-delivery");
    if (failure === "automation-sync") runtime.automation.mockImplementation(() => { throw error; });
    if (failure === "automation-async") runtime.automation.mockRejectedValue(error);
    if (failure === "load") runtime.load.mockRejectedValue(error);
    if (failure === "emit-sync") runtime.emit.mockImplementation(() => { throw error; });
    if (failure === "emit-async" || failure === "logger") runtime.emit.mockRejectedValue(error);
    if (failure === "logger") runtime.warn.mockImplementation(() => { throw error; });
    const response = await f.invoke(); expect(response.status).toBe(200); expect(f.state.activities).toHaveLength(2);
    expect((await response.json()).data.tags[0].tag.id).toBe(tagId(2));
  });
  it("drops a postcommit project-mismatched snapshot", async () => {
    const f = fixture(); runtime.load.mockResolvedValue({ project: { id: "other-project" } }); expect((await f.invoke()).status).toBe(200); expect(runtime.emit).not.toHaveBeenCalled();
  });
  it("keeps the committed response snapshot independent of automation mutations while delivery waits", async () => {
    const f = fixture(); let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    runtime.load.mockImplementation(() => { entered(); return new Promise(resolve => { release = () => resolve(null); }); });
    runtime.automation.mockImplementation(async (event: { task: { version: number; columnId?: string; status?: string; tags: { tag: { name: string } }[] } }) => {
      event.task.version = 99; event.task.columnId = "automation-column"; event.task.status = "DONE";
      event.task.tags[0].tag.name = "automation-private-change";
    });
    const pending = f.invoke(); await waiting; expect(f.calls).toContain("commit"); release();
    const response = await pending; expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ version: 9, tags: [{ tag: { id: tagId(2), name: tags[1].name } }] });
  });
  it.each(["unauthenticated", "invalid-body", "outer-access", "missing"])("retains outer %s validation/access behavior", async mode => {
    const f = fixture(); if (mode === "unauthenticated") runtime.authenticated = false;
    if (mode === "outer-access") { runtime.role = "USER"; f.options.outerAccess = false; }
    if (mode === "missing") f.options.outerTask = false;
    const response = await f.invoke(mode === "invalid-body" ? ["bad-tag-id"] : [tagId(2)]);
    expect(response.status).toBe(mode === "invalid-body" ? 422 : mode === "missing" ? 404 : 401); expect(f.tx.$queryRaw).not.toHaveBeenCalled(); noChildEffects(f);
  });
});
