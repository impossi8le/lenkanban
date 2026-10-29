import { beforeEach, describe, expect, it, vi } from "vitest";
const policies = vi.hoisted(() => ({ read: vi.fn(), execute: vi.fn(), projects: vi.fn(), recipients: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: {} }));
vi.mock("./project-access", () => ({ getTaskReadWhere: policies.read }));
vi.mock("./project-request-execution-policy", async original => ({
  ...await original<typeof import("./project-request-execution-policy")>(), getProjectRequestExecutionPolicy: policies.execute,
  getRequestExecutionProjectIds: policies.projects, getProjectRequestExecutorIds: policies.recipients,
}));
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors";
import {
  markRequestQueueSeen, readRequestQueueArrivalMap, readRequestQueueUnseenCounts,
  readRequestQueueUnseenWhere, readRequestQueueRecipientIds, recordRequestQueueArrival, type RequestQueueReadDatabase,
} from "./request-queue-unseen";

type Row = { id: string; projectId: string; title: string; request: null | {
  taskId: string; contractVersion: number; state: string; authorId: string; executorId: string | null;
  audienceUserIds: string[]; queueEpoch: number; deletedAt: Date | null; needsInfoSince: null; pausedTotalMs: number;
} };
const arrival = (id: string, patch: Partial<NonNullable<Row["request"]>> = {}): Row => ({ id, projectId: "board", title: id, request: {
  taskId: id, contractVersion: 1, state: "SUBMITTED", authorId: "author", executorId: null,
  audienceUserIds: [], queueEpoch: 1, deletedAt: null, needsInfoSince: null, pausedTotalMs: 0, ...patch,
} });
const command = { actorId: "staff", expectedActorId: "staff", taskId: "queue", queueEpoch: 1 };

