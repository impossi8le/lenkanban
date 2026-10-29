import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createOrganizationService, type OrganizationService } from "./organization";

type LegacyService = { [K in keyof OrganizationService]: (input: Omit<Parameters<OrganizationService[K]>[0], "operationId" | "expectedVersion">) => Promise<Awaited<ReturnType<OrganizationService[K]>>["result"]> };

type DepartmentRow = { id: string; name: string; parentId: string | null; leaderId: string | null; archivedAt: Date | null };
type GroupRow = { id: string; name: string; archivedAt: Date | null };
type UserRow = { id: string; globalRole: string; primaryDepartmentId: string | null };
const actorId = "admin";
const archived = new Date("2026-10-01T00:00:00Z");
function department(id = "department", parentId: string | null = null): DepartmentRow { return { id, name: id, parentId, leaderId: null, archivedAt: null }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function fixture() {
  const calls: string[] = [];
  const departments = new Map<string, DepartmentRow>([["department", department()], ["parent", department("parent")]]);
  const groups = new Map<string, GroupRow>([["group", { id: "group", name: "group", archivedAt: null }], ["other-group", { id: "other-group", name: "other", archivedAt: null }]]);
  const users = new Map<string, UserRow>([[actorId, { id: actorId, globalRole: "ADMIN", primaryDepartmentId: null }], ["target", { id: "target", globalRole: "USER", primaryDepartmentId: "old-department" }]]);
  const projects = new Map([["project", { id: "project", departmentId: null as string | null, responsibleGroupId: null as string | null, lifecycleColumnMap: null as import("./task-request-columns").LifecycleColumnMap | null }], ["other-project", { id: "other-project", departmentId: null as string | null, responsibleGroupId: null as string | null, lifecycleColumnMap: null as import("./task-request-columns").LifecycleColumnMap | null }]]);
  const members = new Set<string>();
  const state = { id: "organization", version: 0 };
  const receipts = new Map<string, Record<string, unknown>>();
  const trace = (name: string) => { calls.push(name); };
  let lockWait: Promise<void> | undefined;
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join("?").includes("pg_advisory_xact_lock")) { trace("lock"); if (lockWait) await lockWait; return [{ locked: "" }]; }
      if (sql.join("?").includes('FROM "ProjectColumn"')) return [{ id: values[0], projectId: "project", workflowKey: values[0] === "closed" ? "DONE" : values[0] === "resolved" ? "REVIEW" : values[0] === "new" ? "TODO" : values[0] === "work" ? "IN_PROGRESS" : "CUSTOM" }];
      if (sql.join("?").includes('FROM "Project"')) { trace("project-lock"); return projects.has(String(values[0])) ? [{ id: values[0] }] : []; }
      trace("actor-lock"); return users.has(String(values[0])) ? [{ id: values[0] }] : [];
    }),
    user: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => { trace("user.findUnique"); const row = users.get(where.id); return row ? Object.fromEntries(Object.entries(row).filter(([key]) => !select || select[key])) : null; }),
      count: vi.fn(async () => { trace("user.count"); return 0; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { primaryDepartmentId: string | null } }) => { trace("user.update"); const row = users.get(where.id)!; Object.assign(row, data); return { id: row.id, primaryDepartmentId: row.primaryDepartmentId }; }),
    },
    department: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { trace("department.findUnique"); return departments.get(where.id) ?? null; }),
      count: vi.fn(async () => { trace("department.count"); return 0; }),
      create: vi.fn(async ({ data }: { data: { name: string; parentId: string | null } }) => { trace("department.create"); const row = { ...department("new-department"), ...data }; departments.set(row.id, row); return row; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DepartmentRow> }) => { trace("department.update"); const row = departments.get(where.id)!; Object.assign(row, data); return row; }),
    },
    responsibleGroup: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { trace("group.findUnique"); return groups.get(where.id) ?? null; }),
      create: vi.fn(async ({ data }: { data: { name: string } }) => { trace("group.create"); const row = { id: "new-group", archivedAt: null, ...data }; groups.set(row.id, row); return row; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<GroupRow> }) => { trace("group.update"); const row = groups.get(where.id)!; Object.assign(row, data); return row; }),
    },
    responsibleGroupMember: {
      findMany: vi.fn(async ({ where }: { where: { groupId: string } }) => [...members].filter(key => key.startsWith(where.groupId + '/')).map(key => ({ userId: key.slice(where.groupId.length + 1) }))),
      findUnique: vi.fn(async ({ where }: { where: { groupId_userId: { groupId: string; userId: string } } }) => members.has(`${where.groupId_userId.groupId}/${where.groupId_userId.userId}`) ? { ...where.groupId_userId } : null),
      createMany: vi.fn(async ({ data }: { data: { groupId: string; userId: string }[] }) => { trace("member.createMany"); let count = 0; for (const value of data) { const key = `${value.groupId}/${value.userId}`; if (!members.has(key)) { members.add(key); count++; } } return { count }; }),
      deleteMany: vi.fn(async ({ where }: { where: { groupId: string; userId: string } }) => { trace("member.deleteMany"); return { count: members.delete(`${where.groupId}/${where.userId}`) ? 1 : 0 }; }),
    },
    project: {
      create: vi.fn(async ({ data }: { data: { departmentId: string; responsibleGroupId: string | null } }) => {
        trace("project.create");
        const row = { id: "new-board", departmentId: data.departmentId, responsibleGroupId: data.responsibleGroupId, lifecycleColumnMap: null };
        projects.set(row.id, row); return { id: row.id, departmentId: row.departmentId, responsibleGroupId: row.responsibleGroupId };
      }),
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => { trace("project.findUnique"); const row = projects.get(where.id); return row ? Object.fromEntries(Object.entries(row).filter(([key]) => !select || select[key])) : null; }),
      count: vi.fn(async () => { trace("project.count"); return 0; }),
      update: vi.fn(async ({ where, data, select }: { where: { id: string }; data: { departmentId: string | null; responsibleGroupId: string | null }; select?: Record<string, unknown> }) => { trace("project.update"); const row = projects.get(where.id)!; Object.assign(row, data); return Object.fromEntries(Object.entries(row).filter(([key]) => !select || select[key])); }),
    },
    taskRequest: { count: vi.fn(async () => 0) },
    organizationState: {
      upsert: vi.fn(async () => ({ ...state })),
      update: vi.fn(async ({ data }: { data: { version: number } }) => { state.version = data.version; return { ...state }; }),
    },
    organizationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { actorId_operationId: { actorId: string; operationId: string } } }) => receipts.get(`${where.actorId_operationId.actorId}/${where.actorId_operationId.operationId}`) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const receipt = structuredClone({ ...data, before: data.before === Prisma.JsonNull ? null : data.before });
        receipts.set(`${data.actorId}/${data.operationId}`, receipt); return receipt;
      }),
    },
  };
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>, options?: { isolationLevel: string }) => { void options; calls.push("transaction"); return callback(tx); });
  const rawService = createOrganizationService({ $transaction: transaction } as unknown as Parameters<typeof createOrganizationService>[0]);
  // Only legacy scenario setup uses automatic fresh metadata. Command contracts
  // below call rawService with explicit operation IDs and versions.
  const service = Object.fromEntries(Object.entries(rawService).map(([name, method]) => [name, (input: object) => {
    const command = method as (input: object) => Promise<{ result: unknown }>;
    return command({ ...input, operationId: randomUUID(), expectedVersion: state.version }).then(value => value.result);
  }])) as LegacyService;
  return { service, rawService, state, receipts, tx, transaction, calls, departments, groups, users, projects, members, waitForLock: (promise: Promise<void>) => { lockWait = promise; } };
}
const operations: [keyof OrganizationService, (service: LegacyService) => Promise<unknown>][] = [
  ["createBoard", s => s.createBoard({ actorId, name: "New", departmentId: "department", responsibleGroupId: "group" })],
  ["createDepartment", s => s.createDepartment({ actorId, name: "New", parentId: "parent" })],
  ["renameDepartment", s => s.renameDepartment({ actorId, departmentId: "department", name: "New" })],
  ["moveDepartment", s => s.moveDepartment({ actorId, departmentId: "department", parentId: "parent" })],
  ["setDepartmentArchived", s => s.setDepartmentArchived({ actorId, departmentId: "department", archived: true })],
  ["setDepartmentLeader", s => s.setDepartmentLeader({ actorId, departmentId: "department", userId: "target" })],
  ["assignUserDepartment", s => s.assignUserDepartment({ actorId, userId: "target", departmentId: "department" })],
  ["createGroup", s => s.createGroup({ actorId, name: "New" })],
  ["renameGroup", s => s.renameGroup({ actorId, groupId: "group", name: "New" })],
  ["setGroupArchived", s => s.setGroupArchived({ actorId, groupId: "group", archived: true })],
  ["setGroupMember", s => s.setGroupMember({ actorId, groupId: "group", userId: "target", member: true })],
  ["bindProject", s => s.bindProject({ actorId, projectId: "project", departmentId: "department", responsibleGroupId: "group" })],
];

