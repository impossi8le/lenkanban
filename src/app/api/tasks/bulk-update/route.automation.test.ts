import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  automation: vi.fn(),
  database: {} as object,
  diagnostic: vi.fn(),
  moved: vi.fn(),
  updated: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(api.database, key) }) }));
vi.mock("next-auth", () => ({ getServerSession: async () => ({ user: { id: "actor" } }) }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: api.moved, emitTaskUpdated: api.updated }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: api.diagnostic, warn: api.diagnostic } }));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processBulkMoveAutomation: api.automation,
}));

import { POST } from "./route";

const taskId = "cm0000000000000000000001";
type Row = {
  id: string; projectId: string; columnId: string; status: string; priority: string;
  version: number; deadline: Date | null; project: { id: string };
};
type Data = { priority?: string; deadline?: Date | null; columnId?: string; status?: string; rank?: string; position?: number; version?: { increment: number } };

function fixture(options: { destinationStatus?: string; assignees?: string[]; actorRole?: "USER" | "ADMIN" } = {}) {
  const row: Row = {
    id: taskId, projectId: "project", columnId: "old-column", status: "TODO", priority: "MEDIUM",
    version: 4, deadline: null, project: { id: "project" },
  };
  const state = { row: structuredClone(row) };
  const before = structuredClone(state);
  let working = structuredClone(state);
  let active = false;
  let committed = false;
  let outerReads = 0;
  let taskLocked = false;
  const apply = (target: Row, data: Data) => {
    const { version, ...scalar } = data;
    Object.assign(target, scalar);
    if (version) target.version += version.increment;
    return target;
  };
  // A two-column legacy route: source immediately precedes DONE.
  const columns = [
    { id: "old-column", projectId: "project", name: "Synthetic source", workflowKey: "TODO", position: 10 },
    { id: "new-column", projectId: "project", name: "Synthetic destination", workflowKey: options.destinationStatus ?? "DONE", position: 30 },
  ];
  const columnRows = (columnId: unknown) => columns.filter(c => c.id === columnId).map(column => ({
    ...column,
    precedingColumnId: columns.filter(c => c.projectId === column.projectId && c.position < column.position)
      .sort((a, b) => b.position - a.position)[0]?.id ?? null,
  }));
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes("FOR SHARE OF g, gm")) return [{ id: "group", userId: "actor" }];
      if (sql.includes('FROM "User"')) return [{ id: "actor" }];
      if (sql.includes('FROM "ProjectColumn"')) {
        return columnRows(values[0]);
      }
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) {
        if (sql.includes('WHERE "columnId"')) return [];
        if (sql.includes("FOR UPDATE")) taskLocked = true;
        const found = working.row;
        if (sql.includes('"priority"')) {
          return [{ id: found.id, projectId: found.projectId, priority: found.priority, version: found.version }];
        }
        return [{ id: found.id, projectId: found.projectId, columnId: found.columnId, status: found.status, version: found.version }];
      }
      throw new Error("Unexpected fixture query");
    }),
    user: { findUnique: vi.fn(async () => ({ id: "actor", globalRole: options.actorRole ?? "ADMIN" })) },
    taskAssignee: { findMany: vi.fn(async () => { expect(active).toBe(true); expect(taskLocked).toBe(true); return (options.assignees ?? ["actor"]).map(userId => ({ userId })); }) },
    project: {
      findUnique: vi.fn(async () => ({ id: "project", ownerId: "actor", members: [], responsibleGroup: { archivedAt: null, members: [{ userId: "actor" }] } })),
      update: vi.fn(async () => ({ boardRevision: 9 })),
    },
    taskRequest: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    task: {
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; version: number }; data: Data }) => {
        expect(active).toBe(true);
        if (working.row.id !== where.id || working.row.version !== where.version) return { count: 0 };
        apply(working.row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Data }) => {
        expect(active).toBe(true);
        return apply(working.row.id === where.id ? working.row : row, data);
      }),
      findFirst: vi.fn(async ({ orderBy, select }: { orderBy?: { position?: string; rank?: string }; select?: { id?: boolean } }) =>
        select?.id ? { id: taskId } : orderBy?.position ? { position: 2048 } : { rank: "0|HZZZZZZZZZZZZZZZZZZZ" }),
      findUniqueOrThrow: vi.fn(async () => ({
        id: working.row.id, columnId: working.row.columnId, version: working.row.version, status: working.row.status,
      })),
      findMany: vi.fn(async () => []),
    },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
  };
  const database = {
    task: {
      findMany: vi.fn(async () => {
        outerReads++;
        if (outerReads === 1) {
          return [{ ...structuredClone(before.row), project: { id: "project", ownerId: "actor", members: [{ id: "membership" }] } }];
        }
        return [structuredClone(state.row)];
      }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state); active = true;
      try {
        const result = await callback(tx);
        Object.assign(state, structuredClone(working)); committed = true; return result;
      } finally { active = false; }
    }),
  };
  api.database = database;
  for (const emit of [api.moved, api.updated]) emit.mockImplementation(() => { expect(committed).toBe(true); });
  const run = (updates: object = { columnId: "new-column" }) => POST(new Request("http://localhost/api/tasks/bulk-update", {
    method: "POST", body: JSON.stringify({ taskIds: [taskId], updates }),
  }) as never);
  return { state, before, tx, database, run };
}