// A bounded relational fixture, not PostgreSQL: execute the composed read
// predicate instead of returning predetermined "unseen" IDs from the repository.
function fixture(rows: Row[] = [arrival("queue")]) {
  const seen = new Map<string, Date>();
  const options = { readable: true, blocked: false, executionRole: true, staff: true, groupMember: true,
    departmentBound: true, departmentArchived: false, allowedProjects: new Set(["board"]), deniedIds: new Set<string>() };
  const trace: string[] = [];
  function matches(value: unknown, where: unknown, taskId?: string): boolean {
    if (where === null || typeof where !== "object") return value === where;
    const clause = where as Record<string, unknown>;
    const row = value as Record<string, unknown> | null;
    for (const [key, expected] of Object.entries(clause)) {
      if (key === "AND") { if (!(Array.isArray(expected) ? expected : [expected]).every(part => matches(value, part, taskId))) return false; }
      else if (key === "OR") { if (!(expected as unknown[]).some(part => matches(value, part, taskId))) return false; }
      else if (key === "is") { if (!matches(value, expected, taskId)) return false; }
      else if (key === "in") { if (!(expected as unknown[]).includes(value)) return false; }
      else if (key === "gt") { if (!(typeof value === "number" && value > Number(expected))) return false; }
      else if (key === "not") { if (matches(value, expected, taskId)) return false; }
      else if (key === "isEmpty") { if (!Array.isArray(value) || (value.length === 0) !== expected) return false; }
      else if (key === "has") { if (!Array.isArray(value) || !value.includes(expected)) return false; }
      else if (key === "contains") { if (typeof value !== "string" || !value.includes(String(expected))) return false; }
      else if (key === "queueSeen") {
        const userId = (expected as { none: { userId: string } }).none.userId;
        if (seen.has(`${taskId}/${userId}`)) return false;
      } else if (!matches(row?.[key], expected, taskId)) return false;
    }
    return true;
  }
  policies.read.mockImplementation(async (_actor, filters) => {
    trace.push("acl");
    return { AND: [{ id: { in: options.readable ? rows.filter(row => !options.deniedIds.has(row.id)).map(row => row.id) : [] } }, filters] };
  });
  policies.execute.mockImplementation(async (_actorId, projectId) => ({ canExecute: options.allowedProjects.has(projectId) && options.executionRole && options.staff }));
  policies.projects.mockImplementation(async (_actorId, projects) => options.executionRole && options.staff
    ? [...options.allowedProjects].filter(id => projects === undefined || projects.includes(id)) : []);
  policies.recipients.mockImplementation(async projectId => !options.blocked && options.executionRole && options.staff && options.allowedProjects.has(projectId) ? ["staff"] : []);
  const role = () => options.executionRole ? [{ id: "grant", userId: "staff", profileId: "profile", projectId: "board", departmentId: null, scopeKind: "board",
    profile: { archivedAt: null, permissions: ["request.execute"] } }] : [];
  const db = {
    user: { findUnique: vi.fn(async () => ({ id: "staff", globalRole: "USER" as const,
      isBlocked: options.blocked, blockedAt: null, primaryDepartmentId: options.staff ? "department" : "other" })),
      findMany: vi.fn(async () => options.blocked ? [] : [{ id: "staff", globalRole: "USER" as const, primaryDepartmentId: "department" }]),
    },
    project: {
      findMany: vi.fn(async () => [...new Set(rows.map(row => row.projectId))].map(id => ({ id }))),
      findUnique: vi.fn(async () => ({ id: "board", responsibleGroupId: "group", departmentId: options.departmentBound ? "department" : null })),
    },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => role()) },
    groupPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    task: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find(row => row.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: unknown }) => rows.find(row => matches(row, where, row.id)) ?? null),
      findMany: vi.fn(async ({ where }: { where: unknown }) => rows.filter(row => matches(row, where, row.id))),
      groupBy: vi.fn(async ({ where }: { where: unknown }) => {
        const counts = new Map<string, number>();
        rows.filter(row => matches(row, where, row.id)).forEach(row => counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1));
        return [...counts].map(([projectId, count]) => ({ projectId, _count: { _all: count } }));
      }),
    },
    taskRequest: { updateMany: vi.fn(async ({ where }: { where: { taskId: string; queueEpoch: { lt: number } } }) => {
      const request = rows.find(row => row.id === where.taskId)?.request;
      if (!request || request.queueEpoch >= where.queueEpoch.lt || request.state !== "SUBMITTED" || request.executorId !== null || request.deletedAt !== null) return { count: 0 };
      request.queueEpoch++; return { count: 1 };
    }) },
    taskRequestQueueSeen: {
      createMany: vi.fn(async ({ data }: { data: { taskId: string; userId: string }[] }) => {
        let count = 0;
        for (const row of data) if (!seen.has(`${row.taskId}/${row.userId}`)) { seen.set(`${row.taskId}/${row.userId}`, new Date()); count++; }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { taskId: string } }) => {
        let count = 0;
        for (const key of seen.keys()) if (key.startsWith(`${where.taskId}/`)) { seen.delete(key); count++; }
        return { count };
      }),
    },
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?"); trace.push(sql);
      if (sql.includes('FROM "ScopedPrivilegeAssignment"')) return role().map(row => ({ id: row.id }));
      if (sql.includes('FROM "GroupPrivilegeAssignment"')) return [];
      if (sql.includes('FROM "ResponsibleGroupMember"')) return options.groupMember ? [{ userId: "staff" }] : [];
      if (sql.includes('FROM "ResponsibleGroup"')) return [{ id: "group", archivedAt: null }];
      if (sql.includes('FROM "Department"')) return [{ id: "department", archivedAt: options.departmentArchived ? new Date() : null }];
      if (sql.includes('FROM "TaskWatcher"')) return [];
      if (sql.includes('FROM "Project"')) return [{ id: "board" }];
      if (sql.includes('FROM "Task"')) return [{ id: "queue", projectId: "board" }];
      if (sql.includes('FROM "User"')) return [{ id: "staff" }];
      throw new Error("Unexpected fixture query");
    }),
  };
  let tail = Promise.resolve<unknown>(undefined);
  const transaction = vi.fn((run: (tx: typeof db) => Promise<unknown>) => {
    const next = tail.then(() => run(db)); tail = next.catch(() => {}); return next;
  });
  return { rows, options, seen, trace, db, transaction,
    read: db as unknown as RequestQueueReadDatabase,
    host: { $transaction: transaction } as unknown as Parameters<typeof markRequestQueueSeen>[0] };
}

beforeEach(() => vi.clearAllMocks());

