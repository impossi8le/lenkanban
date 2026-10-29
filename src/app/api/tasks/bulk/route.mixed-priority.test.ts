import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ automation: vi.fn(), database: {} as object, moved: vi.fn(), updated: vi.fn() }));
// Quota SQL is exercised by adjacent route.rate-limit tests; retain this
// fixture's focused transactional/receipt/rollback assertions behind admission.
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => undefined, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(api.database, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: async () => ({ id: "actor", globalRole: "ADMIN" }) }));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: api.moved, emitTaskUpdated: api.updated }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processBulkMoveAutomation: api.automation,
}));
import { PATCH } from "./route";

const id = (n: number) => `c${String(n).padStart(24, "0")}`;
const row = (n: number) => ({ id: id(n), projectId: "project", columnId: "old-column", status: "TODO", priority: "MEDIUM", version: 4, rank: "0|HZZZZZZZZZZZZZZZZZZZ", position: n * 1024, project: { id: "project" } });
type Row = ReturnType<typeof row>;
type Activity = { taskId: string; action: string; oldValue: object; newValue: object };
type Data = { priority?: string; columnId?: string; status?: string; rank?: string; position?: number; version?: { increment: number } };
function fixture(freshPriority = "LOW") {
  const outer = [row(2), row(1)];
  const state = { rows: outer.map(r => ({ ...r, priority: freshPriority })), activities: [] as Activity[] };
  const before = structuredClone(state);
  let working = structuredClone(state), active = false, committed = false;
  const locks = new Set<string>(), trace: string[] = [];
  const options: { staleSecond: boolean; failPriorityAudit: boolean; readFailure: boolean; snapshot?: (rows: unknown[]) => unknown } = { staleSecond: false, failPriorityAudit: false, readFailure: false };
  const apply = (r: Row, data: Data) => {
    const { version, ...values } = data; Object.assign(r, values);
    if (version) r.version += version.increment;
    return r;
  };
  // A two-column legacy route: source immediately precedes DONE.
  const columns = [
    { id: "old-column", projectId: "project", name: "Synthetic source", workflowKey: "TODO", position: 10 },
    { id: "new-column", projectId: "project", name: "Synthetic destination", workflowKey: "DONE", position: 30 },
  ];
  const columnRows = (columnId: unknown) => columns.filter(c => c.id === columnId).map(column => ({
    ...column,
    precedingColumnId: columns.filter(c => c.projectId === column.projectId && c.position < column.position)
      .sort((a, b) => b.position - a.position)[0]?.id ?? null,
  }));
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "User"')) { trace.push("actor"); return [{ id: "actor" }]; }
      if (sql.includes('FROM "ProjectColumn"')) return columnRows(values[0]);
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) {
        if (sql.includes('WHERE "columnId"')) return [];
        if (sql.includes('"priority"')) return working.rows.map(({ id, projectId, priority, version }) => ({ id, projectId, priority, version }));
        const found = working.rows.find(r => r.id === values[0]);
        if (!found) return [];
        locks.add(found.id); trace.push(`lock:${found.id}`);
        return [{ ...found, version: options.staleSecond && found.id === id(1) ? 5 : found.version }];
      }
      throw Error("Unexpected fixture query");
    }),
    user: { findUnique: vi.fn(async () => ({ id: "actor", globalRole: "ADMIN" })) },
    project: { findUnique: vi.fn(async () => ({ id: "project", ownerId: "actor", members: [] })), update: vi.fn(async () => ({ boardRevision: 9 })) },
    taskRequest: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    task: {
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; version: number }; data: Data }) => {
        expect(active).toBe(true);
        const found = working.rows.find(r => r.id === where.id && r.version === where.version);
        if (!found) return { count: 0 };
        trace.push("move"); apply(found, data); return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Data }) => {
        expect(active).toBe(true); trace.push("priority-write"); return apply(working.rows.find(r => r.id === where.id)!, data);
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => structuredClone(working.rows.find(r => r.id === where.id)!)),
      findFirst: vi.fn(async ({ orderBy }: { orderBy: { position?: string } }) => orderBy.position ? { position: 2048 } : { rank: "0|HZZZZZZZZZZZZZZZZZZZ" }),
      findMany: vi.fn(async (input: { select?: unknown; where: unknown }) => {
        expect(active).toBe(true);
        if (input.select) {
          expect(input).toEqual({ where: { id: { in: [id(2), id(1)] } }, select: { id: true, projectId: true, priority: true } });
          expect(locks.size).toBe(2); trace.push("priority-read");
          if (options.readFailure) throw Error("synthetic-private-read");
          const rows = working.rows.map(({ id, projectId, priority }) => ({ id, projectId, priority }));
          return options.snapshot ? options.snapshot(rows) : rows.reverse();
        }
        trace.push("dto"); return structuredClone(working.rows);
      }),
    },
    activity: { create: vi.fn(async ({ data }: { data: Activity }) => {
      if (options.failPriorityAudit && data.action === "priority_changed") throw Error("synthetic-private-audit");
      trace.push(`activity:${data.action}`); working.activities.push(structuredClone(data)); return data;
    }) },
  };
  const database = {
    task: { findMany: vi.fn(async () => {
      if (active || committed) throw Error("Forbidden outer reread");
      return outer.map(r => ({ ...structuredClone(r), project: { id: "project", ownerId: "actor", members: [] } }));
    }) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state); active = true;
      try { const result = await callback(tx); Object.assign(state, structuredClone(working)); committed = true; return result; }
      finally { active = false; }
    }),
  };
  api.database = database;
  for (const emit of [api.moved, api.updated]) emit.mockImplementation(() => { expect(committed).toBe(true); });
  const run = (updates: object = { columnId: "new-column", priority: "HIGH" }, duplicate = false) => PATCH(new Request("http://localhost/api/tasks/bulk", { method: "PATCH", body: JSON.stringify({ taskIds: [id(2), id(1), ...(duplicate ? [id(1)] : [])], updates }) }));
  return { state, before, tx, database, trace, options, run };
}
beforeEach(() => { vi.resetAllMocks(); });

