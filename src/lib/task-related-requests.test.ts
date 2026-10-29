import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: async (_actor: unknown, filter: unknown) => filter }));
import { changeRelatedRequests, readRelatedRequests } from "./task-related-requests";
import { ForbiddenError, NotFoundError } from "./errors";
const operationId = "11111111-1111-4111-8111-111111111111";
const body = { actorId: "author", taskId: "a", action: "add" as const, relatedTaskId: "b", operationId, expectedVersion: 7 };
function task(id: string, owner = "author") { return { id, title: `Request ${id}`, projectId: "project", version: 7, status: "TODO", createdById: owner,
  request: null, assignees: [] as { userId: string }[], project: { name: "Department", department: null, responsibleGroup: null } }; }
function marker(id: string, overrides: Record<string, unknown> = {}) { return { taskId: id, contractVersion: 1, state: "IN_PROGRESS",
  authorId: "author", executorId: "executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null, ...overrides }; }
function fixture() {
  const state = { tasks: [task("a"), task("b"), task("c"), task("d")], edges: [] as { leftTaskId: string; rightTaskId: string }[], activities: [] as unknown[], receipts: [] as Record<string, unknown>[] };
  let working = state;
  const options = { hidden: new Set<string>(), blocked: false, failHistory: false, cas: false, actor: "author", role: "USER", grants: [] as unknown[] };
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "ScopedPrivilegeAssignment"')) return options.grants.map((_, i) => ({ id: `grant-${i}` }));
      if (sql.includes('FROM "GroupPrivilegeAssignment"')) return [];
      if (sql.includes('FROM "Project"') && sql.includes('FOR UPDATE')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"') && sql.includes('FOR UPDATE')) return working.tasks.filter(row => ["a", "b"].includes(row.id)).map(row => ({ id: row.id, projectId: row.projectId }));
      return [];
    }),
    user: { findUnique: vi.fn(async () => ({ id: options.actor, globalRole: options.role, isBlocked: options.blocked, blockedAt: null })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => options.grants.map((row, i) => {
      const grant = row as { profile: { permissions: unknown } };
      return { id: `grant-${i}`, userId: options.actor, profileId: "profile", ...grant,
        profile: { archivedAt: null, ...grant.profile } };
    })) },
    task: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => options.hidden.has(where.id) ? null : structuredClone(working.tasks.find(row => row.id === where.id) ?? null)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => working.tasks.filter(row => where.id.in.includes(row.id)).map(row => ({ id: row.id, projectId: row.projectId }))),
      updateMany: vi.fn(async ({ where }: { where: { id: string; version: number } }) => { const row = working.tasks.find(row => row.id === where.id); if (!row || row.version !== where.version || options.cas) return { count: 0 }; row.version++; return { count: 1 }; }),
    },
    taskRelation: {
      findMany: vi.fn(async ({ where, take }: { where: { AND: [{ OR: [{ leftTaskId: { in: string[] } }] }] }; take: number }) => {
        const frontier = where.AND[0].OR[0].leftTaskId.in;
        return working.edges.filter(edge => !options.hidden.has(edge.leftTaskId) && !options.hidden.has(edge.rightTaskId)
          && (frontier.includes(edge.leftTaskId) || frontier.includes(edge.rightTaskId))).slice(0, take).map(edge => ({ ...edge,
          leftTask: working.tasks.find(row => row.id === edge.leftTaskId)!, rightTask: working.tasks.find(row => row.id === edge.rightTaskId)! }));
      }),
      findUnique: vi.fn(async ({ where }: { where: { leftTaskId_rightTaskId: { leftTaskId: string; rightTaskId: string } } }) => working.edges.find(edge => edge.leftTaskId === where.leftTaskId_rightTaskId.leftTaskId && edge.rightTaskId === where.leftTaskId_rightTaskId.rightTaskId) ?? null),
      create: vi.fn(async ({ data }: { data: { leftTaskId: string; rightTaskId: string } }) => { working.edges.push(data); return data; }),
      delete: vi.fn(async ({ where }: { where: { leftTaskId_rightTaskId: { leftTaskId: string; rightTaskId: string } } }) => { working.edges = working.edges.filter(edge => edge.leftTaskId !== where.leftTaskId_rightTaskId.leftTaskId || edge.rightTaskId !== where.leftTaskId_rightTaskId.rightTaskId); }),
    },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => { if (options.failHistory) throw Error("synthetic-storage"); working.activities.push(data); return data; }) },
    taskCommandOperation: { findUnique: vi.fn(async () => working.receipts[0] ?? null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { working.receipts.push(data); return data; }) },
  };
  const database = { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => { working = structuredClone(state); const result = await run(tx); Object.assign(state, working); return result; } };
  return { state, tx, options, read: () => readRelatedRequests(database as never, options.actor, "a"), run: (command = body) => changeRelatedRequests(database as never, command) };
}
beforeEach(() => vi.clearAllMocks());
describe("related-request visible graph and shared command", () => {
  it("projects a transitive group with direct-first stable ordering, without changing the original tasks", async () => {
    const f = fixture(); f.state.edges = [{ leftTaskId: "a", rightTaskId: "b" }, { leftTaskId: "b", rightTaskId: "c" }];
    expect(await f.read()).toMatchObject({ taskId: "a", version: 7, canManage: true, limited: false, items: [{ id: "b", isDirect: true }, { id: "c", isDirect: false }] });
    expect(f.state.tasks.every(row => row.version === 7)).toBe(true);
    expect(f.tx.taskRelation.findMany.mock.calls[0][0].where.AND).toHaveLength(3);
  });
  it("does not traverse a hidden bridge, reveal its ID/title/count, or indicate a hidden limit", async () => {
    const f = fixture(); f.state.edges = [{ leftTaskId: "a", rightTaskId: "b" }, { leftTaskId: "b", rightTaskId: "c" }]; f.options.hidden.add("b");
    expect(await f.read()).toEqual({ taskId: "a", version: 7, canManage: true, items: [], limited: false });
  });
  it("deduplicates cycles and caps a large visible component explicitly", async () => {
    const f = fixture(); for (let i = 0; i < 110; i++) { const name = `node${i}`; f.state.tasks.push(task(name)); f.state.edges.push({ leftTaskId: "a", rightTaskId: name }); }
    const result = await f.read(); expect(result.items).toHaveLength(99); expect(result.limited).toBe(true); expect(new Set(result.items.map(row => row.id)).size).toBe(99);
  });
  it("adds one canonical edge and exactly two mandatory history events/version increments; exact retry is read-only", async () => {
    const f = fixture(); const result = await f.run(); expect(result.projection).toMatchObject({ version: 8, items: [{ id: "b", isDirect: true }] });
    expect(f.state.edges).toHaveLength(1); expect(f.state.tasks.slice(0, 2).map(row => row.version)).toEqual([8, 8]); expect(f.state.activities).toHaveLength(2);
    expect(await f.run()).toMatchObject({ changed: false, affected: [], projection: { version: 8 } }); expect(f.state.activities).toHaveLength(2); expect(f.state.receipts).toHaveLength(1);
  });
  it("deletes a bridge only, preserving the remainder of the old group", async () => {
    const f = fixture(); f.state.edges = [{ leftTaskId: "a", rightTaskId: "b" }, { leftTaskId: "b", rightTaskId: "c" }];
    expect(await f.run({ ...body, action: "remove" as never })).toMatchObject({ projection: { items: [] } }); expect(f.state.edges).toEqual([{ leftTaskId: "b", rightTaskId: "c" }]);
    expect(f.state.activities).toEqual([expect.objectContaining({ action: "related_request_removed", oldValue: { relatedTaskId: "b" } }), expect.objectContaining({ oldValue: { relatedTaskId: "a" } })]);
  });
  it("treats repeated add and absent remove as durable no-ops", async () => {
    const f = fixture(); f.state.edges.push({ leftTaskId: "a", rightTaskId: "b" }); expect(await f.run()).toMatchObject({ changed: false }); expect(f.state.activities).toEqual([]); expect(f.state.tasks[0].version).toBe(7);
  });
  it("rejects stale version, altered replay intent and corrupt receipt", async () => {
    const f = fixture(); await expect(f.run({ ...body, expectedVersion: 6 })).rejects.toMatchObject({ code: "STALE_TASK_VERSION" }); await f.run();
    await expect(f.run({ ...body, action: "remove" as never })).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" }); f.state.receipts[0].committedVersion = 55;
    await expect(f.run()).rejects.toMatchObject({ code: "INVALID_RECEIPT" });
  });
  it.each(["cas", "failHistory"] as const)("rolls back edge, both versions and receipt after %s", async failure => {
    const f = fixture(); f.options[failure] = true; await expect(f.run()).rejects.toBeDefined(); expect(f.state.edges).toEqual([]); expect(f.state.tasks[0].version).toBe(7); expect(f.state.activities).toEqual([]); expect(f.state.receipts).toEqual([]);
  });
  it("denies ordinary readers/watchers while allowing an explicitly scoped updater", async () => {
    const f = fixture(); f.options.actor = "watcher"; expect((await f.read()).canManage).toBe(false); await expect(f.run({ ...body, actorId: "watcher" })).rejects.toBeInstanceOf(ForbiddenError);
    f.options.grants = [{ scopeKind: "board", projectId: "project", departmentId: null, profile: { permissions: ["request.update"] } }];
    expect((await f.read()).canManage).toBe(true); await expect(f.run({ ...body, actorId: "watcher" })).resolves.toMatchObject({ changed: true });
  });
  it("rechecks hidden target, revoked source and blocked actor even on receipt replay", async () => {
    const f = fixture(); await f.run(); f.options.hidden.add("b"); await expect(f.run()).rejects.toBeInstanceOf(NotFoundError); f.options.hidden.clear(); f.options.blocked = true;
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundError); await expect(f.run()).rejects.toBeInstanceOf(NotFoundError);
  });
  it("rejects self-link and malformed commands before a transaction", async () => { const f = fixture(); await expect(f.run({ ...body, relatedTaskId: "a" })).rejects.toMatchObject({ code: "INVALID_COMMAND" }); expect(f.tx.$queryRaw).not.toHaveBeenCalled(); });
  it("uses the canonical current executor rather than legacy assignment rows on marked requests", async () => {
    const f = fixture(); f.options.actor = "executor";
    f.state.tasks[0].request = { taskId: "a", contractVersion: 1, state: "IN_PROGRESS", authorId: "author", executorId: "executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null } as never;
    expect((await f.read()).canManage).toBe(true);
    f.state.tasks[0].request = { ...f.state.tasks[0].request as unknown as object, executorId: "replacement" } as never;
    f.state.tasks[0].assignees = [{ userId: "executor" }];
    expect((await f.read()).canManage).toBe(false);
    await expect(f.run({ ...body, actorId: "executor" })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("does not grant read-only departmental staff, archived leaders or an outside-scope updater management", async () => {
    const f = fixture(); f.options.actor = "leader";
    f.state.tasks[0].project.department = { id: "department", archivedAt: null, leaderId: "leader" } as never;
    // Department leadership is canonical submitted read only, never management.
    expect((await f.read()).canManage).toBe(false);
    await expect(f.run({ ...body, actorId: "leader" })).rejects.toBeInstanceOf(ForbiddenError);
    f.options.grants = [{ scopeKind: "board", projectId: "project", departmentId: null, profile: { permissions: ["request.update"] } }];
    expect((await f.read()).canManage).toBe(true);
    f.options.grants = [{ scopeKind: "board", projectId: "other", departmentId: null, profile: { permissions: ["request.update"] } }];
    expect((await f.read()).canManage).toBe(false);
  });
  it("keeps canonical management for an active responsible-group leader with membership", async () => {
    const f = fixture(); f.options.actor = "lead";
    f.state.tasks[0].project.responsibleGroup = { id: "group", archivedAt: null, leaderId: "lead", members: [{ userId: "lead" }] } as never;
    expect((await f.read()).canManage).toBe(true);
    f.state.tasks[0].project.responsibleGroup = { id: "group", archivedAt: null, leaderId: "lead", members: [{ userId: "other" }] } as never;
    expect((await f.read()).canManage).toBe(false);
  });
  it("never grants foreign management through an OWN-visibility update profile", async () => {
    const f = fixture(); f.options.actor = "member"; f.state.tasks[0].request = marker("a") as never;
    f.options.grants = [{ scopeKind: "board", projectId: "project", departmentId: null, profile: { permissions: { permissions: ["request.update"], visibility: "own" } } }];
    expect((await f.read()).canManage).toBe(false);
    await expect(f.run({ ...body, actorId: "member" })).rejects.toBeInstanceOf(ForbiddenError);
    f.options.grants = [{ scopeKind: "board", projectId: "project", departmentId: null, profile: { permissions: { permissions: ["request.update"], visibility: "board" } } }];
    expect((await f.read()).canManage).toBe(true);
    // The canonical author keeps management independently of OWN visibility.
    f.options.actor = "author"; expect((await f.read()).canManage).toBe(true);
  });
  it("treats malformed persisted grants as no grant instead of a 500", async () => {
    const f = fixture(); f.options.actor = "member";
    f.options.grants = [{ scopeKind: "board", projectId: "project", departmentId: null, profile: { permissions: ["request.update", "request.read"] } }];
    await expect(f.read()).resolves.toMatchObject({ canManage: false });
    await expect(f.run({ ...body, actorId: "member" })).rejects.toBeInstanceOf(ForbiddenError);
    f.options.grants = [{ scopeKind: "board", projectId: "project", departmentId: null, profile: { permissions: ["request.update", "request.update"] } }];
    await expect(f.read()).resolves.toMatchObject({ canManage: false });
    f.options.grants = [{ scopeKind: "board", projectId: "project", departmentId: null, profile: { permissions: ["request.read"] } }];
    await expect(f.read()).resolves.toMatchObject({ canManage: false });
  });
  it("denies a nonmanager before any target identity, read or lock lookup", async () => {
    const f = fixture(); f.options.actor = "watcher";
    await expect(f.run({ ...body, actorId: "watcher" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run({ ...body, actorId: "watcher", relatedTaskId: "missing" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(f.tx.task.findFirst.mock.calls.map(call => (call[0] as { where: { id: string } }).where.id)).toEqual(["a", "a"]);
    expect(f.tx.task.findMany).not.toHaveBeenCalled(); expect(f.tx.taskRelation.findUnique).not.toHaveBeenCalled();
  });
  it("hides a deleted or corrupt-marker neighbor without letting it bridge the graph", async () => {
    const f = fixture(); f.state.edges = [{ leftTaskId: "a", rightTaskId: "b" }, { leftTaskId: "b", rightTaskId: "c" }];
    f.state.tasks.find(row => row.id === "b")!.request = marker("b", { deletedAt: new Date() }) as never;
    expect(await f.read()).toMatchObject({ items: [] });
    f.state.tasks.find(row => row.id === "b")!.request = marker("b", { contractVersion: 999 }) as never;
    expect(await f.read()).toMatchObject({ items: [] });
  });
  it("does not let a malformed/deleted request marker authorize links", async () => {
    const f = fixture(); f.state.tasks[0].request = { taskId: "a", contractVersion: 999, state: "IN_PROGRESS", authorId: "author", executorId: null, needsInfoSince: null, pausedTotalMs: 0, deletedAt: null } as never;
    await expect(f.read()).rejects.toMatchObject({ code: "INVALID_REQUEST_MARKER" });
    f.state.tasks[0].request = { ...f.state.tasks[0].request as unknown as object, contractVersion: 1, deletedAt: new Date() } as never;
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundError);
  });
});
