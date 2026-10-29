import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ automation: vi.fn(), database: {} as object, updated: vi.fn(), moved: vi.fn(), diagnostic: vi.fn() }));
// Quota SQL is exercised by adjacent route.rate-limit tests; retain this
// fixture's focused transactional/receipt/rollback assertions behind admission.
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => undefined, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(api.database, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: async () => ({ id: "actor", globalRole: "ADMIN" }) }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: api.updated, emitTaskMoved: api.moved }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: api.diagnostic, warn: api.diagnostic } }));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processBulkMoveAutomation: api.automation,
}));

import { PATCH } from "./route";

const id = (n: number) => `c${String(n).padStart(24, "0")}`;
function makeRow(n: number) {
  return {
    id: id(n), projectId: "project", columnId: "old-column", status: "TODO", priority: "MEDIUM",
    version: 4, title: `Synthetic title ${n}`, description: "synthetic-private-description", rank: "0|HZZZZZZZZZZZZZZZZZZZ", position: n * 1024,
    assignees: [{ userId: "actor", user: { id: "actor", name: "Synthetic actor", email: "synthetic@example.invalid", avatarUrl: null } }],
    tags: [{ tagId: "tag", tag: { id: "tag", name: "Synthetic tag", color: "#000000" } }],
    checklistItems: [{ id: "item", text: "synthetic-private-checklist", completed: false, position: 0 }],
    project: { id: "project" }, _count: { messages: 3 },
  };
}
type Row = ReturnType<typeof makeRow>;
type UpdateData = { priority?: string; columnId?: string; status?: string; rank?: string; position?: number; version?: { increment: number } };
const projection = {
  assignees: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
  tags: { include: { tag: true } }, checklistItems: { orderBy: { position: "asc" } },
  project: { select: { id: true } }, _count: { select: { messages: true } },
};