describe("explicit lifecycle column configuration", () => {
  const lifecycleColumnMap = { contractVersion: 1 as const, submittedColumnId: "new", inProgressColumnId: "work", needsInfoColumnId: "waiting", completedColumnId: "resolved", closedColumnId: "closed" };
  it("exposes configuration through the existing audited organization service", () => {
    expect(fixture().rawService).toHaveProperty("setProjectLifecycleColumns");
  });
  it("persists one audited mapping and replays only after fresh ADMIN authorization", async () => {
    const f = fixture(), operationId = randomUUID();
    const input = { actorId, operationId, expectedVersion: 0, projectId: "project", lifecycleColumnMap };
    const first = await f.rawService.setProjectLifecycleColumns(input);
    expect(first).toMatchObject({ version: 1, replayed: false, result: { lifecycleColumnMap } });
    expect(f.calls.slice(0, 5)).toEqual(["transaction", "lock", "project-lock", "actor-lock", "user.findUnique"]);
    expect(f.tx.project.update).toHaveBeenCalledOnce();
    expect(await f.rawService.setProjectLifecycleColumns(input)).toMatchObject({ version: 1, replayed: true });
    expect(f.tx.project.update).toHaveBeenCalledOnce();
    f.users.get(actorId)!.globalRole = "USER";
    await expect(f.rawService.setProjectLifecycleColumns(input)).rejects.toMatchObject({ name: "ForbiddenError" });
  });
  it("refuses mapping edits once a marked request exists, including null reset", async () => {
    const f = fixture(); f.tx.taskRequest.count.mockResolvedValue(1);
    await expect(f.service.setProjectLifecycleColumns({ actorId, projectId: "project", lifecycleColumnMap })).resolves.toMatchObject({ lifecycleColumnMap });
    expect(f.tx.project.update).toHaveBeenCalledOnce();
    for (const mapping of [null, { ...lifecycleColumnMap, needsInfoColumnId: "other" }]) {
      await expect(f.service.setProjectLifecycleColumns({ actorId, projectId: "project", lifecycleColumnMap: mapping })).rejects.toMatchObject({ name: "ConflictError" });
    }
    expect(f.tx.project.update).toHaveBeenCalledOnce(); expect(f.receipts.size).toBe(1);
  });
  it("rejects duplicate or foreign targets without a config write or receipt", async () => {
    const f = fixture();
    await expect(async () => f.service.setProjectLifecycleColumns({ actorId, projectId: "project", lifecycleColumnMap: { ...lifecycleColumnMap, needsInfoColumnId: "work" } })).rejects.toMatchObject({ name: "ValidationError" });
    f.tx.$queryRaw.mockImplementation(async (sql, ...values) => sql.join("?").includes('FROM "ProjectColumn"') ? [] : [{ id: values[0] }]);
    await expect(f.service.setProjectLifecycleColumns({ actorId, projectId: "project", lifecycleColumnMap })).rejects.toMatchObject({ name: "ValidationError" });
    expect(f.tx.project.update).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
  });
});

