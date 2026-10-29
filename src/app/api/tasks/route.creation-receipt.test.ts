import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ transaction: vi.fn(), project: vi.fn(), column: vi.fn(), auth: vi.fn(), emit: vi.fn(), automation: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: api.transaction, project: { findFirst: api.project }, projectColumn: { findFirst: api.column } } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: api.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: api.emit }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: api.automation }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: vi.fn() }));
vi.mock("@/features/kanban/server/task-creation-port", () => ({ prepareLegacyTaskCreation: api.prepare }));
import { POST } from "./route";
const projectId = "project", columnId = "column", operationId = "00000000-0000-4000-8000-000000000001";
type Receipt = { operationId: string; requestHash: string; response: unknown };
function fixture() {
  let state = { tasks: [] as Record<string, unknown>[], activities: [] as unknown[], receipts: [] as Receipt[] };
  const options = { allowed: true, actorExists: true, activityFailure: false, receiptFailure: false, commitFailure: false };
  const trace: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => { expect(values.length).toBeGreaterThan(0); const sql = parts.join("?"); trace.push(sql.includes("pg_advisory") ? "operation-lock" : sql.includes('FROM "ProjectColumn"') ? "column-lock" : sql.includes('FROM "Project"') ? "project-lock" : sql.includes('FROM "Task"') ? "task-lock" : "user-lock"); return [{ id: "locked" }]; }),
    user: { findUnique: vi.fn(async () => options.actorExists ? { id: "actor", globalRole: "USER" } : null) },
    project: { findUnique: vi.fn(async () => { trace.push("authorization"); return { ownerId: options.allowed ? "actor" : "other", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{ id: columnId }] }; }) },
    task: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const task = { id: `task-${state.tasks.length + 1}`, ...data, version: 0, createdAt: new Date("2026-10-22T00:00:00Z") }; state.tasks.push(task); return task; }),
    },
    activity: { create: vi.fn(async (args: unknown) => { if (options.activityFailure) throw new Error("synthetic-private"); state.activities.push(args); }) },
    taskMoveOperation: {
      findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => { trace.push("receipt-read"); return state.receipts.find(item => item.operationId === where.operationId) ?? null; }),
      create: vi.fn(async ({ data }: { data: Receipt }) => { if (options.receiptFailure) throw new Error("synthetic-private"); state.receipts.push(data); }),
    },
  };
  api.transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => {
    const before = structuredClone(state);
    try { const result = await callback(tx); if (options.commitFailure) throw new Error("synthetic-private"); return result; }
    catch (error) { state = before; throw error; }
  });
  const run = (extra: object = {}) => POST(new Request("http://localhost/api/tasks", { method: "POST", headers: { authorization: "Bearer synthetic-token" }, body: JSON.stringify({ projectId, columnId, title: "Synthetic task", operationId, ...extra }) }));
  return { tx, options, run, trace, state: () => state };
}
beforeEach(() => {
  vi.resetAllMocks(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  api.project.mockResolvedValue({ id: projectId }); api.column.mockResolvedValue({ id: columnId });
  api.prepare.mockResolvedValue({ column: { id: columnId, workflowKey: "TODO" }, rank: "0|HZZZZZZZZZZZZZZZZZZZ" });
});
describe("create HTTP durable receipt transaction (stateful mock, no real database)", () => {
  it("returns the durable snapshot on retry with one task, Activity and each effect", async () => {
    const f = fixture(); const first = await f.run(); expect(first.status).toBe(201);
    const snapshot = await first.json(); f.state().tasks[0].title = "later edit";
    const second = await f.run(); expect(second.status).toBe(201); expect(await second.json()).toEqual({ ...snapshot, data: { ...snapshot.data, replayed: true } });
    expect(snapshot.data).toEqual({ taskId: "task-1", projectId, version: 0, replayed: false });
    expect(f.state().tasks).toHaveLength(1); expect(f.state().activities).toHaveLength(1); expect(f.state().receipts).toHaveLength(1);
    expect(api.prepare).toHaveBeenCalledOnce(); expect(api.emit).toHaveBeenCalledOnce(); expect(api.automation).toHaveBeenCalledOnce();
    expect(f.tx.activity.create).toHaveBeenCalledWith({ data: { taskId: "task-1", userId: "actor", action: "created" } });
    expect(api.auth.mock.calls[0][0].headers.get("authorization")).toBe("Bearer synthetic-token");
    expect(f.tx.$queryRaw.mock.calls[0][1]).toBe(JSON.stringify(["task-http-operation-v1", operationId]));
    expect(f.trace.indexOf("operation-lock")).toBeLessThan(f.trace.indexOf("authorization"));
    expect(f.trace.indexOf("authorization")).toBeLessThan(f.trace.indexOf("receipt-read"));
    expect(f.trace.slice(0, 6)).toEqual(["operation-lock", "project-lock", "column-lock", "task-lock", "user-lock", "authorization"]);
    expect(f.state().receipts[0].response).toEqual({ taskId: "task-1", projectId, version: 0, replayed: false });
  });
  it.each(["payload", "actor"])("rejects operation reuse by changed %s", async kind => {
    const f = fixture(); expect((await f.run()).status).toBe(201);
    if (kind === "actor") { api.auth.mockResolvedValue({ id: "other", globalRole: "USER" }); f.tx.user.findUnique.mockResolvedValue({ id: "other", globalRole: "USER" }); f.tx.project.findUnique.mockResolvedValue({ ownerId: "other", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{ id: columnId }] }); }
    const conflict = await f.run(kind === "payload" ? { title: "Different" } : {}); expect(conflict.status).toBe(409); expect((await conflict.json()).error.code).toBe("OPERATION_ID_REUSED");
    expect(f.state().tasks).toHaveLength(1); expect(f.state().activities).toHaveLength(1); expect(api.emit).toHaveBeenCalledOnce();
  });
  it.each(["membership", "actor"])("refreshes %s authorization before disclosing a receipt", async kind => {
    const f = fixture(); expect((await f.run()).status).toBe(201); f.tx.taskMoveOperation.findUnique.mockClear();
    if (kind === "membership") f.options.allowed = false; else f.options.actorExists = false;
    expect((await f.run()).status).toBe(404); expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled();
    expect(f.state().tasks).toHaveLength(1); expect(api.prepare).toHaveBeenCalledOnce();
  });
  it.each(["activityFailure", "receiptFailure", "commitFailure"] as const)("rolls back task, Activity and receipt on %s; retry then succeeds once", async failure => {
    const f = fixture(); f.options[failure] = true; const failed = await f.run(); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("synthetic-private");
    expect(f.state()).toEqual({ tasks: [], activities: [], receipts: [] }); expect(api.emit).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled();
    f.options[failure] = false; expect((await f.run()).status).toBe(201); expect(f.state().tasks).toHaveLength(1); expect(f.state().activities).toHaveLength(1); expect(f.state().receipts).toHaveLength(1);
  });
  it("rejects invalid operation ids without beginning a transaction", async () => {
    const f = fixture(); expect((await f.run({ operationId: "invalid" })).status).toBe(422); expect(api.transaction).not.toHaveBeenCalled();
  });
});