describe("mixed bulk fresh priority with actual canonical relocation", () => {
  it.each([
    { fresh: "LOW", requested: "HIGH", writes: 2 },
    { fresh: "LOW", requested: "MEDIUM", writes: 2 },
    { fresh: "HIGH", requested: "HIGH", writes: 0 },
  ])("compares $requested against locked $fresh rather than outer MEDIUM", async ({ fresh, requested, writes }) => {
    const f = fixture(fresh); const response = await f.run({ columnId: "new-column", priority: requested }, true);
    expect(response.status).toBe(200); expect((await response.json()).data).toEqual({ success: true, updatedCount: 2, tasks: f.state.rows });
    expect(f.tx.task.update).toHaveBeenCalledTimes(writes);
    expect(f.state.rows.map(r => [r.priority, r.version])).toEqual([[requested, 5], [requested, 5]]);
    const priorities = f.state.activities.filter(a => a.action === "priority_changed");
    expect(priorities).toEqual(writes ? [id(2), id(1)].map(taskId => ({ taskId, userId: "actor", action: "priority_changed", oldValue: { priority: fresh }, newValue: { priority: requested } })) : []);
    expect(f.state.activities.map(a => a.action)).toEqual(["moved", "moved", ...Array<string>(writes).fill("priority_changed")]);
    expect(f.trace.filter(t => t === "priority-read")).toHaveLength(1);
    expect(f.trace.lastIndexOf("move")).toBeLessThan(f.trace.indexOf("priority-read"));
    if (writes) expect(f.trace.indexOf("priority-read")).toBeLessThan(f.trace.indexOf("priority-write"));
    expect(f.database.task.findMany).toHaveBeenCalledOnce(); expect(f.database.$transaction).toHaveBeenCalledOnce();
    expect(api.updated.mock.calls).toEqual(f.state.rows.map(r => ["project", r]));
    expect(api.moved).toHaveBeenCalledTimes(2);
    for (const taskId of [id(2), id(1)]) expect(api.moved).toHaveBeenCalledWith("project", expect.objectContaining({ task: expect.objectContaining({ id: taskId, columnId: "new-column", status: "DONE", version: 5 }) }));
    for (const taskId of [id(2), id(1)]) expect(f.tx.task.updateMany).toHaveBeenCalledWith({ where: { id: taskId, version: 4 }, data: expect.objectContaining({ version: { increment: 1 } }) });
    // Only the workflow-changing rows produce automation input; the previous
    // status comes from the pre-move read, not the committed result.
    expect(api.automation).toHaveBeenCalledOnce();
    expect(api.automation).toHaveBeenCalledWith([id(2), id(1)].map(taskId => ({
      taskId, projectId: "project", userId: "actor", previousStatus: "TODO",
      result: expect.objectContaining({ task: expect.objectContaining({ id: taskId, status: "DONE" }) }),
    })));
  });
  it.each(["LOW", "HIGH"])("includes same-column null targets with fresh %s", async fresh => {
    const f = fixture(fresh); const response = await f.run({ columnId: "old-column", priority: "HIGH" });
    expect(response.status).toBe(200); expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled();
    expect(f.tx.task.update).toHaveBeenCalledTimes(fresh === "HIGH" ? 0 : 2);
    expect(f.state.rows.map(r => r.version)).toEqual([4, 4]); expect(f.trace.filter(t => t === "priority-read")).toHaveLength(1);
    expect(f.tx.taskRequest.findUnique).toHaveBeenCalledTimes(2); expect(f.tx.user.findUnique).toHaveBeenCalledTimes(2);
    expect(f.state.activities).toEqual(fresh === "HIGH" ? [] : [id(2), id(1)].map(taskId => ({ taskId, userId: "actor", action: "priority_changed", oldValue: { priority: "LOW" }, newValue: { priority: "HIGH" } })));
    expect(api.updated.mock.calls).toEqual(f.state.rows.map(r => ["project", r]));
    // Same-column moves keep their workflow status, so no status_changed event.
    expect(api.automation).not.toHaveBeenCalled();
  });
  it.each([{ columnId: "new-column" }, { priority: "HIGH" }])("does not add a narrow snapshot outside mixed priority: %j", async updates => {
    const f = fixture(); expect((await f.run(updates)).status).toBe(200);
    expect(f.trace).not.toContain("priority-read"); expect(f.tx.task.findMany).toHaveBeenCalledOnce();
    if ("priority" in updates) {
      expect(f.tx.task.update).toHaveBeenCalledTimes(2);
      expect(f.state.rows.map(r => [r.priority, r.version])).toEqual([["HIGH", 4], ["HIGH", 4]]);
      expect(f.state.activities).toEqual([expect.objectContaining({ oldValue: { priority: "LOW" }, newValue: { priority: "HIGH" } }), expect.objectContaining({ oldValue: { priority: "LOW" }, newValue: { priority: "HIGH" } })]);
      // Priority-only updates are not workflow moves; automation stays untouched.
      expect(api.automation).not.toHaveBeenCalled();
    } else {
      expect(api.automation).toHaveBeenCalledOnce();
    }
  });
  it.each(["new-column", "old-column"])("keeps original stale CAS409 for %s before priority phase and discards earlier work", async columnId => {
    const f = fixture(); f.options.staleSecond = true; const response = await f.run({ columnId, priority: "HIGH" });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "STALE_TASK_VERSION" } });
    expect(f.tx.task.updateMany).toHaveBeenCalledTimes(columnId === "new-column" ? 1 : 0); expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.trace).not.toContain("priority-read");
    expect(f.state).toEqual(f.before); expect(api.moved).not.toHaveBeenCalled(); expect(api.updated).not.toHaveBeenCalled();
    expect(api.automation).not.toHaveBeenCalled();
  });
  it.each([
    { name: "missing", code: 404, snapshot: (rows: unknown[]) => rows.slice(0, 1) },
    { name: "duplicate", code: 500, snapshot: (rows: unknown[]) => [rows[0], rows[0]] },
    { name: "foreign", code: 500, snapshot: (rows: unknown[]) => [...rows, { id: id(3), projectId: "project", priority: "LOW" }] },
    { name: "identity", code: 409, snapshot: (rows: unknown[]) => [{ ...(rows[0] as object), projectId: "other" }, rows[1]] },
    { name: "extra field", code: 500, snapshot: (rows: unknown[]) => [{ ...(rows[0] as object), version: 99 }, rows[1]] },
    { name: "wrong priority", code: 500, snapshot: (rows: unknown[]) => [{ ...(rows[0] as object), priority: 9 }, rows[1]] },
    { name: "nonarray", code: 500, snapshot: () => null },
    { name: "hostile proxy", code: 500, snapshot: () => [new Proxy({}, { ownKeys() { throw Error("synthetic-private-proxy"); } })] },
  ])("fails closed on $name fresh set without priority writes or delivery", async ({ code, snapshot }) => {
    const f = fixture(); f.options.snapshot = snapshot; const response = await f.run();
    expect(response.status).toBe(code); expect(await response.text()).not.toMatch(/synthetic-private/);
    expect(f.tx.task.updateMany).toHaveBeenCalledTimes(2); expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.state).toEqual(f.before); expect(api.moved).not.toHaveBeenCalled(); expect(api.updated).not.toHaveBeenCalled();
  });
  it("rejects an accessor without evaluating it", async () => {
    const f = fixture(), getter = vi.fn(() => "LOW");
    f.options.snapshot = rows => [Object.defineProperty({ id: id(2), projectId: "project" }, "priority", { enumerable: true, get: getter }), rows[1]];
    expect((await f.run()).status).toBe(500); expect(getter).not.toHaveBeenCalled(); expect(f.state).toEqual(f.before);
  });
  it.each(["readFailure", "failPriorityAudit"] as const)("rolls back moves and priority state on %s", async failure => {
    const f = fixture(); f.options[failure] = true; const response = await f.run();
    expect(response.status).toBe(500); expect(f.state).toEqual(f.before);
    expect(api.moved).not.toHaveBeenCalled(); expect(api.updated).not.toHaveBeenCalled();
    expect(api.automation).not.toHaveBeenCalled();
    expect(f.tx.task.update).toHaveBeenCalledTimes(failure === "readFailure" ? 0 : 1);
  });
});