describe("organization mutation boundary (mock control flow, not PostgreSQL concurrency)", () => {
  it.each(operations)("%s locks first, then reads the current actor inside exactly one transaction", async (_name, run) => {
    const f = fixture(); await run(f.service);
    expect(f.transaction).toHaveBeenCalledOnce(); expect(f.calls.slice(0, 4)).toEqual(["transaction", "lock", "actor-lock", "user.findUnique"]);
    expect(f.transaction.mock.calls[0][1]).toEqual({ isolationLevel: "ReadCommitted" });
    expect(f.tx.user.findUnique.mock.calls[0][0]).toEqual({ where: { id: actorId }, select: { id: true, globalRole: true } });
    const lock = f.tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(lock[0].join("?")).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(lock.slice(1)).toEqual(["organization-topology-v1"]);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    const actorLock = f.tx.$queryRaw.mock.calls[1];
    expect(actorLock[0].join("?")).toBe('SELECT "id" FROM "User" WHERE "id" = ? FOR SHARE');
    expect(actorLock.slice(1)).toEqual([actorId]);
  });
  it.each(operations)("%s rejects a current ordinary user without reading resources or attempting writes", async (_name, run) => {
    const f = fixture(); f.users.get(actorId)!.globalRole = "USER";
    await expect(run(f.service)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(f.calls).toEqual(["transaction", "lock", "actor-lock", "user.findUnique"]);
  });
  it("rejects a missing actor and never trusts an extra caller-supplied ADMIN field", async () => {
    const f = fixture(); f.users.delete(actorId);
    await expect(f.service.createGroup({ actorId, name: "New", globalRole: "ADMIN" } as Parameters<LegacyService["createGroup"]>[0])).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.calls).toEqual(["transaction", "lock", "actor-lock", "user.findUnique"]);
  });
  it("observes an actor demotion while waiting for the lock, before all identity/topology reads", async () => {
    const f = fixture(), gate = deferred(); f.waitForLock(gate.promise);
    const pending = f.service.bindProject({ actorId, projectId: "project", departmentId: "department", responsibleGroupId: "group" });
    expect(f.calls).toEqual(["transaction", "lock"]);
    f.users.get(actorId)!.globalRole = "USER"; gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(f.tx.project.update).not.toHaveBeenCalled(); expect(f.tx.department.findUnique).not.toHaveBeenCalled();
  });
  it.each(["lock", "actor-lock", "actor", "transaction", "write"])("propagates a %s failure rather than returning false success", async stage => {
    const f = fixture(), failure = new Error(`synthetic ${stage}`);
    if (stage === "lock") f.tx.$queryRaw.mockRejectedValue(failure);
    else if (stage === "actor-lock") f.tx.$queryRaw.mockResolvedValueOnce([{ locked: "" }]).mockRejectedValueOnce(failure);
    else if (stage === "actor") f.tx.user.findUnique.mockRejectedValue(failure);
    else if (stage === "transaction") f.transaction.mockRejectedValue(failure);
    else f.tx.department.create.mockRejectedValue(failure);
    await expect(f.service.createDepartment({ actorId, name: "New" })).rejects.toBe(failure);
    if (stage !== "write") expect(f.tx.department.create).not.toHaveBeenCalled();
  });
});