describe("queue-unseen shared reads (mock relational storage)", () => {
  it("uses one full read/execution/audience/queue predicate for counts and rows before paging", async () => {
    const f = fixture([arrival("queue"), arrival("seen"), arrival("old", { queueEpoch: 0 }),
      arrival("taken", { state: "IN_PROGRESS", executorId: "staff" }), arrival("deleted", { deletedAt: new Date() }),
      arrival("personal-hidden", { audienceUserIds: ["other"] }), arrival("personal-selected", { audienceUserIds: ["staff"] }),
      arrival("acl-hidden"), { ...arrival("legacy"), request: null }, { ...arrival("other-board"), projectId: "other" }]);
    f.seen.set("seen/staff", new Date()); f.options.deniedIds.add("acl-hidden");
    const where = await readRequestQueueUnseenWhere(f.read, "staff");
    expect((await f.db.task.findMany({ where })).map(row => row.id)).toEqual(["queue", "personal-selected"]);
    expect(await readRequestQueueUnseenCounts(f.read, "staff")).toEqual({ byProject: { board: 2 }, total: 2 });
    expect(f.db.task.groupBy).toHaveBeenLastCalledWith({ by: ["projectId"], where, _count: { _all: true } });
    const filter = { OR: [{ title: { contains: "personal" } }, { id: "taken" }] };
    expect(await readRequestQueueUnseenCounts(f.read, "staff", filter)).toEqual({ byProject: { board: 1 }, total: 1 });
    expect(policies.read).toHaveBeenLastCalledWith(expect.objectContaining({ id: "staff" }), filter, f.db);
  });
  it("projects a batch per distinct project, omits unauthorized IDs and keeps legacy null", async () => {
    const f = fixture([arrival("queue"), arrival("second"), arrival("old", { queueEpoch: 0 }),
      arrival("hidden"), { ...arrival("legacy"), request: null }]);
    f.options.deniedIds.add("hidden");
    const map = await readRequestQueueArrivalMap(f.read, "staff", ["queue", "second", "old", "hidden", "legacy", "missing"]);
    expect([...map]).toEqual([["queue", { epoch: 1, unseen: true }], ["second", { epoch: 1, unseen: true }],
      ["old", { epoch: 0, unseen: false }], ["legacy", null]]);
    expect(policies.projects).toHaveBeenCalledExactlyOnceWith("staff", ["board", "board", "board", "board"], f.db);
    expect(f.db.task.findMany).toHaveBeenCalledTimes(2);
  });
  it("never treats a readable ADMIN or department member without request.execute as eligible", async () => {
    const f = fixture(); f.options.executionRole = false;
    f.db.user.findUnique.mockResolvedValue({ id: "staff", globalRole: "ADMIN" as never, isBlocked: false, blockedAt: null, primaryDepartmentId: "department" });
    expect(await readRequestQueueUnseenCounts(f.read, "staff")).toEqual({ byProject: {}, total: 0 });
    expect((await readRequestQueueArrivalMap(f.read, "staff", ["queue"])).get("queue")).toEqual({ epoch: 1, unseen: false });
  });
  it("fails closed on actor/authority errors and bounds batch input", async () => {
    const f = fixture(); f.options.blocked = true;
    await expect(readRequestQueueUnseenCounts(f.read, "staff")).rejects.toBeInstanceOf(NotFoundError);
    expect(f.db.task.groupBy).not.toHaveBeenCalled();
    await expect(readRequestQueueArrivalMap(f.read, "staff", ["bad id"])).rejects.toBeInstanceOf(BadRequestError);
    f.options.blocked = false; policies.projects.mockRejectedValue(new Error("Unavailable authority"));
    await expect(readRequestQueueArrivalMap(f.read, "staff", ["queue"])).rejects.toThrow("Unavailable authority");
  });
  it("selects only opaque invalidation recipients from fresh executors and shared personal audience", async () => {
    const f = fixture([arrival("queue", { state: "IN_PROGRESS", executorId: "staff" })]);
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual(["staff"]);
    expect(policies.recipients).toHaveBeenLastCalledWith("board", f.db);
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.user.findMany).not.toHaveBeenCalled();
    expect(policies.read).not.toHaveBeenCalled();
    f.rows[0].request!.audienceUserIds = ["other"];
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual([]);
    f.rows[0].request!.audienceUserIds = []; f.rows[0].request!.deletedAt = new Date();
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual([]);
    f.rows[0].request = null;
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual([]);
    f.options.executionRole = false;
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual([]);
  });
  it("does not use blocked or revoked execution candidates as opaque recipients", async () => {
    const f = fixture(); f.options.blocked = true;
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual([]);
    f.options.blocked = false; f.options.executionRole = false;
    f.db.user.findMany.mockClear();
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual([]);
    expect(f.db.user.findMany).not.toHaveBeenCalled();
  });
  it("uses one canonical task read for multi-recipient opaque fanout, excluding drafts and wrong boards", async () => {
    const f = fixture();
    policies.recipients.mockResolvedValue(["staff", "second", "staff"]);
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual(["staff", "second"]);
    expect(f.db.task.findFirst).toHaveBeenCalledTimes(1);
    expect(f.db.scopedPrivilegeAssignment.findMany).not.toHaveBeenCalled();
    expect(await readRequestQueueRecipientIds(f.read, "queue", "wrong-board")).toEqual([]);
    f.rows[0].request!.state = "DRAFT";
    expect(await readRequestQueueRecipientIds(f.read, "queue", "board")).toEqual([]);
  });
});

