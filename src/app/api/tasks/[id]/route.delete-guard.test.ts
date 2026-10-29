import { taskReadPredicate, taskWritePredicate } from "@/lib/access-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";
import { TASK_REQUEST_STATES, type TaskRequestState } from "@/lib/task-request-policy";

const runtime = vi.hoisted(() => ({
  database: {} as object,
  auth: vi.fn(),
  rate: vi.fn(),
  emitDeleted: vi.fn(),
  emitUpdated: vi.fn(),
  load: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: runtime.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: runtime.rate, rateLimitErrorResponse: () => Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 }) }));
vi.mock("@/socket/board-events", () => ({ emitTaskDeleted: runtime.emitDeleted, emitTaskUpdated: runtime.emitUpdated, emitTaskMoved: vi.fn() }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: runtime.load, TASK_WITH_RELATIONS_INCLUDE: {} }));
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskStatusChanged: vi.fn() }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: runtime.warn, error: vi.fn() }, dbLogger: { error: vi.fn() } }));
import { DELETE } from "./route";

function marker(state: TaskRequestState, authorId = "author", executorId: string | null = null) {
  return {
    taskId: "task",
    contractVersion: 1,
    state,
    authorId,
    executorId: ["IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED"].includes(state)
      ? executorId ?? "executor"
      : executorId,
  };
}