describe("input validation and closed writes", () => {
  it.each(["", "x".repeat(129), "department'; DROP TABLE User;--", "dept/child", "кириллица", "a\nb", "a\0b", " a"])("rejects unsafe identifiers before database activity: %j", async departmentId => {
    const f = fixture(); expect(() => f.service.moveDepartment({ actorId, departmentId, parentId: null })).toThrowError(expect.objectContaining({ name: "ValidationError" }));
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each(["", " \n\t ", "x".repeat(121), null, 123])("rejects invalid names %j before database activity", name => {
    const f = fixture(); expect(() => f.service.createDepartment({ actorId, name: name as string })).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("trims names and persists SQL-shaped content only as an ordinary ORM data value", async () => {
    const f = fixture(), name = "Robert'); DROP TABLE Department;--";
    await f.service.createDepartment({ actorId, name: `  ${name}  ` });
    expect(f.tx.department.create).toHaveBeenCalledWith({ data: { name, parentId: null } });
    const rawValues = f.tx.$queryRaw.mock.calls.flat(); expect(rawValues).not.toContain(name);
  });
  it("allows the documented maximum ID and trimmed name length", async () => {
    const f = fixture(), id = "x".repeat(128); f.departments.set(id, { ...department(id), name: "Existing" });
    await f.service.renameDepartment({ actorId, departmentId: id, name: ` ${"n".repeat(120)} ` });
    expect(f.tx.department.update).toHaveBeenCalledWith({ where: { id }, data: { name: "n".repeat(120) } });
  });
  it("validates actor, nullable links, and booleans without coercion", () => {
    const f = fixture();
    const invalid = [() => f.service.createGroup({ actorId: "bad actor", name: "New" }), () => f.service.bindProject({ actorId, projectId: "project", departmentId: undefined as unknown as null, responsibleGroupId: null }), () => f.service.setGroupArchived({ actorId, groupId: "group", archived: "false" as unknown as boolean }), () => f.service.setGroupMember({ actorId, groupId: "group", userId: "target", member: 1 as unknown as boolean })];
    for (const run of invalid) expect(run).toThrowError(expect.objectContaining({ name: "ValidationError" }));
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("changes only the scalar primary department and returns no identity/role fields", async () => {
    const f = fixture();
    expect(await f.service.assignUserDepartment({ actorId, userId: "target", departmentId: "department" })).toEqual({ id: "target", primaryDepartmentId: "department" });
    expect(f.tx.user.update).toHaveBeenLastCalledWith({ where: { id: "target" }, data: { primaryDepartmentId: "department" }, select: { id: true, primaryDepartmentId: true } });
    await f.service.assignUserDepartment({ actorId, userId: "target", departmentId: "parent" });
    expect(f.users.get("target")!.primaryDepartmentId).toBe("parent"); expect(f.users.get("target")!.globalRole).toBe("USER");
    expect(f.tx.responsibleGroupMember.createMany).not.toHaveBeenCalled(); expect(f.tx.project.update).not.toHaveBeenCalled();
    await f.service.assignUserDepartment({ actorId, userId: "target", departmentId: null }); expect(f.users.get("target")!.primaryDepartmentId).toBeNull();
  });
  it("allows independent cross-department group membership and one group on multiple boards", async () => {
    const f = fixture();
    await f.service.setGroupMember({ actorId, groupId: "group", userId: "target", member: true });
    await f.service.setGroupMember({ actorId, groupId: "other-group", userId: "target", member: true });
    for (const projectId of ["project", "other-project"]) {
      expect(await f.service.bindProject({ actorId, projectId, departmentId: "parent", responsibleGroupId: "group" })).toEqual({ id: projectId, departmentId: "parent", responsibleGroupId: "group" });
    }
    expect([...f.members]).toEqual(["group/target", "other-group/target"]);
    expect(f.users.get("target")!.primaryDepartmentId).toBe("old-department"); expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.project.update.mock.calls[0][0]).toEqual({ where: { id: "project" }, data: { departmentId: "parent", responsibleGroupId: "group" }, select: { id: true, departmentId: true, responsibleGroupId: true } });
  });
  it("idempotently adds/removes group membership without role grants", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) expect(await f.service.setGroupMember({ actorId, groupId: "group", userId: "target", member: true })).toEqual({ groupId: "group", userId: "target", member: true });
    expect(f.members.size).toBe(1); expect(f.tx.responsibleGroupMember.createMany).toHaveBeenCalledWith({ data: [{ groupId: "group", userId: "target" }], skipDuplicates: true });
    for (let i = 0; i < 2; i++) await f.service.setGroupMember({ actorId, groupId: "group", userId: "target", member: false });
    expect(f.members.size).toBe(0); expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("sets/clears a department leader without changing that user's role or membership", async () => {
    const f = fixture(); await f.service.setDepartmentLeader({ actorId, departmentId: "department", userId: "target" });
    expect(f.departments.get("department")!.leaderId).toBe("target"); expect(f.tx.user.update).not.toHaveBeenCalled();
    await f.service.setDepartmentLeader({ actorId, departmentId: "department", userId: null }); expect(f.departments.get("department")!.leaderId).toBeNull();
  });
});

describe("versioned organization command receipts (mock flow, not rollback proof)", () => {
  const command = (expectedVersion = 0, operationId = randomUUID()) => ({ actorId, operationId, expectedVersion });
  it("creates a board with required department and replays once without auditing its name", async () => {
    const f = fixture(), input = { ...command(), name: "synthetic private name", departmentId: "department", responsibleGroupId: "group" };
    const first = await f.rawService.createBoard(input);
    expect(first.result).toEqual({ id: "new-board", departmentId: "department", responsibleGroupId: "group" });
    expect(await f.rawService.createBoard(input)).toEqual({ ...first, replayed: true });
    expect(f.tx.project.create).toHaveBeenCalledOnce();
    expect(f.tx.project.create.mock.calls[0][0].data).toMatchObject({ ownerId: actorId, departmentId: "department" });
    expect(JSON.stringify([...f.receipts.values()])).not.toContain(input.name);
    await expect(f.rawService.createBoard({ ...input, name: "Other" })).rejects.toMatchObject({ name: "ConflictError" });
  });
  it.each([null, undefined, ""])("rejects a missing board department %j before transaction", async departmentId => {
    const f = fixture();
    await expect(async () => f.rawService.createBoard({ ...command(), name: "New", departmentId: departmentId as string, responsibleGroupId: null }))
      .rejects.toMatchObject({ name: "ValidationError" });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects a board under an archived ancestor without any write", async () => {
    const f = fixture(); f.departments.get("department")!.parentId = "parent"; f.departments.get("parent")!.archivedAt = archived;
    await expect(f.rawService.createBoard({ ...command(), name: "New", departmentId: "department", responsibleGroupId: null }))
      .rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.project.create).not.toHaveBeenCalled(); expect(f.tx.organizationOperation.create).not.toHaveBeenCalled();
  });
  it("awaits mandatory board audit failure without reporting success (mock, not rollback proof)", async () => {
    const f = fixture(); f.tx.organizationOperation.create.mockRejectedValueOnce(Error("audit unavailable"));
    await expect(f.rawService.createBoard({ ...command(), name: "New", departmentId: "department", responsibleGroupId: null }))
      .rejects.toThrow("audit unavailable");
  });
  it.each(operations)("%s atomically awaits its audit receipt and increments one global version", async (_method, run) => {
    const f = fixture(); await run(f.service);
    expect(f.state.version).toBe(1);
    expect(f.tx.organizationState.update).toHaveBeenCalledOnce();
    expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce();
    const audit = [...f.receipts.values()][0];
    expect(audit).toMatchObject({ actorId, operation: _method, expectedVersion: 0, committedVersion: 1, changed: true });
    expect(audit.after).toEqual(audit.result);
    expect(JSON.stringify(audit)).not.toContain("globalRole");
    expect(JSON.stringify(audit)).not.toContain("archivedAt");
  });
  it("returns the saved earlier result after a later edit without rereading or rewriting resources", async () => {
    const f = fixture(), metadata = command();
    const first = await f.rawService.renameDepartment({ ...metadata, departmentId: "department", name: "First" });
    await f.rawService.renameDepartment({ ...command(1), departmentId: "department", name: "Later" });
    vi.clearAllMocks();
    const replay = await f.rawService.renameDepartment({ ...metadata, departmentId: "department", name: "First" });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(f.departments.get("department")!.name).toBe("Later");
    expect(f.state.version).toBe(2);
    expect(f.tx.organizationState.upsert).not.toHaveBeenCalled();
    expect(f.tx.department.findUnique).not.toHaveBeenCalled();
    expect(f.tx.department.update).not.toHaveBeenCalled();
    expect(f.tx.organizationOperation.create).not.toHaveBeenCalled();
  });
  it.each(["result-extra", "after-mismatch", "before-target", "version", "changed", "actor", "operation", "target", "expected"])("fails closed on a corrupted %s receipt", async corruption => {
    const f = fixture(), metadata = command();
    await f.rawService.renameGroup({ ...metadata, groupId: "group", name: "First" });
    const receipt = [...f.receipts.values()][0];
    if (corruption === "result-extra") receipt.result = { ...(receipt.result as object), passwordHash: "synthetic" };
    if (corruption === "after-mismatch") receipt.after = { id: "group", name: "Other", archived: false };
    if (corruption === "before-target") receipt.before = { id: "other-group", name: "group", archived: false };
    if (corruption === "version") receipt.committedVersion = 4;
    if (corruption === "changed") receipt.changed = false;
    if (corruption === "actor") receipt.actorId = "other-admin";
    if (corruption === "operation") receipt.operation = "createGroup";
    if (corruption === "target") receipt.targetId = "other-group";
    if (corruption === "expected") receipt.expectedVersion = 2;
    vi.clearAllMocks();
    await expect(f.rawService.renameGroup({ ...metadata, groupId: "group", name: "First" }))
      .rejects.toMatchObject({ name: "ConflictError", message: "Invalid saved organization operation" });
    expect(f.tx.responsibleGroup.update).not.toHaveBeenCalled();
    expect(f.tx.organizationOperation.create).not.toHaveBeenCalled();
  });
  it("replays a create without creating a second entity or exposing model timestamps", async () => {
    const f = fixture(), metadata = command();
    const first = await f.rawService.createGroup({ ...metadata, name: "Created" });
    const replay = await f.rawService.createGroup({ ...metadata, name: "Created" });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(f.tx.responsibleGroup.create).toHaveBeenCalledOnce();
    expect(first.result).toEqual({ id: "new-group", name: "Created", archived: false });
    expect(f.state.version).toBe(1); expect(f.receipts.size).toBe(1);
  });
  it("normalizes operation UUID case on replay", async () => {
    const f = fixture(), metadata = command();
    await f.rawService.renameGroup({ ...metadata, groupId: "group", name: "Renamed" });
    expect(await f.rawService.renameGroup({ ...metadata, operationId: metadata.operationId.toUpperCase(), groupId: "group", name: " Renamed " }))
      .toMatchObject({ version: 1, replayed: true });
    expect(f.receipts.size).toBe(1);
  });
  it.each(["payload", "target", "method", "version"])("rejects reused operation ID with a different %s", async change => {
    const f = fixture(), metadata = command();
    await f.rawService.renameGroup({ ...metadata, groupId: "group", name: "Renamed" });
    const input = { ...metadata, groupId: change === "target" ? "other-group" : "group", name: change === "payload" ? "Other" : "Renamed",
      expectedVersion: change === "version" ? 1 : 0 };
    await expect(change === "method" ? f.rawService.renameDepartment({ ...metadata, departmentId: "department", name: "Renamed" })
      : f.rawService.renameGroup(input)).rejects.toMatchObject({ name: "ConflictError", message: "Organization operation ID already used" });
    expect(f.receipts.size).toBe(1); expect(f.state.version).toBe(1);
  });
  it("scopes operation IDs to the current actor instead of replaying another administrator's result", async () => {
    const f = fixture(), metadata = command();
    f.users.set("other-admin", { id: "other-admin", globalRole: "ADMIN", primaryDepartmentId: null });
    await f.rawService.renameGroup({ ...metadata, groupId: "group", name: "First" });
    const second = await f.rawService.renameGroup({ ...metadata, actorId: "other-admin", expectedVersion: 1, groupId: "group", name: "Second" });
    expect(second).toMatchObject({ version: 2, replayed: false, result: { name: "Second" } });
    expect(f.receipts.size).toBe(2);
  });
  it.each(["demoted", "deleted"])("rechecks a %s actor before returning a saved result", async scenario => {
    const f = fixture(), metadata = command();
    await f.rawService.renameGroup({ ...metadata, groupId: "group", name: "First" });
    if (scenario === "demoted") f.users.get(actorId)!.globalRole = "USER"; else f.users.delete(actorId);
    vi.clearAllMocks();
    await expect(f.rawService.renameGroup({ ...metadata, groupId: "group", name: "First" }))
      .rejects.toMatchObject({ name: scenario === "demoted" ? "ForbiddenError" : "NotFoundError" });
    expect(f.tx.organizationOperation.findUnique).not.toHaveBeenCalled();
  });
  it("conflicts on global version across different resource types before entity reads", async () => {
    const f = fixture();
    await f.rawService.renameGroup({ ...command(), groupId: "group", name: "First" });
    vi.clearAllMocks();
    await expect(f.rawService.renameDepartment({ ...command(), departmentId: "department", name: "Other" }))
      .rejects.toMatchObject({ name: "ConflictError", message: "Organization version conflict" });
    expect(f.tx.department.findUnique).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(1);
  });
  it.each(["receipt-read", "state-read", "state-write", "audit-write"])("propagates %s failure without false success", async stage => {
    const f = fixture(), failure = Error(`synthetic ${stage}`);
    if (stage === "receipt-read") f.tx.organizationOperation.findUnique.mockRejectedValue(failure);
    if (stage === "state-read") f.tx.organizationState.upsert.mockRejectedValue(failure);
    if (stage === "state-write") f.tx.organizationState.update.mockRejectedValue(failure);
    if (stage === "audit-write") f.tx.organizationOperation.create.mockRejectedValue(failure);
    await expect(f.rawService.renameGroup({ ...command(), groupId: "group", name: "First" })).rejects.toBe(failure);
    // This fixture deliberately does not simulate database rollback.
  });
  it("does not resolve business success before the mandatory audit insert completes", async () => {
    const f = fixture(), gate = deferred(); let settled = false;
    f.tx.organizationOperation.create.mockImplementationOnce(async () => { await gate.promise; throw Error("audit unavailable"); });
    const pending = f.rawService.renameGroup({ ...command(), groupId: "group", name: "First" }).finally(() => { settled = true; });
    const result = expect(pending).rejects.toThrow("audit unavailable");
    await vi.waitFor(() => expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce());
    expect(settled).toBe(false); gate.resolve(); await result;
  });
  it("rejects changed commands at MAX version before entity writes but accepts a no-op receipt", async () => {
    const f = fixture(); f.state.version = 2147483647;
    await expect(f.rawService.renameGroup({ ...command(f.state.version), groupId: "group", name: "Changed" }))
      .rejects.toMatchObject({ name: "ConflictError", message: "Organization version exhausted" });
    expect(f.tx.responsibleGroup.update).not.toHaveBeenCalled();
    expect(await f.rawService.renameGroup({ ...command(f.state.version), groupId: "group", name: "group" }))
      .toMatchObject({ version: 2147483647, replayed: false });
    expect(f.tx.organizationState.update).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(1);
  });
  it("records distinct no-op commands without business writes or version increments and replays them", async () => {
    const f = fixture(); f.users.get("target")!.primaryDepartmentId = null;
    const inputs = [
      () => f.rawService.renameDepartment({ ...command(), departmentId: "department", name: "department" }),
      () => f.rawService.moveDepartment({ ...command(), departmentId: "department", parentId: null }),
      () => f.rawService.setDepartmentArchived({ ...command(), departmentId: "department", archived: false }),
      () => f.rawService.setDepartmentLeader({ ...command(), departmentId: "department", userId: null }),
      () => f.rawService.assignUserDepartment({ ...command(), userId: "target", departmentId: null }),
      () => f.rawService.renameGroup({ ...command(), groupId: "group", name: "group" }),
      () => f.rawService.setGroupArchived({ ...command(), groupId: "group", archived: false }),
      () => f.rawService.setGroupMember({ ...command(), groupId: "group", userId: "target", member: false }),
      () => f.rawService.bindProject({ ...command(), projectId: "project", departmentId: null, responsibleGroupId: null }),
    ];
    for (const run of inputs) expect(await run()).toMatchObject({ version: 0, replayed: false });
    expect(f.receipts.size).toBe(9); expect([...f.receipts.values()].every(row => row.changed === false)).toBe(true);
    expect(f.tx.organizationState.update).not.toHaveBeenCalled(); expect(f.state.version).toBe(0);
    for (const write of [f.tx.department.update, f.tx.user.update, f.tx.responsibleGroup.update, f.tx.project.update,
      f.tx.responsibleGroupMember.createMany, f.tx.responsibleGroupMember.deleteMany]) expect(write).not.toHaveBeenCalled();
    const metadata = command();
    await f.rawService.renameGroup({ ...metadata, groupId: "group", name: "group" });
    expect(await f.rawService.renameGroup({ ...metadata, groupId: "group", name: "group" })).toMatchObject({ version: 0, replayed: true });
    expect(f.receipts.size).toBe(10);
  });
});

describe("hierarchy safety", () => {
  it.each(["department", "group", "user", "project"])("rejects a missing %s without attempting a mutation", async resource => {
    const f = fixture(); let pending: Promise<unknown>;
    if (resource === "department") { f.departments.delete("department"); pending = f.service.renameDepartment({ actorId, departmentId: "department", name: "New" }); }
    else if (resource === "group") { f.groups.delete("group"); pending = f.service.renameGroup({ actorId, groupId: "group", name: "New" }); }
    else if (resource === "user") { f.users.delete("target"); pending = f.service.setDepartmentLeader({ actorId, departmentId: "department", userId: "target" }); }
    else { f.projects.delete("project"); pending = f.service.bindProject({ actorId, projectId: "project", departmentId: "department", responsibleGroupId: "group" }); }
    await expect(pending).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.tx.department.update).not.toHaveBeenCalled(); expect(f.tx.responsibleGroup.update).not.toHaveBeenCalled(); expect(f.tx.project.update).not.toHaveBeenCalled();
  });
  it.each(["self", "descendant", "corrupt-current", "corrupt-target", "archived-target", "archived-ancestor"])("rejects %s before updating topology", async scenario => {
    const f = fixture(); let parentId: string | null = "parent";
    if (scenario === "self") parentId = "department";
    if (scenario === "descendant") f.departments.get("parent")!.parentId = "department";
    if (scenario === "corrupt-current") { f.departments.get("department")!.parentId = "department"; parentId = null; }
    if (scenario === "corrupt-target") f.departments.get("parent")!.parentId = "parent";
    if (scenario === "archived-target") f.departments.get("parent")!.archivedAt = archived;
    if (scenario === "archived-ancestor") { f.departments.set("ancestor", { ...department("ancestor"), archivedAt: archived }); f.departments.get("parent")!.parentId = "ancestor"; }
    await expect(f.service.moveDepartment({ actorId, departmentId: "department", parentId })).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.department.update).not.toHaveBeenCalled();
  });
  it("supports moving a healthy department to root", async () => {
    const f = fixture(); f.departments.get("department")!.parentId = "parent";
    await f.service.moveDepartment({ actorId, departmentId: "department", parentId: null });
    expect(f.tx.department.update).toHaveBeenCalledWith({ where: { id: "department" }, data: { parentId: null } });
  });
  it("moves a subtree without transferring employees or touching legacy project memberships", async () => {
    const f = fixture(); f.departments.get("department")!.parentId = "parent";
    await f.service.moveDepartment({ actorId, departmentId: "department", parentId: null });
    // A node move is topology-only: the employee keeps the same scalar primary
    // department and ProjectMember rows are neither read nor written here.
    expect(f.users.get("target")!.primaryDepartmentId).toBe("old-department");
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.responsibleGroupMember.createMany).not.toHaveBeenCalled();
    expect(f.tx.responsibleGroupMember.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.project.update).not.toHaveBeenCalled();
  });
  it("stops traversing an overlong chain without writes", async () => {
    const f = fixture(); for (let i = 0; i < 1001; i++) f.departments.set(`d${i}`, department(`d${i}`, i === 1000 ? null : `d${i + 1}`));
    await expect(f.service.createDepartment({ actorId, name: "New", parentId: "d0" })).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.department.findUnique).toHaveBeenCalledTimes(1000); expect(f.tx.department.create).not.toHaveBeenCalled();
  });
  it("fails closed on a missing ancestor instead of repairing topology", async () => {
    const f = fixture(); f.departments.get("parent")!.parentId = "missing";
    await expect(f.service.assignUserDepartment({ actorId, userId: "target", departmentId: "parent" })).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
});

describe("archive and reference checks", () => {
  it.each(["department", "group"])("does not rename an archived %s", async resource => {
    const f = fixture();
    if (resource === "department") { f.departments.get("department")!.archivedAt = archived; await expect(f.service.renameDepartment({ actorId, departmentId: "department", name: "New" })).rejects.toMatchObject({ name: "ConflictError" }); }
    else { f.groups.get("group")!.archivedAt = archived; await expect(f.service.renameGroup({ actorId, groupId: "group", name: "New" })).rejects.toMatchObject({ name: "ConflictError" }); }
    expect(f.tx.department.update).not.toHaveBeenCalled(); expect(f.tx.responsibleGroup.update).not.toHaveBeenCalled();
  });
  it.each(["user", "project", "child"])("cannot archive a department referenced by %s", async reference => {
    const f = fixture(); if (reference === "user") f.tx.user.count.mockResolvedValue(1); else if (reference === "project") f.tx.project.count.mockResolvedValue(1); else f.tx.department.count.mockResolvedValue(1);
    await expect(f.service.setDepartmentArchived({ actorId, departmentId: "department", archived: true })).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.department.update).not.toHaveBeenCalled();
    expect(f.tx.user.count).toHaveBeenCalledWith({ where: { primaryDepartmentId: "department" } });
    expect(f.tx.project.count).toHaveBeenCalledWith({ where: { departmentId: "department" } });
    expect(f.tx.department.count).toHaveBeenCalledWith({ where: { parentId: "department", archivedAt: null } });
  });
  it("archives an unused department and preserves other metadata", async () => {
    const f = fixture(); f.departments.get("department")!.leaderId = "target";
    const result = await f.service.setDepartmentArchived({ actorId, departmentId: "department", archived: true });
    expect(result.archived).toBe(true); expect(result.leaderId).toBe("target"); expect(result).not.toHaveProperty("archivedAt");
  });
  it("archives with business history and never deletes boards, cards or memberships", async () => {
    const f = fixture();
    await f.service.setDepartmentArchived({ actorId, departmentId: "department", archived: true });
    // The only entity write is the archive flag; no project/task/member delete
    // path exists in the service, so legacy cards and history stay untouched.
    expect(f.tx.department.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "department" }, data: { archivedAt: expect.any(Date) },
    });
    expect(f.tx.project.update).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.responsibleGroupMember.deleteMany).not.toHaveBeenCalled();
    expect(f.projects.get("project")).toEqual({ id: "project", departmentId: null, responsibleGroupId: null, lifecycleColumnMap: null });
    expect(f.receipts.size).toBe(1);
    const receipt = [...f.receipts.values()][0];
    expect(receipt.operation).toBe("setDepartmentArchived");
    expect(receipt.changed).toBe(true);
  });
  it("archives an unbound group without dropping members and rejects bound groups", async () => {
    const f = fixture(); f.members.add("group/target"); f.tx.project.count.mockResolvedValueOnce(1);
    await expect(f.service.setGroupArchived({ actorId, groupId: "group", archived: true })).rejects.toMatchObject({ name: "ConflictError" });
    await f.service.setGroupArchived({ actorId, groupId: "group", archived: true });
    expect(f.members.has("group/target")).toBe(true); expect(f.tx.responsibleGroupMember.deleteMany).not.toHaveBeenCalled();
  });
  it("returns idempotently for an unchanged archive state without rechecking references", async () => {
    const f = fixture(); f.departments.get("department")!.archivedAt = archived; f.groups.get("group")!.archivedAt = archived;
    await f.service.setDepartmentArchived({ actorId, departmentId: "department", archived: true });
    await f.service.setGroupArchived({ actorId, groupId: "group", archived: true });
    expect(f.tx.user.count).not.toHaveBeenCalled(); expect(f.tx.project.count).not.toHaveBeenCalled(); expect(f.tx.department.update).not.toHaveBeenCalled(); expect(f.tx.responsibleGroup.update).not.toHaveBeenCalled();
  });
  it("does not unarchive a department under an archived parent", async () => {
    const f = fixture(); f.departments.get("department")!.archivedAt = archived; f.departments.get("department")!.parentId = "parent"; f.departments.get("parent")!.archivedAt = archived;
    await expect(f.service.setDepartmentArchived({ actorId, departmentId: "department", archived: false })).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.department.update).not.toHaveBeenCalled();
  });
  it("allows clearing an archived leader and removing an archived group's member, but not assigning", async () => {
    const f = fixture(); f.departments.get("department")!.archivedAt = archived; f.groups.get("group")!.archivedAt = archived;
    f.departments.get("department")!.leaderId = "target"; f.members.add("group/target");
    await expect(f.service.setDepartmentLeader({ actorId, departmentId: "department", userId: "target" })).rejects.toMatchObject({ name: "ConflictError" });
    await f.service.setDepartmentLeader({ actorId, departmentId: "department", userId: null });
    await expect(f.service.setGroupMember({ actorId, groupId: "group", userId: "target", member: true })).rejects.toMatchObject({ name: "ConflictError" });
    await f.service.setGroupMember({ actorId, groupId: "group", userId: "target", member: false });
    expect(f.tx.responsibleGroupMember.createMany).not.toHaveBeenCalled(); expect(f.tx.responsibleGroupMember.deleteMany).toHaveBeenCalledOnce();
  });
  it.each(["department", "group"])("rechecks an archived %s after the lock wait before binding either field", async resource => {
    const f = fixture(), gate = deferred(); f.waitForLock(gate.promise);
    const pending = f.service.bindProject({ actorId, projectId: "project", departmentId: "department", responsibleGroupId: "group" });
    expect(f.calls).toEqual(["transaction", "lock"]);
    if (resource === "department") f.departments.get("department")!.archivedAt = archived; else f.groups.get("group")!.archivedAt = archived;
    gate.resolve(); await expect(pending).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.project.update).not.toHaveBeenCalled();
  });
  it("rechecks a newly archived department after waiting before user assignment", async () => {
    const f = fixture(), gate = deferred(); f.waitForLock(gate.promise);
    const pending = f.service.assignUserDepartment({ actorId, userId: "target", departmentId: "department" });
    f.departments.get("department")!.archivedAt = archived; gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("allows clearing both project links without looking up old archived targets", async () => {
    const f = fixture(); f.projects.get("project")!.departmentId = "missing-old-department"; f.projects.get("project")!.responsibleGroupId = "missing-old-group";
    expect(await f.service.bindProject({ actorId, projectId: "project", departmentId: null, responsibleGroupId: null })).toEqual({ id: "project", departmentId: null, responsibleGroupId: null });
    expect(f.tx.department.findUnique).not.toHaveBeenCalled(); expect(f.tx.responsibleGroup.findUnique).not.toHaveBeenCalled();
  });
});