function fixture() {
  const state = { rows: [makeRow(2), makeRow(1)], activities: [] as unknown[], revision: 8 };
  const before = structuredClone(state);
  let working = structuredClone(state);
  let active = false, committed = false;
  const trace: string[] = [];
  const options = { snapshotFailure: false, commitFailure: false, auditFailure: false, stale: false, mismatch: "", reverse: false, columnProject: "project" };
  const apply = (row: Row, data: UpdateData) => {
    const { version, ...scalar } = data; Object.assign(row, scalar);
    if (version) row.version += version.increment;
    return row;
  };
  // A two-column legacy route: source immediately precedes DONE.
  const columns = [
    { id: "old-column", projectId: "project", name: "Synthetic source", workflowKey: "TODO", position: 10 },
    { id: "new-column", get projectId() { return options.columnProject; }, name: "Synthetic destination", workflowKey: "DONE", position: 30 },
  ];
  const columnRows = (columnId: unknown) => columns.filter(c => c.id === columnId).map(column => ({
    ...column,
    precedingColumnId: columns.filter(c => c.projectId === column.projectId && c.position < column.position)
      .sort((a, b) => b.position - a.position)[0]?.id ?? null,
  }));
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "User"')) return [{ id: "actor" }];
      if (sql.includes('FROM "ProjectColumn"')) return columnRows(values[0]);
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) {
        if (sql.includes('WHERE "columnId"')) return [];
        if (sql.includes('"priority"')) return working.rows.map(({ id, projectId, priority, version }) => ({ id, projectId, priority, version }));
        const row = working.rows.find(r => r.id === values[0]);
        return row ? [{ ...row, version: options.stale ? 5 : row.version }] : [];
      }
      throw new Error("Unexpected fixture query");
    }),
    user: { findUnique: vi.fn(async () => ({ id: "actor", globalRole: "ADMIN" })) },
    project: {
      findUnique: vi.fn(async () => ({ id: "project", ownerId: "actor", members: [] })),
      update: vi.fn(async () => ({ boardRevision: ++working.revision })),
    },
    taskRequest: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    task: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: UpdateData }) => {
        expect(active).toBe(true); trace.push("write"); return apply(working.rows.find(r => r.id === where.id)!, data);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; version: number }; data: UpdateData }) => {
        expect(active).toBe(true); const row = working.rows.find(r => r.id === where.id && r.version === where.version);
        if (!row) return { count: 0 }; trace.push("CAS"); apply(row, data); return { count: 1 };
      }),
      findFirst: vi.fn(async ({ orderBy }: { orderBy: { position?: string } }) => orderBy.position ? { position: 2048 } : { rank: "0|HZZZZZZZZZZZZZZZZZZZ" }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => structuredClone(working.rows.find(r => r.id === where.id)!)),
      findMany: vi.fn(async (input: { include?: unknown }) => {
        expect(active).toBe(true); trace.push("snapshot"); expect(input.include).toEqual(projection);
        if (options.snapshotFailure) throw new Error("synthetic-private-read");
        const result = structuredClone(working.rows);
        if (options.mismatch === "project") result[0].project.id = "wrong-room";
        if (options.mismatch === "projectId") result[0].projectId = "wrong-room";
        return options.reverse ? result.reverse() : result;
      }),
    },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => {
      if (options.auditFailure) throw new Error("synthetic-private-audit"); working.activities.push(data); return data;
    }) },
  };
  const database = {
    task: { findMany: vi.fn(async () => {
      if (active || committed) throw new Error("Forbidden global response reread");
      return before.rows.map(row => ({ ...structuredClone(row), project: { id: "project", ownerId: "actor", members: [] } }));
    }) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state); active = true; trace.push("begin");
      try {
        const result = await callback(tx); trace.push("commit-attempt");
        if (options.commitFailure) throw new Error("synthetic-private-commit");
        Object.assign(state, structuredClone(working)); committed = true; trace.push("commit"); return result;
      } finally { active = false; }
    }),
  };
  api.database = database;
  for (const emit of [api.updated, api.moved]) emit.mockImplementation(() => { expect(committed).toBe(true); trace.push("delivery"); });
  const run = (updates: object = { priority: "HIGH" }, duplicate = false) => PATCH(new Request("http://localhost/api/tasks/bulk", {
    method: "PATCH", body: JSON.stringify({ taskIds: [...state.rows.map(r => r.id), ...(duplicate ? [id(1)] : [])], updates }),
  }));
  return { state, before, options, trace, tx, database, run };
}
beforeEach(() => { vi.resetAllMocks(); });