beforeEach(() => { vi.resetAllMocks(); });

describe("bulk-update automation wiring (#35)", () => {
  it.each(["USER", "ADMIN"] as const)("denies deadline changes by a non-executor %s author without effects", async actorRole => {
    for (const column of [false, true]) for (const deadline of [null, "2026-10-30T12:00:00.000Z"]) {
      const f = fixture({ actorRole, assignees: ["other"] });
      expect((await f.run({ deadline, ...(column ? { columnId: "new-column" } : {}) })).status).toBe(404);
      expect(f.state).toEqual(f.before); expect(api.moved).not.toHaveBeenCalled(); expect(api.updated).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled();
    }
  });
  it.each([{ assignees: [] }, { assignees: ["actor", "other"] }])("denies unassigned/ambiguous deadline authority %j", async ({ assignees }) => {
    const f = fixture({ assignees }); expect((await f.run({ deadline: null, columnId: "new-column" })).status).toBe(404); expect(f.state).toEqual(f.before); expect(api.moved).not.toHaveBeenCalled();
  });
  it("allows the sole executor to set/remove deadlines in scalar and mixed moves while holding Task lock", async () => {
    for (const column of [false, true]) for (const deadline of [null, "2026-10-30T12:00:00.000Z"]) {
      const f = fixture({ actorRole: "USER", assignees: ["actor"] });
      expect((await f.run({ deadline, ...(column ? { columnId: "new-column" } : {}) })).status).toBe(200);
      expect(f.tx.taskAssignee.findMany).toHaveBeenCalledExactlyOnceWith({ where: { taskId }, select: { userId: true }, take: 2 });
      expect(f.state.row.deadline).toEqual(deadline ? new Date(deadline) : null);
    }
  });
  it("starts one status_changed automation input per committed workflow move", async () => {
    const f = fixture();
    const response = await f.run();
    expect(response.status).toBe(200);
    expect(api.moved).toHaveBeenCalledOnce();
    expect(api.automation).toHaveBeenCalledOnce();
    expect(api.automation).toHaveBeenCalledWith([{
      taskId,
      projectId: "project",
      userId: "actor",
      previousStatus: "TODO",
      result: expect.objectContaining({
        task: expect.objectContaining({ id: taskId, columnId: "new-column", status: "DONE", version: 5 }),
      }),
    }]);
  });

  it("keeps a same-column move silent", async () => {
    const f = fixture();
    const response = await f.run({ columnId: "old-column" });
    expect(response.status).toBe(200);
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(api.moved).not.toHaveBeenCalled();
    // Canonical relocation reports no move, so no status event reaches automation.
    expect(api.automation).not.toHaveBeenCalled();
  });

  it("runs no automation for scalar-only updates", async () => {
    const f = fixture();
    const response = await f.run({ priority: "HIGH" });
    expect(response.status).toBe(200);
    expect(f.tx.task.update).toHaveBeenCalledWith({ where: { id: taskId }, data: { priority: "HIGH" } });
    expect(api.automation).not.toHaveBeenCalled();
  });

  it("keeps the committed bulk-update ACK when automation fails", async () => {
    const f = fixture();
    api.automation.mockRejectedValueOnce(new Error("synthetic-private-automation"));
    const response = await f.run();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ success: true, updatedCount: 1 });
    expect(api.diagnostic).toHaveBeenCalledWith({
      event: "task.bulk.automation.failed", route: "/api/tasks/bulk-update", err: expect.any(Error),
    });
    expect(JSON.stringify(api.diagnostic.mock.calls)).not.toMatch(/synthetic-private-automation/);
  });
});
