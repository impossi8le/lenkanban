import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { evaluateScopedPrivileges, ownTaskProjectIds, taskReadPredicate, type ScopedPrivilegeGrant } from "./access-policy";
import { evaluatePrivilegeMatrix } from "./organization-access-explanation";

const db = vi.hoisted(() => ({ grants: vi.fn(), project: vi.fn(), boards: vi.fn(), task: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  scopedPrivilegeAssignment: { findMany: db.grants },
  project: { findUnique: db.project, findMany: db.boards }, task: { findFirst: db.task },
} }));
import { getProjectAccess, getTaskReadWhere, requireTaskRead, requireTaskWrite } from "./project-access";
import { NotFoundError } from "./errors";

// Small generic query double, not a database integration test. Unknown operators
// throw so a newly introduced predicate cannot silently make these cases pass.
type Row = { [key: string]: unknown };
function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  const source = row as Row | null;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (key === "OR") return (value as unknown[]).some(item => matches(row, item));
    if (key === "has") return Array.isArray(row) && row.includes(value);
    if (key === "isEmpty") return Array.isArray(row) && (row.length === 0) === value;
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item, value));
    if (key === "none") return Array.isArray(row) && !row.some(item => matches(item, value));
    if (key === "not") return !matches(row, value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (key === "notIn") return !(value as unknown[]).includes(row);
    if (key === "contains") return typeof row === "string" && row.toLowerCase().includes(String(value).toLowerCase());
    if (key === "mode") return true;
    if (!source || typeof source !== "object" || !(key in source)) throw new Error(`Unsupported query field: ${key}`);
    return matches(source[key], value);
  });
}

const actor = { id: "employee", globalRole: "USER" as const };
function task(overrides: Row = {}): Row {
  return { id: "task", title: "foreign title", projectId: "own", createdById: "other", request: null,
    assignees: [], watchers: [], project: { id: "own", ownerId: "owner", departmentId: "department-b",
      members: [{ userId: actor.id }], responsibleGroup: { archivedAt: null, leaderId: null, members: [] }, department: { employees: [{ id: actor.id, isBlocked: false, blockedAt: null }], archivedAt: null, leaderId: null } },
    ...overrides };
}
const canonical = { contractVersion: 1, authorId: "other", executorId: null, deletedAt: null, state: "SUBMITTED", audienceUserIds: [] as string[] };
beforeEach(() => {
  vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own");
  vi.resetAllMocks(); db.grants.mockResolvedValue([]);
  db.boards.mockResolvedValue([{ id: "own" }, { id: "legacy" }]);
  db.project.mockResolvedValue({ ownerId: "owner", members: [{ role: "MEMBER" }] });
});
afterEach(() => vi.unstubAllEnvs());