describe("bulk PATCH committed response boundary with real guard and canonical relocation", () => {
  it("reads the unchanged full projection after writes inside TX, preserves order/count and never globally rereads", async () => {
    const f = fixture(); f.options.reverse = true;
    const response = await f.run(undefined, true);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ success: true, updatedCount: 2, tasks: [...f.state.rows].reverse() });
    expect(f.database.task.findMany).toHaveBeenCalledOnce(); expect(f.tx.task.findMany).toHaveBeenCalledOnce();
    expect(f.tx.task.findMany).toHaveBeenCalledWith({ where: { id: { in: [id(2), id(1), id(1)] } }, include: projection });
    expect(f.trace.lastIndexOf("write")).toBeLessThan(f.trace.indexOf("snapshot"));
    expect(f.trace.indexOf("snapshot")).toBeLessThan(f.trace.indexOf("commit"));
    expect(f.trace.indexOf("commit")).toBeLessThan(f.trace.indexOf("delivery"));
    expect(f.tx.task.update).toHaveBeenCalledTimes(2); expect(f.state.activities).toHaveLength(2);
    expect(f.state.rows.map(r => r.version)).toEqual([4, 4]);
  });
  it.each(["snapshotFailure", "commitFailure", "auditFailure"] as const)("returns safe failure, discards fixture working state and sends no effects on %s", async failure => {
    const f = fixture(); f.options[failure] = true;
    const response = await f.run(); expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/synthetic-private|description|checklist/);
    expect(f.state).toEqual(f.before); expect(api.updated).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled();
    expect(api.automation).not.toHaveBeenCalled();
    expect(f.database.task.findMany).toHaveBeenCalledOnce(); expect(f.database.$transaction).toHaveBeenCalledOnce();
    expect(f.tx.task.update).toHaveBeenCalledTimes(failure === "auditFailure" ? 1 : 2);
  });
  it.each(["sync", "async"] as const)("retains exact ACK and later updated delivery after %s effect and diagnostic failures", async mode => {
    const f = fixture();
    const fail = () => { if (mode === "sync") throw new Error("synthetic-private-effect"); return Promise.reject(new Error("synthetic-private-effect")); };
    api.updated.mockImplementationOnce(fail); api.diagnostic.mockImplementation(fail);
    const response = await f.run(); expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ success: true, updatedCount: 2, tasks: f.state.rows });
    expect(api.updated).toHaveBeenCalledTimes(2); expect(api.diagnostic).toHaveBeenCalled();
    expect(api.diagnostic).toHaveBeenCalledWith({ event: "task.bulk.update.realtime.failed", route: "/api/tasks/bulk" });
    expect(JSON.stringify(api.diagnostic.mock.calls)).not.toMatch(/synthetic-private-description|synthetic-private-checklist|Synthetic title/);
    expect(f.tx.task.update).toHaveBeenCalledTimes(2); expect(f.database.$transaction).toHaveBeenCalledOnce(); expect(f.database.task.findMany).toHaveBeenCalledOnce();
  });
  it.each(["project", "projectId"])("drops mismatched %s update routing without corrupting response or suppressing other task", async mismatch => {
    const f = fixture(); f.options.mismatch = mismatch;
    const response = await f.run(); expect(response.status).toBe(200);
    const data = (await response.json()).data; expect(data.updatedCount).toBe(2);
    expect(api.updated).toHaveBeenCalledTimes(1); expect(api.updated).toHaveBeenCalledWith("project", data.tasks[1]);
    expect(data.tasks[0][mismatch === "project" ? "project" : "projectId"]).toEqual(mismatch === "project" ? { id: "wrong-room" } : "wrong-room");
  });
  it("preserves original canonical CAS versions and one move/activity per target without mutation retry", async () => {
    const f = fixture(); const response = await f.run({ columnId: "new-column", status: "TODO" });
    expect(response.status).toBe(200); expect((await response.json()).data.tasks).toEqual(f.state.rows);
    expect(f.tx.task.updateMany).toHaveBeenCalledTimes(2);
    for (const row of f.before.rows) expect(f.tx.task.updateMany).toHaveBeenCalledWith({ where: { id: row.id, version: 4 }, data: expect.objectContaining({ columnId: "new-column", status: "DONE", version: { increment: 1 } }) });
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.state.rows.map(r => r.version)).toEqual([5, 5]);
    expect(f.state.activities).toHaveLength(2); expect(api.moved).toHaveBeenCalledTimes(2); expect(api.updated).toHaveBeenCalledTimes(2);
    // One status_changed event per committed row, built from the pre-move status.
    expect(api.automation).toHaveBeenCalledOnce();
    expect(api.automation).toHaveBeenCalledWith([id(2), id(1)].map(taskId => ({
      taskId, projectId: "project", userId: "actor", previousStatus: "TODO",
      result: expect.objectContaining({ task: expect.objectContaining({ id: taskId, columnId: "new-column", status: "DONE" }) }),
    })));
  });
  it.each(["sync", "async"] as const)("continues all move and updated delivery after %s first moved effect failure", async mode => {
    const f = fixture(); api.moved.mockImplementationOnce(() => { if (mode === "sync") throw new Error("synthetic-private-move"); return Promise.reject(new Error("synthetic-private-move")); });
    api.diagnostic.mockImplementation(() => { throw new Error("synthetic-private-sink"); });
    const response = await f.run({ columnId: "new-column" }); expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ success: true, updatedCount: 2, tasks: f.state.rows });
    expect(api.moved).toHaveBeenCalledTimes(2); expect(api.updated).toHaveBeenCalledTimes(2);
    expect(api.diagnostic).toHaveBeenCalledWith({ event: "task.bulk.move.realtime.failed", route: "/api/tasks/bulk" });
    expect(f.tx.task.updateMany).toHaveBeenCalledTimes(2); expect(f.database.$transaction).toHaveBeenCalledOnce();
  });
  it.each(["project", "projectId"])("never sends a canonical move to a mismatched committed %s", async mismatch => {
    const f = fixture(); f.options.mismatch = mismatch;
    const response = await f.run({ columnId: "new-column" }); expect(response.status).toBe(200);
    expect(api.moved).toHaveBeenCalledTimes(1);
    expect(api.moved).toHaveBeenCalledWith("project", expect.objectContaining({ task: expect.objectContaining({ id: id(1) }) }));
    expect(f.tx.task.updateMany).toHaveBeenCalledTimes(2);
  });
  it("isolates nested delivery payload mutation from both committed ACK and later updates", async () => {
    const f = fixture();
    api.updated.mockImplementation((_project: string, task: Row) => { task.title = "mutated"; task.tags[0].tag.name = "mutated"; task.checklistItems.length = 0; });
    api.moved.mockImplementation((_project: string, move: { task: { id: string; version: number } }) => { move.task.id = "mutated"; move.task.version = 999; });
    const response = await f.run({ columnId: "new-column" }); expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ success: true, updatedCount: 2, tasks: f.state.rows });
    expect(f.state.rows.every(r => r.title !== "mutated" && r.version === 5 && r.tags[0].tag.name !== "mutated" && r.checklistItems.length === 1)).toBe(true);
    expect(api.updated).toHaveBeenCalledTimes(2); expect(api.moved).toHaveBeenCalledTimes(2);
  });
  it("rejects a cross-board destination column before any write or effect", async () => {
    const f = fixture(); f.options.columnProject = "other-project";
    const response = await f.run({ columnId: "new-column" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: "Колонка не принадлежит проекту задачи" } });
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.tx.activity.create).not.toHaveBeenCalled();
    expect(f.state).toEqual(f.before);
    expect(api.updated).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled();
    expect(api.automation).not.toHaveBeenCalled();
  });
  it("preserves stale expectedVersion409 before CAS/snapshot/effects", async () => {
    const f = fixture(); f.options.stale = true; const response = await f.run({ columnId: "new-column" });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "STALE_TASK_VERSION" } });
    expect(f.state).toEqual(f.before); expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(f.tx.task.findMany).not.toHaveBeenCalled();
    expect(api.updated).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled();
    expect(api.automation).not.toHaveBeenCalled();
  });
  it("runs no automation for a scalar-only bulk update", async () => {
    const f = fixture(); const response = await f.run({ priority: "HIGH" });
    expect(response.status).toBe(200);
    expect(f.tx.task.update).toHaveBeenCalledTimes(2);
    expect(api.moved).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled();
  });
  it("keeps the committed bulk ACK when automation fails after commit", async () => {
    const f = fixture();
    api.automation.mockRejectedValueOnce(new Error("synthetic-private-automation"));
    const response = await f.run({ columnId: "new-column" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ success: true, updatedCount: 2, tasks: f.state.rows });
    expect(api.automation).toHaveBeenCalledOnce();
    expect(api.diagnostic).toHaveBeenCalledWith({ event: "task.bulk.automation.failed", route: "/api/tasks/bulk", err: expect.any(Error) });
    expect(JSON.stringify(api.diagnostic.mock.calls)).not.toMatch(/synthetic-private-automation/);
    expect(f.state.rows.map(r => r.version)).toEqual([5, 5]);
  });
});