function fixture(taskId = "task") {
  const calls: string[] = [];
  const state = { deleted: false, logical: false };
  let working = { ...state };
  const options = {
    outerExists: true,
    projectExists: true,
    taskExists: true,
    drift: false,
    actorExists: true,
    isBlocked: false,
    blockedAt: null as Date | null,
    role: "USER" as "USER" | "ADMIN",
    access: true,
    groupMember: false,
    beznal:false,
    createdById: "author",
    assignees: [] as string[],
    watcher: false,
    marker: null as unknown,
    markerFailure: false,
    markerDelegateMissing: false,
    markerUpdateFailure: false,
    taskCasFailure: false,
    deleteFailure: false,
    commitFailure: false,
  };
  const members = [
    { userId: "author", role: "MEMBER" as const },
    { userId: "executor", role: "MEMBER" as const },
  ];
  const markerRow = () => options.marker as ReturnType<typeof marker> | null;
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.join("?");
      if (sql.includes('FROM "ScopedPrivilegeAssignment"')) {
        calls.push("personal-role-lock");
        return (values[0] as string[]).includes("executor") ? [{ id: "executor-role" }] : [];
      }
      if (sql.includes('FROM "GroupPrivilegeAssignment"')) { calls.push("group-role-lock"); return []; }
      if (sql.includes('FROM "ResponsibleGroupMember"')) {
        expect(sql).toContain("FOR SHARE");
        return options.groupMember ? [{ userId: "executor" }] : [];
      }
      if (sql.includes('FROM "ResponsibleGroup"')) {
        expect(sql).toContain("FOR SHARE");
        return [{ id: "group", archivedAt: null, leaderId: null }];
      }
      if (sql.includes('FROM "ProjectColumn"')) {
        calls.push("column-lock");
        return [{ id: values[0] }];
      }
      if (sql.includes('FROM "Project"')) {
        calls.push("project-lock");
        expect(sql).toMatch(/FOR UPDATE/);
        return options.projectExists ? [{ id: "project" }] : [];
      }
      if (sql.includes('FROM "TaskRequest"')) {
        calls.push("marker-lock");
        expect(sql).toMatch(/FOR UPDATE/);
        return markerRow() === null ? [] : [{ taskId }];
      }
      if (sql.includes('FROM "TaskWatcher"')) { calls.push("watcher-lock"); expect(sql).toContain("FOR SHARE"); return options.watcher ? [{ userId: values[1] }] : []; }
      if (sql.includes('FROM "Task"')) {
        calls.push("task-lock");
        expect(sql).toMatch(/FOR UPDATE/);
        return options.taskExists
          ? [{ id: taskId, projectId: options.drift ? "other" : "project", columnId: "column", version: 4, description: "old" }]
          : [];
      }
      calls.push("actor-lock");
      expect(sql).toContain("FOR SHARE");
      return [{ id: values[0] }];
    }),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        calls.push("fresh-actor");
        if (!options.actorExists) return null;
        return { id: where.id, globalRole: options.role, name: null, isBlocked: options.isBlocked, blockedAt: options.blockedAt };
      }),
    },
    scopedPrivilegeAssignment: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => where.userId === "executor" ? [{
        id: "executor-role", userId: "executor", profileId: "executor-profile", scopeKind: "organization", departmentId: null, projectId: null,
        profile: { id: "executor-profile", permissions: ["request.execute"], archivedAt: null },
      }] : []),
    },
    project: {
      findUnique: vi.fn(async (input: {
        select: {
          name?:boolean;
          members?: { where: { userId: string } };
          responsibleGroupId?: boolean;
          responsibleGroup?: unknown;
          department?: unknown;
        };
      }) => {
        if(input.select.name)return {name:options.beznal?"Безнал ОП":"Support"};
        if (input.select.responsibleGroupId) return { responsibleGroupId: options.groupMember ? "group" : null };
        if (input.select.department) return { department: null };
        if (input.select.responsibleGroup && !input.select.members) {
          return { responsibleGroup: options.groupMember ? { archivedAt: null, members: [{ userId: "executor" }] } : null };
        }
        calls.push("fresh-access");
        const userId = input.select.members!.where.userId;
        const membership = members.find((member) => member.userId === userId);
        return {
          id: "project",
          ownerId: options.access ? "author" : "other",
          members: options.access && membership ? [{ role: membership.role }] : [],
        };
      }),
    },
    taskRequest: {
      findUnique: vi.fn(async (input?: { select?: { audienceUserIds?: boolean;beznalPhase?:boolean } }) => {
        if(input?.select?.beznalPhase)return {beznalPhase:"WAITING"};
        calls.push(input?.select?.audienceUserIds ? "audience" : "marker");
        if (options.markerFailure) throw new Error("synthetic-private-storage");
        if (input?.select?.audienceUserIds) return markerRow() === null ? null : { authorId: "author", audienceUserIds: [] };
        return markerRow();
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: { taskId: string; state: TaskRequestState; executorId: string | null };
        data: { state: TaskRequestState; executorId: string | null };
      }) => {
        calls.push("marker-cas");
        if (options.markerUpdateFailure) return { count: 0 };
        const row = markerRow();
        if (!row || row.state !== where.state || row.executorId !== where.executorId) {
          return { count: 0 };
        }
        row.state = data.state;
        row.executorId = data.executorId;
        working.logical = true;
        return { count: 1 };
      }),
    },
    task: {
      findFirst: vi.fn(async ({ where, select }: { where: unknown; select: unknown }) => {
        const actor = { id: (await runtime.auth.getMockImplementation()!()).id, globalRole: options.role };
        const writeWhere = { AND: [taskWritePredicate(actor), { id: taskId, projectId: "project" }] };
        const scoped = { AND: [{ id: taskId, projectId: "project" }, { projectId: "project" }] };
        // Fresh execution grants change the canonical predicate shape, never the mutation authority.
        const readWhere = actor.globalRole === "ADMIN" ? scoped : { AND: [taskReadPredicate(actor, [], actor.id === "executor" ? [{}] : [], true), scoped] };
        expect(select).toEqual({ id: true });
        // Structural equality: key order is not part of the contract, the shape is.
        const normalize = (value: unknown): unknown => Array.isArray(value)
          ? value.map(normalize)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
                .map(key => [key, normalize((value as Record<string, unknown>)[key])]))
            : value;
        const sameShape = (left: unknown, right: unknown) =>
          JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
        if (sameShape(where, readWhere)) { calls.push("common-task-read"); return options.access ? { id: taskId } : null; }
        calls.push("fresh-task-access"); expect(where).toEqual(writeWhere);
        return options.createdById === "author" || (options.assignees.length === 1 && options.assignees[0] === "author") ? { id: taskId } : null;
      }),
      delete: vi.fn(async () => {
        calls.push("delete");
        if (options.deleteFailure) throw new Error("synthetic-private-delete");
        working.deleted = true;
        return { title: "synthetic-private-task" };
      }),
      updateMany: vi.fn(async ({ where }: { where: { version: number } }) => {
        calls.push("task-cas");
        if (options.taskCasFailure || where.version !== 4) return { count: 0 };
        return { count: 1 };
      }),
    },
    activity: { create: vi.fn(async () => { calls.push("activity"); return { id: "activity" }; }) },
  };
  const database = {
    task: { findFirst: vi.fn(async ({ where }: { where: unknown }) => {
      const actor = await runtime.auth.getMockImplementation()!();
      expect(where).toEqual(actor.globalRole === "ADMIN" ? { id: taskId } : {
        AND: [taskReadPredicate(actor, [], [], true), { id: taskId }],
      });
      return options.outerExists && (actor.globalRole === "ADMIN" || options.createdById === actor.id || options.watcher || options.marker !== null)
        ? { id: taskId, projectId: "project" } : null;
    }) },
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      working = { ...state };
      const result = await operation(tx);
      if (options.commitFailure) throw new Error("synthetic-private-commit");
      Object.assign(state, working);
      calls.push("commit");
      return result;
    }),
  };
  runtime.database = database;
  const invoke = () => DELETE(new Request("https://app.test/api/tasks/task", { method: "DELETE" }), { params: Promise.resolve({ id: taskId }) });
  return { calls, state, options, tx, database, invoke, markerRow };
}