describe("queue view receipts under canonical locks (mock transaction host)", () => {
  it("rejects actor mismatch and malformed epochs before opening a transaction", async () => {
    const f = fixture();
    await expect(markRequestQueueSeen(f.host, { ...command, expectedActorId: "old-actor" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const queueEpoch of [0, -1, 1.5, 2147483648]) await expect(markRequestQueueSeen(f.host, { ...command, queueEpoch })).rejects.toBeInstanceOf(BadRequestError);
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("is idempotent across concurrent calls and retains the first seen time without business writes", async () => {
    const f = fixture();
    expect(await Promise.all([markRequestQueueSeen(f.host, command), markRequestQueueSeen(f.host, command)]))
      .toEqual([{ changed: true, stale: false }, { changed: false, stale: false }]);
    const first = f.seen.get("queue/staff");
    await markRequestQueueSeen(f.host, command);
    expect(f.seen.get("queue/staff")).toBe(first);
    expect(f.seen.size).toBe(1);
    expect(f.db.taskRequest.updateMany).not.toHaveBeenCalled();
    expect(f.trace.indexOf('SELECT "id" FROM "Project" WHERE "id" = ? FOR UPDATE')).toBeLessThan(f.trace.indexOf('SELECT "id", "projectId" FROM "Task" WHERE "id" = ? FOR UPDATE'));
    expect(f.trace.findIndex(value => value.includes('FROM "ScopedPrivilegeAssignment"'))).toBeLessThan(f.trace.indexOf("acl"));
  });
  it.each(["read", "execute", "staff", "audience", "blocked", "archived"])("rechecks %s under locks and never inserts after revocation", async revoked => {
    const f = fixture();
    if (revoked === "read") f.options.readable = false;
    if (revoked === "execute") f.options.executionRole = false;
    if (revoked === "staff") f.options.staff = false;
    if (revoked === "audience") f.rows[0].request!.audienceUserIds = ["other"];
    if (revoked === "blocked") f.options.blocked = true;
    if (revoked === "archived") f.options.departmentArchived = true;
    await expect(markRequestQueueSeen(f.host, command)).rejects.toBeInstanceOf(NotFoundError);
    expect(f.db.taskRequestQueueSeen.createMany).not.toHaveBeenCalled();
  });
  it("does not mark a returned new epoch or an already taken request", async () => {
    const f = fixture(); f.rows[0].request!.queueEpoch = 2;
    expect(await markRequestQueueSeen(f.host, command)).toEqual({ changed: false, stale: true });
    f.rows[0].request!.state = "IN_PROGRESS"; f.rows[0].request!.executorId = "staff";
    expect(await markRequestQueueSeen(f.host, { ...command, queueEpoch: 2 })).toEqual({ changed: false, stale: true });
    expect(f.seen.size).toBe(0);
  });
  it("a genuine arrival clears prior viewers and suppresses only its command actor", async () => {
    const f = fixture(); f.seen.set("queue/old-viewer", new Date());
    await recordRequestQueueArrival(f.db as never, { taskId: "queue", actorId: "author" });
    expect(f.rows[0].request!.queueEpoch).toBe(2);
    expect([...f.seen.keys()]).toEqual(["queue/author"]);
    expect(await markRequestQueueSeen(f.host, command)).toEqual({ changed: false, stale: true });
    expect(await markRequestQueueSeen(f.host, { ...command, queueEpoch: 2 })).toEqual({ changed: true, stale: false });
  });
  it("rejects epoch exhaustion before clearing any receipt", async () => {
    const f = fixture(); f.rows[0].request!.queueEpoch = 2147483647; f.seen.set("queue/staff", new Date());
    await expect(recordRequestQueueArrival(f.db as never, { taskId: "queue", actorId: "author" })).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.db.taskRequestQueueSeen.deleteMany).not.toHaveBeenCalled();
    expect(f.db.taskRequestQueueSeen.createMany).not.toHaveBeenCalled();
  });
});