describe("mandatory server OWN policy and persisted task relationships", () => {
  it("lets a persisted watcher find one personal task without board access and revokes that grant on removal", async () => {
    const project = { ...(task().project as Row), members: [] };
    let record = task({ project, title: "Findable request", watchers: [{ userId: actor.id }], request: { ...canonical, audienceUserIds: ["chosen"] } });
    const filters = { title: { contains: "findable", mode: "insensitive" as const } };
    const where = await getTaskReadWhere(actor, filters);
    expect(matches(record, where)).toBe(true);
    expect(matches({ ...record, id: "other-task", watchers: [] }, where)).toBe(false);
    expect(matches(record, await getTaskReadWhere(actor, { title: { contains: "no match" } }))).toBe(false);
    for (const request of [{ ...canonical, state: "DRAFT", audienceUserIds: ["chosen"] }, { ...canonical, deletedAt: new Date(), audienceUserIds: ["chosen"] }]) {
      expect(matches({ ...record, request }, where)).toBe(false);
    }
    db.project.mockResolvedValue({ ownerId: "other", members: [] });
    db.task.mockImplementation(async ({ where }: { where: unknown }) => matches(record, where) ? { id: "task", projectId: "own" } : null);
    expect((await getProjectAccess(actor, "own")).canRead).toBe(false);
    await expect(requireTaskRead(actor, "task")).resolves.toHaveProperty("id", "task");
    await expect(requireTaskWrite(actor, "task", "own")).rejects.toBeInstanceOf(NotFoundError);
    record = { ...record, watchers: [] };
    await expect(requireTaskRead(actor, "task")).rejects.toBeInstanceOf(NotFoundError);
    expect(matches({ ...record, request: { ...canonical, authorId: actor.id, audienceUserIds: ["chosen"] } }, where)).toBe(true);
  });
  it("also preserves a standalone legacy watcher without ordinary board access", () => {
    const record = task({ project: { ...(task().project as Row), members: [] }, watchers: [{ userId: actor.id }] });
    expect(matches(record, taskReadPredicate(actor, [], [], false))).toBe(true);
    expect(matches({ ...record, watchers: [] }, taskReadPredicate(actor, [], [], false))).toBe(false);
  });
  it("denies department leadership alone without execution eligibility", async () => {
    const project = { ...(task().project as Row), members: [], department: { employees: [], archivedAt: null, leaderId: actor.id } };
    const record = task({ project, request: { ...canonical, audienceUserIds: ["chosen"] } });
    const where = await getTaskReadWhere(actor);
    expect(matches(record, where)).toBe(false);
    expect(matches({ ...record, request: { ...canonical, state: "DRAFT", audienceUserIds: ["chosen"] } }, where)).toBe(false);
    expect(matches({ ...record, request: { ...canonical, deletedAt: new Date(), audienceUserIds: ["chosen"] } }, where)).toBe(false);
    expect(matches({ ...record, request: null }, where)).toBe(false);
    for (const department of [null, { employees: [], archivedAt: new Date(), leaderId: actor.id }, { employees: [], archivedAt: null, leaderId: "other-leader" }, { employees: [], archivedAt: null, leaderId: null }]) {
      expect(matches({ ...record, project: { ...project, department } }, where)).toBe(false);
    }
    expect(matches(record, await getTaskReadWhere({ ...actor, globalRole: "ADMIN" }))).toBe(true);
  });
  it("denies responsible-group leadership alone to a selected request", async () => {
    const where = await getTaskReadWhere(actor);
    const record = task({ request: { ...canonical, audienceUserIds: ["chosen"] } });
    const project = record.project as Row;
    const group = { archivedAt: null, leaderId: actor.id, members: [{ userId: actor.id }] };
    expect(matches({ ...record, project: { ...project, responsibleGroup: group } }, where)).toBe(false);
    for (const denied of [
      { ...group, archivedAt: new Date() },
      { ...group, members: [] },
      { ...group, leaderId: "other-leader" },
      { ...group, members: [{ userId: "other-member" }] },
    ]) expect(matches({ ...record, project: { ...project, responsibleGroup: denied } }, where)).toBe(false);
    expect(matches({ ...record, request: { ...canonical, state: "DRAFT", audienceUserIds: ["chosen"] }, project: { ...project, responsibleGroup: group } }, where)).toBe(false);
  });
  it("caps group, executor, legacy membership and scoped reads while preserving a persisted watcher exception", async () => {
    db.grants.mockResolvedValue([{ id: "grant", userId: actor.id, profileId: "profile", scopeKind: "organization", departmentId: null, projectId: null, profile: { archivedAt: null, permissions: ["request.execute"] } }]);
    const record = task({
      request: { ...canonical, state: "IN_PROGRESS", executorId: actor.id, audienceUserIds: ["chosen"] },
      watchers: [],
      project: { ...(task().project as Row), ownerId: actor.id, responsibleGroup: { archivedAt: null, leaderId: null, members: [{ userId: actor.id }] } },
    });
    const where = await getTaskReadWhere(actor);
    expect(matches(record, where)).toBe(false);
    expect(matches({ ...record, watchers: [{ userId: actor.id }] }, where)).toBe(true);
    expect(matches({ ...record, request: { ...canonical, audienceUserIds: [actor.id] } }, where)).toBe(true);
    expect(matches({ ...record, request: { ...canonical, authorId: actor.id, audienceUserIds: ["chosen"] } }, where)).toBe(true);
    expect(matches({ ...record, request: { ...canonical, audienceUserIds: [] } }, where)).toBe(true);
    expect(matches(record, await getTaskReadWhere({ ...actor, globalRole: "ADMIN" }))).toBe(true);
  });
  it("uses one reader for a watcher without board membership or rollout configuration and grants no project mutation rights", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "");
    db.project.mockResolvedValue({ ownerId: "other", members: [] });
    const record = task({ projectId: "legacy", watchers: [{ userId: actor.id }],
      project: { ...(task().project as Row), id: "legacy", members: [] } });
    db.task.mockImplementation(async ({ where }: { where: unknown }) => matches(record, where)
      ? { id: "task", projectId: "legacy" } : null);
    await expect(requireTaskRead(actor, "task")).resolves.toEqual({ id: "task", projectId: "legacy" });
    expect(await getProjectAccess(actor, "legacy")).toEqual({
      projectId: "legacy", canRead: false, canWrite: false, canManageMembers: false,
    });
    expect(matches(task({ projectId: "legacy", watchers: [] }), await getTaskReadWhere(actor))).toBe(false);
  });

  it("enforces global personal visibility regardless of the old OWN allowlist", () => {
    expect(ownTaskProjectIds(undefined)).toEqual([]);
    expect(ownTaskProjectIds("  ")).toEqual([]);
    expect(ownTaskProjectIds("own, another,own")).toEqual(["own", "another"]);
    for (const config of ["*", "own,", "own,bad/id"]) expect(() => ownTaskProjectIds(config)).toThrow("INVALID_OWN_TASK_POLICY");
    expect(matches(task(), taskReadPredicate(actor, []))).toBe(false);
    expect(matches(task({ projectId: "legacy" }), taskReadPredicate(actor, ["own"]))).toBe(false);
  });

  it.each([
    ["member without relationship", {}, false],
    ["legacy author", { createdById: actor.id }, true],
    ["legacy single executor", { assignees: [{ userId: actor.id }] }, true],
    ["ambiguous old assignments", { assignees: [{ userId: actor.id }, { userId: "other" }] }, false],
    ["null creator", { createdById: null }, false],
    ["observer from another department", { watchers: [{ userId: actor.id }] }, true],
    ["canonical author", { request: { ...canonical, authorId: actor.id } }, true],
    ["canonical executor", { request: { ...canonical, executorId: actor.id } }, true],
    ["stale legacy author", { createdById: actor.id, request: canonical }, false],
    ["stale legacy executor", { assignees: [{ userId: actor.id }], request: canonical }, false],
    ["draft observer", { watchers: [{ userId: actor.id }], request: { ...canonical, state: "DRAFT" } }, false],
    ["draft author", { request: { ...canonical, authorId: actor.id, state: "DRAFT" } }, true],
    ["deleted author", { request: { ...canonical, authorId: actor.id, deletedAt: new Date() } }, false],
    ["unknown marker", { request: { ...canonical, authorId: actor.id, contractVersion: 999 } }, false],
  ] as const)("%s", async (_name, overrides, allowed) => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "");
    const where = await getTaskReadWhere(actor);
    expect(matches(task(overrides), where)).toBe(allowed);
    expect(matches(task({ ...overrides, projectId: "legacy" }), where)).toBe(allowed);
  });

  it("board ownership, project admin, department membership and a leadership title confer no implicit OWN grant", () => {
    const record = task();
    for (const project of [
      { ...(record.project as Row), ownerId: actor.id },
      { ...(record.project as Row), members: [{ userId: actor.id, role: "PROJECT_ADMIN" }] },
      { ...(record.project as Row), department: { employees: [], archivedAt: null, leaderId: actor.id } },
    ]) expect(matches({ ...record, project }, taskReadPredicate(actor, ["own"]))).toBe(false);
  });

  it("legacy unbound boards require more than active group membership", () => {
    const record = task();
    const project = { ...(record.project as Row), departmentId: null, department: null, responsibleGroup: { leaderId: null, archivedAt: null, members: [{ userId: actor.id }] } };
    const where = taskReadPredicate(actor, ["own"]);
    expect(matches(task({ project, request: canonical }), where)).toBe(false);
    expect(matches(task({ project, request: { ...canonical, state: "DRAFT" } }), where)).toBe(false);
    expect(matches(task({ project: { ...project, responsibleGroup: { archivedAt: new Date(), members: [{ userId: actor.id }] } } }), where)).toBe(false);
    expect(matches(task(), taskReadPredicate({ ...actor, globalRole: "ADMIN" }, ["own"]))).toBe(true);
  });

  it("author, executor and observer read only their task without any project membership", () => {
    const project = { ...(task().project as Row), members: [] };
    const where = taskReadPredicate(actor, ["own"]);
    for (const relationship of [{ createdById: actor.id }, { assignees: [{ userId: actor.id }] }, { watchers: [{ userId: actor.id }] }]) {
      expect(matches(task({ project, ...relationship }), where)).toBe(true);
    }
    expect(matches(task({ project }), where)).toBe(false);
  });

  it("caller OR/id/project/assignment/search filters can only narrow the server predicate", async () => {
    const filters: Prisma.TaskWhereInput[] = [{}, { OR: [{ id: "task" }, {}] }, { id: "task" }, { projectId: "own" },
      { assignees: { some: { userId: actor.id } } }, { title: { contains: "foreign", mode: "insensitive" } }];
    for (const filter of filters) {
      const where = await getTaskReadWhere(actor, filter);
      expect(matches(task(), where)).toBe(false);
    }
    expect(matches(task({ createdById: actor.id }), await getTaskReadWhere(actor, { projectId: "spoofed" }))).toBe(false);
  });

  it("refreshes task read grants independently of legacy project write access", async () => {
    let record = task({ assignees: [{ userId: actor.id }] });
    db.task.mockImplementation(async ({ where }: { where: unknown }) => matches(record, where) ? { id: "task", projectId: "own" } : null);
    await expect(requireTaskRead(actor, "task")).resolves.toEqual({ id: "task", projectId: "own" });
    record = task();
    await expect(requireTaskRead(actor, "task")).rejects.toBeInstanceOf(NotFoundError);
    record = task({ watchers: [{ userId: actor.id }] });
    await expect(requireTaskRead(actor, "task")).resolves.toHaveProperty("id", "task");
    record = task();
    await expect(requireTaskRead(actor, "task")).rejects.toBeInstanceOf(NotFoundError);
    // OWN narrows *reads*; each mutation is decided by task-level guards (owner 2026-10-22).
    expect((await getProjectAccess(actor, "own")).canWrite).toBe(true);
    expect((await getProjectAccess({ ...actor, globalRole: "ADMIN" }, "own")).canWrite).toBe(true);
    expect((await getProjectAccess(actor, "legacy")).canWrite).toBe(true);
  });

  it("uses only persisted active scoped request.execute grants plus staff and fails on DB errors", async () => {
    const grant = { id: "grant", userId: actor.id, profileId: "profile", scopeKind: "department", departmentId: "department-b", projectId: null, profile: { archivedAt: null, permissions: ["request.execute"] } };
    db.grants.mockResolvedValue([grant]);
    expect(matches(task(), await getTaskReadWhere(actor))).toBe(true);
    expect(db.grants).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: actor.id, profile: { archivedAt: null } } }));
    db.grants.mockResolvedValue([{ ...grant, departmentId: "department-a" }]);
    expect(matches(task(), await getTaskReadWhere(actor))).toBe(false);
    db.grants.mockResolvedValue([{ ...grant, profile: { archivedAt: null, permissions: ["request.internal.read"] } }]);
    expect(matches(task(), await getTaskReadWhere(actor))).toBe(false);
    db.grants.mockResolvedValue([{ ...grant, profile: { archivedAt: null, permissions: ["request.read", "unknown"] } }]);
    expect(matches(task(), await getTaskReadWhere(actor))).toBe(false);
    db.grants.mockRejectedValue(new Error("synthetic storage error"));
    await expect(getTaskReadWhere(actor)).rejects.toThrow("synthetic storage error");
  });

  it.each([
    ["organization", null, null, true],
    ["board", "own", null, true],
    ["board", "other", null, false],
    ["department", null, "department-b", true],
    ["department", null, "department-a", false],
    ["organization", "own", null, false],
    ["unknown", null, null, false],
  ] as const)("exact persisted scope %s/%s/%s", async (scopeKind, projectId, departmentId, allowed) => {
    db.grants.mockResolvedValue([{ id: "grant", userId: actor.id, profileId: "profile", scopeKind, projectId, departmentId, profile: { archivedAt: null, permissions: ["request.execute"] } }]);
    expect(matches(task(), await getTaskReadWhere(actor))).toBe(allowed);
    if (scopeKind === "department" && allowed) {
      const project = { ...(task().project as Row), department: { employees: [], archivedAt: new Date() } };
      expect(matches(task({ project }), await getTaskReadWhere(actor))).toBe(false);
    }
    db.grants.mockResolvedValue([]);
    expect(matches(task(), await getTaskReadWhere(actor))).toBe(false);
  });

  it("read matrix and internal grants alone do not widen canonical task visibility", async () => {
    // Organization request.read + a board profile with no permissions: the
    // narrower assignment grants nothing; neither replaces execution eligibility.
    db.grants.mockResolvedValue([
      { id: "grant", userId: actor.id, profileId: "profile", scopeKind: "organization", projectId: null, departmentId: null, profile: { archivedAt: null, permissions: ["request.read"] } },
      { id: "grant", userId: actor.id, profileId: "profile", scopeKind: "board", projectId: "own", departmentId: null, profile: { archivedAt: null, permissions: [] } },
    ]);
    const facts = { globalAdmin: false, projectId: "own", activeDepartmentId: null };
    const grants: ScopedPrivilegeGrant[] = [
      { id: "org", profileId: "p1", scopeKind: "organization", departmentId: null, projectId: null,
        permissions: ["request.read"], profileArchived: false },
      { id: "board", profileId: "p2", scopeKind: "board", departmentId: null, projectId: "own",
        permissions: [], profileArchived: false },
    ];
    const sqlAllows = matches(task(), await getTaskReadWhere(actor));
    const matrixAllows = evaluatePrivilegeMatrix(facts, grants).actions
      .find(row => row.action === "request.read")?.allowed;
    const discussionAllows = evaluateScopedPrivileges(facts, grants).requestRead.allowed;
    expect({ sqlAllows, matrixAllows, discussionAllows }).toEqual({
      sqlAllows: false, matrixAllows: true, discussionAllows: true });
  });

  it("supports an injected transaction without consulting the default database", async () => {
    const database = { project: { findMany: vi.fn().mockResolvedValue([{ id: "own" }]) },
      scopedPrivilegeAssignment: { findMany: vi.fn().mockResolvedValue([]) } };
    await getTaskReadWhere(actor, {}, database as unknown as Pick<Prisma.TransactionClient, "project" | "scopedPrivilegeAssignment">);
    expect(database.scopedPrivilegeAssignment.findMany).toHaveBeenCalledOnce();
    expect(database.project.findMany).toHaveBeenCalledExactlyOnceWith({ select: { id: true } });
    expect(db.boards).not.toHaveBeenCalled();
    expect(db.grants).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "own", "*", "other-board"])("enforces OWN reads while preserving member writes for config %s", async config => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", config);
    const where = await getTaskReadWhere(actor);
    for (const projectId of ["own", "legacy"]) {
      expect(matches(task({ projectId }), where)).toBe(false);
      expect(matches(task({ projectId, createdById: actor.id }), where)).toBe(true);
      expect((await getProjectAccess(actor, projectId)).canWrite).toBe(true);
    }
  });

  it("denies empty snapshots and concurrent new boards; propagates board lookup failures", async () => {
    const ownTask = task({ projectId: "new", createdById: actor.id });
    // With no configured IDs, an empty board snapshot denies even owned rows.
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "");
    db.boards.mockResolvedValue([]);
    expect(matches(ownTask, await getTaskReadWhere(actor))).toBe(false);
    expect(matches(task({ createdById: actor.id }), await getTaskReadWhere(actor))).toBe(false);
    db.boards.mockRejectedValue(Error("board lookup failed"));
    await expect(getTaskReadWhere(actor)).rejects.toThrow("board lookup failed");
  });

  it("unions configured and stored boards without granting access to unrelated tasks", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", " configured,own,configured ");
    const where = await getTaskReadWhere(actor);
    expect(where.AND).toEqual([
      taskReadPredicate(actor, ["configured", "own", "legacy"], [], true),
      { projectId: { in: ["configured", "own", "legacy"] } }, {},
    ]);
    for (const projectId of ["configured", "own", "legacy"]) {
      expect(matches(task({ projectId, createdById: actor.id }), where)).toBe(true);
      expect(matches(task({ projectId }), where)).toBe(false);
    }
    expect(matches(task({ projectId: "unknown", createdById: actor.id }), where)).toBe(false);
  });

  it("retains configured boards when the stored snapshot is empty", async () => {
    db.boards.mockResolvedValue([]);
    const where = await getTaskReadWhere(actor);
    expect(matches(task({ createdById: actor.id }), where)).toBe(true);
    expect(matches(task(), where)).toBe(false);
    expect(matches(task({ projectId: "legacy", createdById: actor.id }), where)).toBe(false);
  });

  it("narrow injected readers cannot fall back to project membership", async () => {
    const database = {} as unknown as NonNullable<Parameters<typeof getTaskReadWhere>[2]>;
    const where = await getTaskReadWhere(actor, {}, database);
    expect(matches(task(), where)).toBe(false);
    expect(matches(task({ createdById: actor.id }), where)).toBe(true);
    expect(matches(task({ watchers: [{ userId: actor.id }] }), where)).toBe(true);
    expect(matches(task({ projectId: "outside-config", createdById: actor.id }), where)).toBe(true);
    expect(matches(task({ projectId: "outside-config" }), where)).toBe(false);
    expect(where).toEqual({ AND: [taskReadPredicate(actor, ["own"], [], true), {}] });
    expect(db.boards).not.toHaveBeenCalled();
    expect(db.grants).not.toHaveBeenCalled();
  });

  it("global ADMIN bypasses OWN without board or grant queries", async () => {
    const filters = { id: "task" };
    expect(await getTaskReadWhere({ ...actor, globalRole: "ADMIN" }, filters)).toBe(filters);
    expect(db.boards).not.toHaveBeenCalled();
    expect(db.grants).not.toHaveBeenCalled();
  });
});