type Fixture = ReturnType<typeof fixture>;

async function denied(f: Fixture, status: number, code?: string) {
  const response = await f.invoke();
  expect(response.status).toBe(status);
  const text = await response.text();
  if (code) expect(JSON.parse(text).error.code).toBe(code);
  expect(text).not.toMatch(/synthetic-private|private-author|private-executor|contractVersion/);
  expect(f.tx.task.delete).not.toHaveBeenCalled();
  expect(f.state.deleted).toBe(false);
  expect(runtime.emitDeleted).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.auth.mockResolvedValue({ id: "author", globalRole: "USER" });
  runtime.rate.mockResolvedValue(undefined);
  runtime.emitDeleted.mockResolvedValue(undefined);
  runtime.emitUpdated.mockResolvedValue(undefined);
  runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } });
  runtime.warn.mockImplementation(() => {});
});

describe("task DELETE: legacy physical deletion and marked logical deletion", () => {
  it.each(["isBlocked", "blockedAt"] as const)("denies fresh account block via %s before marker or deletion", async field => {
    const f = fixture();
    if (field === "isBlocked") f.options.isBlocked = true;
    else f.options.blockedAt = new Date("2026-10-23T00:00:00Z");
    await denied(f, 404);
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.updateMany).not.toHaveBeenCalled();
  });
  it("keeps physical legacy deletion with locks, fresh access and post-commit emit", async () => {
    const f = fixture();
    runtime.emitDeleted.mockImplementation(async (...identity) => {
      expect(f.state.deleted).toBe(true);
      expect(f.calls.at(-1)).toBe("commit");
      expect(identity).toEqual(["project", "task", "author"]);
    });
    const response = await f.invoke();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ deleted: true });
    expect(f.calls).toEqual([
      "project-lock",
      "task-lock",
      "watcher-lock",
      "actor-lock",
      "fresh-actor",
      "personal-role-lock",
      "group-role-lock",
      "common-task-read",
      "audience",
      "marker-lock",
      "marker",
      "fresh-actor",
      "fresh-task-access",
      "delete",
      "commit",
    ]);
    expect(f.tx.task.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: "task" } });
    expect(runtime.emitUpdated).not.toHaveBeenCalled();
    expect(runtime.rate).toHaveBeenCalledWith("tasks:delete", "author");
  });

  it("denies physical deletion of another creator's task even for a watcher with project access", async () => {
    const f = fixture(); f.options.createdById = "other"; f.options.watcher = true;
    await denied(f, 404);
    expect(f.tx.task.findFirst).toHaveBeenCalledTimes(2);
    expect(f.calls.indexOf("common-task-read")).toBeLessThan(f.calls.indexOf("marker"));
    expect(f.calls.indexOf("fresh-task-access")).toBeGreaterThan(f.calls.indexOf("marker"));
  });

  it("logically deletes a draft only for its author with audit and no physical delete", async () => {
    const f = fixture();
    f.options.marker = marker("DRAFT");
    runtime.emitUpdated.mockImplementation(async (...identity) => {
      expect(f.state.logical).toBe(true);
      expect(f.calls.at(-1)).toBe("commit");
      expect(identity).toEqual(["project", { id: "task", project: { id: "project" } }]);
    });
    const response = await f.invoke();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ deleted: true, logical: true });
    expect(f.tx.task.delete).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.task.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "request_deleted", userId: "author" }),
    });
    expect(runtime.emitDeleted).not.toHaveBeenCalled();
    expect(runtime.emitUpdated).toHaveBeenCalledOnce();
  });

  it("rejects deletion by a readable non-author watcher before work with a fixed 403", async () => {
    const f = fixture();
    f.options.marker = marker("SUBMITTED");
    f.options.watcher = true;
    runtime.auth.mockResolvedValue({ id: "executor", globalRole: "USER" });
    await denied(f, 403, "FORBIDDEN_ROLE");
    expect(f.tx.taskRequest.updateMany).not.toHaveBeenCalled();
    expect(f.tx.activity.create).not.toHaveBeenCalled();
  });

  it("lets the executor logically delete an in-progress request and keeps repeats idempotent", async () => {
    const f = fixture();
    f.options.marker = marker("IN_PROGRESS");
    f.options.groupMember = true;
    runtime.auth.mockResolvedValue({ id: "executor", globalRole: "USER" });
    const first = await f.invoke();
    expect(first.status).toBe(200);
    expect((await first.json()).data).toEqual({ deleted: true, logical: true });
    expect(f.tx.activity.create).toHaveBeenCalledOnce();
    const second = await f.invoke();
    expect(second.status).toBe(200);
    expect(f.tx.taskRequest.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.activity.create).toHaveBeenCalledOnce();
  });

  it.each(TASK_REQUEST_STATES)("rejects a malformed marker for state %s without writes", async (state) => {
    const f = fixture();
    f.options.marker = { ...marker("DRAFT"), state, contractVersion: 2 };
    await denied(f, 409, "INVALID_REQUEST_MARKER");
    expect(f.tx.taskRequest.updateMany).not.toHaveBeenCalled();
    expect(f.tx.activity.create).not.toHaveBeenCalled();
  });

  it("fails closed on marker query/delegate failures", async () => {
    const query = fixture();
    query.options.markerFailure = true;
    await denied(query, 500);
    const missing = fixture();
    Object.defineProperty(missing.tx, "taskRequest", { value: undefined });
    await denied(missing, 500);
  });

  it("returns safe 404 for missing project, task, actor or access before mutation", async () => {
    for (const kind of ["project", "task", "actor", "access"] as const) {
      const f = fixture();
      f.options.marker = marker("DRAFT");
      if (kind === "project") f.options.projectExists = false;
      if (kind === "task") f.options.taskExists = false;
      if (kind === "actor") f.options.actorExists = false;
      if (kind === "access") f.options.access = false;
      await denied(f, 404);
      expect(f.tx.taskRequest.updateMany).not.toHaveBeenCalled();
    }
  });

  it("rejects identity drift before actor or marker writes", async () => {
    const f = fixture();
    f.options.drift = true;
    await denied(f, 409, "IDENTITY_CHANGED");
    expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled();
  });

  it("checks fresh actor/access after the Project lock wait", async () => {
    const f = fixture();
    f.options.marker = marker("DRAFT");
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const raw = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async (query, ...values) => {
      if (query.join("?").includes('FROM "Project"')) { entered(); await barrier; }
      return raw(query, ...values);
    });
    const pending = f.invoke();
    await waiting;
    expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    f.options.actorExists = false;
    release();
    expect((await pending).status).toBe(404);
    expect(f.tx.taskRequest.updateMany).not.toHaveBeenCalled();
  });

  it("does not report success when the logical marker CAS loses or the transaction fails", async () => {
    const cas = fixture();
    cas.options.marker = marker("DRAFT");
    cas.options.markerUpdateFailure = true;
    await denied(cas, 409, "STALE_TASK_VERSION");

    const commit = fixture();
    commit.options.marker = marker("DRAFT");
    commit.options.commitFailure = true;
    const response = await commit.invoke();
    expect(response.status).toBe(500);
    expect(commit.state.logical).toBe(false);
    expect(runtime.emitUpdated).not.toHaveBeenCalled();
  });

  it("preserves legacy custom IDs and the common OWN read filter", async () => {
    const taskId = "историческая:задача/ custom";
    const f = fixture(taskId);
    const response = await f.invoke();
    expect(response.status).toBe(200);
    expect(f.database.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [taskReadPredicate({ id: "author", globalRole: "USER" }, [], [], true), { id: taskId }] },
    }));
    expect(runtime.emitDeleted).toHaveBeenCalledWith("project", "историческая:задача/ custom", "author");
  });

  it.each(["sync", "async", "logger"])("preserves committed deletion after %s delivery failure", async (failure) => {
    const f = fixture();
    const error = new Error("synthetic-private-delivery");
    if (failure === "async") runtime.emitDeleted.mockRejectedValue(error);
    else if (failure === "sync") runtime.emitDeleted.mockImplementation(() => { throw error; });
    else runtime.warn.mockImplementation(() => { throw error; });
    const response = await f.invoke();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ deleted: true });
    expect(f.state.deleted).toBe(true);
  });

  it.each(["auth", "rate", "outer404"])("preserves early %s response before the transaction", async (kind) => {
    const f = fixture();
    if (kind === "auth") runtime.auth.mockRejectedValue(new UnauthorizedError());
    if (kind === "rate") runtime.rate.mockRejectedValue(new Error("limit"));
    if (kind === "outer404") f.options.outerExists = false;
    expect((await f.invoke()).status).toBe(kind === "auth" ? 401 : kind === "rate" ? 429 : 404);
    expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(f.state.deleted).toBe(false);
  });
});

it("BezNal executor cannot bypass customer approval through actual DELETE endpoint",async()=>{
 const f=fixture();f.options.beznal=true;f.options.marker=marker("IN_PROGRESS");f.options.groupMember=true;runtime.auth.mockResolvedValue({id:"executor",globalRole:"USER"});
 await denied(f,403,"FORBIDDEN_ROLE");expect(f.tx.taskRequest.updateMany).not.toHaveBeenCalled();expect(f.tx.activity.create).not.toHaveBeenCalled();expect(f.tx.task.delete).not.toHaveBeenCalled();
});
