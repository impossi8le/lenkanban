import { taskWritePredicate } from "@/lib/access-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ auth: vi.fn(), existing: vi.fn(), transaction: vi.fn(), raw: vi.fn(), actor: vi.fn(), project: vi.fn(), marker: vi.fn(), update: vi.fn(), cas: vi.fn(), read: vi.fn(), last: vi.fn(), writable: vi.fn(), assignees: vi.fn(), activity: vi.fn(), revision: vi.fn(), load: vi.fn(), emit: vi.fn(), moved: vi.fn(), notify: vi.fn(), automation: vi.fn(), log: vi.fn(), events: [] as string[] }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findFirst: db.existing }, $transaction: db.transaction } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: db.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: db.log, warn: db.log, error: db.log }, dbLogger: { error: db.log } }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: db.load, TASK_WITH_RELATIONS_INCLUDE: {} }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: db.emit, emitTaskMoved: db.moved, emitTaskDeleted: vi.fn() }));
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskStatusChanged: db.notify }));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  // The real shared event builder stays in place; only rule processing is inert.
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processAutomationRules: db.automation,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response("{}", { status: 429 }) }));
import { PATCH } from "./[id]/route";
import { TASK_REQUEST_STATES } from "@/lib/task-request-policy";

const original = { id: "task", projectId: "project", columnId: "column", version: 3, status: "TODO", title: "Before", description: "Before description", priority: "MEDIUM", deadline: null, position: 1 };
const tx = { $queryRaw: db.raw, taskAssignee: { findMany: db.assignees }, user: { findUnique: db.actor }, project: { findUnique: db.project, update: db.revision }, taskRequest: { findUnique: db.marker }, task: { update: db.update, updateMany: db.cas, findUniqueOrThrow: db.read, findFirst: (query: { select?: { id?: boolean } }) => query.select?.id ? db.writable(query) : db.last(query), findMany: vi.fn() }, activity: { create: db.activity } };
function invoke(body: unknown = { title: "After" }, id = "task") {
  return PATCH(new Request(`https://app.test/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}
function marker(state = "DRAFT") { return { taskId: "task", contractVersion: 1, state, authorId: "private-author", executorId: ["IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED"].includes(state) ? "private-executor" : null }; }
function noWrites() {
  for (const method of [db.update, db.cas, db.read, db.activity, db.revision, db.load, db.emit, db.moved, db.notify, db.automation]) expect(method).not.toHaveBeenCalled();
}
async function denied(status: number, code?: string, body?: unknown) {
  const response = await invoke(body); expect(response.status).toBe(status);
  const text = await response.text(); if (code) expect(JSON.parse(text).error.code).toBe(code);
  expect(text).not.toMatch(/private-author|private-executor|private-storage-secret|contractVersion|Before description|After/); noWrites();
}
beforeEach(() => {
  vi.resetAllMocks(); db.events.length = 0;
  db.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); db.existing.mockResolvedValue(original);
  db.transaction.mockImplementation(async callback => callback(tx));
  db.raw.mockImplementation(async (query: TemplateStringsArray, value: string) => {
    const sql = query.join("?");
    if (sql.includes('FROM "ProjectColumn"')) { db.events.push(sql.includes("FOR UPDATE") ? "column-lock" : "column-read"); return [{ id: value, projectId: "project", name: "Column", workflowKey: "TODO" }]; }
    if (sql.includes('FROM "Project"')) { db.events.push("project-lock"); return [{ id: value }]; }
    if (sql.includes('FROM "User"')) { expect(sql).toContain("FOR SHARE"); db.events.push("actor-lock"); return [{ id: value }]; }
    if (sql.includes('"columnId" =')) { db.events.push("destination-lock"); return []; }
    db.events.push("task-lock"); return [{ ...original, id: value }];
  });
  db.actor.mockImplementation(async () => { db.events.push("fresh-actor"); return { id: "actor", globalRole: "USER" }; });
  db.project.mockImplementation(async () => { db.events.push("fresh-access"); return { id: "project", ownerId: "actor", members: [] }; });
  db.marker.mockImplementation(async () => { db.events.push("marker"); return null; });
  db.read.mockImplementation(async () => { db.events.push("scalar-read"); return original; });
  db.update.mockImplementation(async ({ data }) => { db.events.push("scalar-write"); return { ...original, ...data }; });
  db.cas.mockImplementation(async () => { db.events.push("move-write"); return { count: 1 }; });
  db.writable.mockImplementation(async ({ where, select }) => {
    expect(where).toEqual({ AND: [taskWritePredicate({ id: "actor", globalRole: "USER" }), { id: expect.any(String), projectId: "project" }] });
    expect(select).toEqual({ id: true });
    db.events.push("fresh-task-access"); return { id: original.id };
  });
  db.last.mockResolvedValue(null); db.activity.mockResolvedValue({}); db.revision.mockResolvedValue({ boardRevision: 4 });
  db.notify.mockResolvedValue(undefined); db.automation.mockResolvedValue(undefined); db.load.mockResolvedValue(null);
});

describe("actual legacy PATCH locked request guard", () => {
  it("checks Project → Task identity → fresh actor/access → marker before scalar audit and write", async () => {
    expect((await invoke()).status).toBe(200);
    expect(db.events).toEqual(["project-lock", "task-lock", "actor-lock", "fresh-actor", "fresh-task-access", "marker", "task-lock", "scalar-read", "scalar-write"]);
    expect(db.raw.mock.calls[1][0].join("?")).toMatch(/SELECT\s+"id",\s*"projectId"\s+FROM "Task"/);
    expect(db.actor).toHaveBeenCalledExactlyOnceWith({ where: { id: "actor" }, select: { id: true, globalRole: true } });
    expect(db.writable).toHaveBeenCalledOnce();
    expect(db.project).not.toHaveBeenCalled();
    expect(db.marker).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { taskId: "task" } }));
    expect(db.activity).toHaveBeenCalledOnce();
  });
  it("denies a visible foreign task before marker, audit and scalar writes", async () => {
    // The outer common read lookup succeeds, e.g. for a watcher. Task-level
    // write lookup independently refuses the actor with no creator/executor relation.
    db.writable.mockResolvedValue(null);
    await denied(404);
    expect(db.existing).toHaveBeenCalledOnce();
    expect(db.writable).toHaveBeenCalledWith({
      where: { AND: [taskWritePredicate({ id: "actor", globalRole: "USER" }), { id: "task", projectId: "project" }] }, select: { id: true },
    });
    expect(db.marker).not.toHaveBeenCalled();
  });
  it.each(TASK_REQUEST_STATES)("rejects valid %s before scalar or external effects", async state => {
    db.marker.mockResolvedValue(marker(state)); await denied(409, "REQUEST_LIFECYCLE_NOT_ENABLED");
  });
  it.each([{ ...marker(), extra: "private-storage-secret" }, undefined])("rejects malformed marker %#", async value => {
    db.marker.mockResolvedValue(value); await denied(409, "INVALID_REQUEST_MARKER");
  });
  it.each([{ title: "Before" }, { position: 9 }, { expectedVersion: 3 }, { description: null }])("guards accepted no-op/position/empty scalar data/null body %#", async body => {
    db.marker.mockResolvedValue(marker()); await denied(409, "REQUEST_LIFECYCLE_NOT_ENABLED", body);
  });
  it("preserves literal empty body validation before transactions", async () => {
    expect((await invoke({})).status).toBe(422); expect(db.transaction).not.toHaveBeenCalled(); noWrites();
  });
  it.each(["project", "task", "actor", "outsider", "revoked"])("returns fresh %s404 before marker", async missing => {
    const raw = db.raw.getMockImplementation()!;
    db.raw.mockImplementation(async (query, ...values) => {
      const sql = query.join("?");
      if ((missing === "project" && sql.includes('FROM "Project"')) || (missing === "task" && sql.includes('FROM "Task"'))) return [];
      if (missing === "revoked" && sql.includes('FROM "Project"')) {
        db.actor.mockResolvedValue({ id: "actor", globalRole: "USER" });
        db.project.mockResolvedValue({ id: "project", ownerId: "other", members: [] }); db.writable.mockResolvedValue(null);
      }
      return raw(query, ...values);
    });
    if (missing === "actor") db.actor.mockResolvedValue(null);
    if (missing === "outsider") db.project.mockResolvedValue({ id: "project", ownerId: "other", members: [] }); db.writable.mockResolvedValue(null);
    if (missing === "revoked") db.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
    await denied(404); expect(db.marker).not.toHaveBeenCalled();
  });
  it("rejects identity drift before actor or marker access", async () => {
    const raw = db.raw.getMockImplementation()!;
    db.raw.mockImplementation(async (query, ...values) => query.join("?").includes('FROM "Task"') ? [{ ...original, projectId: "other" }] : raw(query, ...values));
    await denied(409, "IDENTITY_CHANGED"); expect(db.actor).not.toHaveBeenCalled(); expect(db.marker).not.toHaveBeenCalled();
  });
  it.each(["missing-actor", "revoked-admin", "removed-task-ownership"])("refreshes %s after waiting for the Project lock", async scenario => {
    let release!: () => void;
    const locked = new Promise<void>(resolve => { release = resolve; });
    const raw = db.raw.getMockImplementation()!;
    db.raw.mockImplementation(async (query, ...values) => {
      if (query.join("?").includes('FROM "Project"')) await locked;
      return raw(query, ...values);
    });
    db.auth.mockResolvedValue({ id: "actor", globalRole: scenario === "revoked-admin" ? "ADMIN" : "USER" });
    const pending = invoke();
    await vi.waitFor(() => expect(db.raw).toHaveBeenCalledOnce());
    expect(db.actor).not.toHaveBeenCalled(); expect(db.project).not.toHaveBeenCalled(); expect(db.marker).not.toHaveBeenCalled(); noWrites();
    db.actor.mockResolvedValue(scenario === "missing-actor" ? null : { id: "actor", globalRole: "USER" });
    db.project.mockResolvedValue({ id: "project", ownerId: "other", members: [] }); db.writable.mockResolvedValue(null);
    release();
    const response = await pending; expect(response.status).toBe(404); expect(db.marker).not.toHaveBeenCalled(); noWrites();
  });
  it.each(["delegate", "storage"])("does not treat %s failure as marker absence", async failure => {
    if (failure === "delegate") Object.assign(tx, { taskRequest: undefined });
    else db.marker.mockRejectedValue(Error("private-storage-secret"));
    try { await denied(500); } finally { tx.taskRequest = { findUnique: db.marker }; }
  });
  it("preserves odd legacy identifiers/null and historical scalar version semantics when marker is null", async () => {
    const id = "старая:задача/ odd"; db.existing.mockResolvedValue({ ...original, id });
    db.assignees.mockResolvedValue([{ userId: "actor" }]);
    const response = await invoke({ description: null, deadline: null, expectedVersion: 99 }, id);
    expect(response.status).toBe(200); expect(db.marker).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: id } }));
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id }, data: { description: null, deadline: null } }));
    expect(db.cas).not.toHaveBeenCalled(); expect((await response.json()).data.version).toBe(3);
    expect(db.assignees).toHaveBeenCalledExactlyOnceWith({ where: { taskId: id }, select: { userId: true }, take: 2 });
  });
  it.each(["column", "destination"])("keeps canonical %s mixed preflight before scalar access with no repeated parent locks", async columnId => {
    db.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
    db.actor.mockImplementation(async () => { db.events.push("fresh-actor"); return { id: "actor", globalRole: "ADMIN" }; });
    db.marker.mockImplementation(async () => { db.events.push("marker"); return marker(); });
    const response = await invoke({ columnId, title: "After" }); expect(response.status).toBe(409); noWrites();
    expect(db.marker).toHaveBeenCalledOnce(); expect(db.events.filter(event => event === "project-lock")).toHaveLength(1);
    expect(db.events.indexOf("actor-lock")).toBeGreaterThan(db.events.indexOf("task-lock"));
    expect(db.events.indexOf("marker")).toBeGreaterThan(db.events.indexOf("fresh-actor"));
    if (columnId === "destination") expect(db.events.indexOf("destination-lock")).toBeLessThan(db.events.indexOf("actor-lock"));
  });
  it.each(["column", "destination"])("writes allowed mixed %s scalars only after canonical marker preflight", async columnId => {
    db.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
    db.actor.mockImplementation(async () => { db.events.push("fresh-actor"); return { id: "actor", globalRole: "ADMIN" }; });
    expect((await invoke({ columnId, title: "After" })).status).toBe(200);
    expect(db.marker).toHaveBeenCalledOnce();
    expect(db.events.filter(event => event === "project-lock")).toHaveLength(1);
    expect(db.events.indexOf("scalar-write")).toBeGreaterThan(db.events.indexOf("marker"));
    const writes = db.events.filter(event => event === "move-write" || event === "scalar-write");
    expect(writes).toEqual(columnId === "column" ? ["scalar-write"] : ["move-write", "scalar-write"]);
    if (columnId === "destination") expect(db.events.indexOf("move-write")).toBeGreaterThan(db.events.indexOf("marker"));
  });
});