describe("legacy task mutation authority is independent of read access", () => {
  it.each([
    ["author", { createdById: actor.id }, true],
    ["single executor", { assignees: [{ userId: actor.id }] }, true],
    ["watcher", { watchers: [{ userId: actor.id }] }, false],
    ["project member", {}, false],
    ["ambiguous executor", { assignees: [{ userId: actor.id }, { userId: "other" }] }, false],
    ["marked author", { createdById: actor.id, request: { ...canonical, authorId: actor.id } }, false],
    ["null creator", { createdById: null }, false],
  ] as const)("%s has explicit legacy write=$allowed", async (_name, overrides, allowed) => {
    const row = task(overrides);
    db.task.mockImplementation(async ({ where }: { where: unknown }) => matches(row, where) ? { id: "task" } : null);
    const result = requireTaskWrite(actor, "task", "own");
    if (allowed) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toBeInstanceOf(NotFoundError);
    expect(db.task).toHaveBeenCalledOnce();
    expect((await getProjectAccess(actor, "own")).canWrite).toBe(true);
  });
  it("binds identity and project, and never turns a read grant into write", async () => {
    const row = task({ createdById: actor.id });
    db.task.mockImplementation(async ({ where }: { where: unknown }) => matches(row, where) ? { id: "task" } : null);
    await expect(requireTaskWrite(actor, "foreign", "own")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireTaskWrite(actor, "task", "foreign")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("allows global ADMIN without a task delegate read", async () => {
    await expect(requireTaskWrite({ ...actor, globalRole: "ADMIN" }, "task", "own")).resolves.toBeUndefined();
    expect(db.task).not.toHaveBeenCalled();
  });
});


describe("shared destination department submitted read", () => {
  it("requires execution permission even for general department requests", async () => {
    const project = { ...(task().project as Row), members: [], department: { archivedAt: null, leaderId: null, employees: [{ id: actor.id, isBlocked: false, blockedAt: null }] } };
    const record = task({ project, request: canonical }); const where = await getTaskReadWhere(actor);
    expect(matches(record, where)).toBe(false);
    expect(matches({ ...record, request: { ...canonical, state: "DRAFT" } }, where)).toBe(false);
    expect(matches({ ...record, request: { ...canonical, deletedAt: new Date() } }, where)).toBe(false);
    expect(matches({ ...record, request: { ...canonical, audienceUserIds: ["chosen"] } }, where)).toBe(false);
    expect(matches({ ...record, request: { ...canonical, audienceUserIds: [actor.id] } }, where)).toBe(false);
    expect(matches(record, (await import("./access-policy")).taskWritePredicate(actor))).toBe(false);
  });
  it("does not turn another department's active group into department staff", async () => {
    const project = { ...(task().project as Row), members: [], responsibleGroup: { archivedAt: null, leaderId: null, members: [{ userId: actor.id }] } };
    const where = await getTaskReadWhere(actor); const record = task({ project, request: canonical });
    expect(matches(record, where)).toBe(false);
    expect(matches({ ...record, watchers: [{ userId: actor.id }], request: { ...canonical, audienceUserIds: ["chosen"] } }, where)).toBe(true);
  });
  it.each(["moved", "blocked", "blockedAt", "archived"])("revokes the common staff grant after %s", async reason => {
    const employee = { id: actor.id, isBlocked: reason === "blocked", blockedAt: reason === "blockedAt" ? new Date() : null };
    const project = { ...(task().project as Row), members: [], department: { archivedAt: reason === "archived" ? new Date() : null, leaderId: null, employees: reason === "moved" ? [] : [employee] } };
    expect(matches(task({ project, request: canonical }), await getTaskReadWhere(actor))).toBe(false);
  });
});
