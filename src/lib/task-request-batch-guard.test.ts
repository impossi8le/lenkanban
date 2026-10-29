import { describe, expect, it, vi } from "vitest";
import { readTaskRequestBatchDecision, TASK_REQUEST_GUARD_BATCH_SIZE } from "./task-request-guard";

type Database = Parameters<typeof readTaskRequestBatchDecision>[0];
type Query = { where: { taskId: { in: string[] } }; select: Record<string, boolean>; orderBy: { taskId: "asc" } };
const legacy = { allowed: true, mode: "legacy" };
const invalid = { allowed: false, code: "INVALID_REQUEST_MARKER" };
const marked = { allowed: false, code: "REQUEST_LIFECYCLE_NOT_ENABLED" };
const projection = { taskId: true, contractVersion: true, state: true, authorId: true, executorId: true };
function marker(taskId = "task-one", state = "DRAFT", executorId: string | null = null) {
  return { taskId, contractVersion: 1, state, authorId: "author-one", executorId };
}
function database(...results: unknown[]) {
  const result = results.length ? results[0] : [];
  const findMany = vi.fn<(query: Query) => Promise<unknown>>().mockResolvedValue(result);
  const write = vi.fn(() => { throw new Error("GUARD_MUST_NOT_WRITE"); });
  const openTransaction = vi.fn(() => { throw new Error("GUARD_MUST_NOT_OPEN_TRANSACTION"); });
  const value = { taskRequest: { findMany, create: write, update: write, delete: write },
    task: { update: write, updateMany: write }, activity: { create: write }, $transaction: openTransaction };
  return { findMany, write, openTransaction, value: value as unknown as Database };
}

describe("batch marker guard on the actual locked write set", () => {
  it("an empty write set is legacy without querying, locking or writing", async () => {
    const db = database();
    await expect(readTaskRequestBatchDecision(db.value, [])).resolves.toEqual(legacy);
    expect(db.findMany).not.toHaveBeenCalled(); expect(db.write).not.toHaveBeenCalled(); expect(db.openTransaction).not.toHaveBeenCalled();
  });
  it("empty actual DB rows preserve legacy for custom/non-ASCII/long IDs instead of inventing invalid markers", async () => {
    const ids = Object.freeze(["legacy/with.dot", "кириллица", "x".repeat(129), "", "task\n"]);
    const db = database();
    await expect(readTaskRequestBatchDecision(db.value, ids)).resolves.toEqual(legacy);
    expect(db.findMany).toHaveBeenCalledExactlyOnceWith({ where: { taskId: { in: [...ids] } }, select: projection, orderBy: { taskId: "asc" } });
    expect(db.write).not.toHaveBeenCalled();
  });
  it("deduplicates requested IDs stably without modifying the frozen input", async () => {
    const ids = Object.freeze(["b", "a", "b", "c", "a"]); const db = database();
    await expect(readTaskRequestBatchDecision(db.value, ids)).resolves.toEqual(legacy);
    expect(db.findMany.mock.calls[0][0].where.taskId.in).toEqual(["b", "a", "c"]);
    expect(ids).toEqual(["b", "a", "b", "c", "a"]);
  });
  it("uses bounded chunks with no N+1 or arbitrary 10000-row board limit", async () => {
    const ids = Object.freeze(Array.from({ length: 10001 }, (_, index) => `task-${index}`)), db = database();
    await expect(readTaskRequestBatchDecision(db.value, ids)).resolves.toEqual(legacy);
    expect(TASK_REQUEST_GUARD_BATCH_SIZE).toBe(200);
    expect(db.findMany).toHaveBeenCalledTimes(Math.ceil(ids.length / TASK_REQUEST_GUARD_BATCH_SIZE));
    const actual: string[] = [];
    for (const [query] of db.findMany.mock.calls) {
      expect(query.where.taskId.in.length).toBeGreaterThan(0);
      expect(query.where.taskId.in.length).toBeLessThanOrEqual(TASK_REQUEST_GUARD_BATCH_SIZE);
      expect(query.select).toEqual(projection); expect(query.orderBy).toEqual({ taskId: "asc" });
      actual.push(...query.where.taskId.in);
    }
    expect(actual).toEqual(ids); expect(db.write).not.toHaveBeenCalled(); expect(db.openTransaction).not.toHaveBeenCalled();
  });
  it.each([
    ["DRAFT", null], ["SUBMITTED", null], ["IN_PROGRESS", "executor-one"],
    ["NEEDS_INFO", "executor-one"], ["COMPLETED", "executor-one"],
    ["CANCELLED", null], ["CANCELLED", "executor-one"],
  ] as const)("denies any valid %s marker without leaking the row or performing writes", async (state, executorId) => {
    const db = database([marker("task-one", state, executorId)]);
    await expect(readTaskRequestBatchDecision(db.value, ["task-one", "unmarked-other"])).resolves.toEqual(marked);
    expect(db.write).not.toHaveBeenCalled(); expect(db.openTransaction).not.toHaveBeenCalled();
  });
  it.each([
    { ...marker(), contractVersion: 2 }, { ...marker(), contractVersion: undefined },
    { ...marker(), state: "TODO" }, { ...marker(), state: "IN_PROGRESS" },
    marker("task-one", "DRAFT", "executor-one"), { ...marker(), authorId: "" },
    { ...marker(), globalRole: "ADMIN" }, { ...marker(), title: "PRIVATE_CONTENT" },
    { ...marker(), executorId: ["executor-one"] }, { ...marker(), permissions: ["request.read"] },
  ])("rejects malformed/unknown-version/metadata-bearing returned rows: %j", async row => {
    const db = database([row]);
    await expect(readTaskRequestBatchDecision(db.value, ["task-one"])).resolves.toEqual(invalid);
    expect(db.write).not.toHaveBeenCalled();
  });
  it.each([undefined, null, false, 0, "[]", {}, { items: [] }])("does not treat non-array result %s as marker absence", async result => {
    const db = database(result);
    await expect(readTaskRequestBatchDecision(db.value, ["task-one"])).resolves.toEqual(invalid);
  });
  it.each([undefined, null, false, 1, {}, [], "PRIVATE_CONTENT"])("does not treat invalid array entry %s as marker absence", async result => {
    const db = database([result]);
    await expect(readTaskRequestBatchDecision(db.value, ["task-one"])).resolves.toEqual(invalid);
  });
  it("rejects a valid returned marker outside the requested write set", async () => {
    const db = database([marker("unexpected-task")]);
    await expect(readTaskRequestBatchDecision(db.value, ["task-one"])).resolves.toEqual(invalid);
  });
  it("rejects a row from another chunk even when it belongs to the full outer write set", async () => {
    const ids = Array.from({ length: TASK_REQUEST_GUARD_BATCH_SIZE + 1 }, (_, index) => `task-${index}`);
    const db = database(); db.findMany.mockResolvedValueOnce([marker(ids.at(-1)!)]);
    await expect(readTaskRequestBatchDecision(db.value, ids)).resolves.toEqual(invalid);
    expect(db.write).not.toHaveBeenCalled();
  });
  it("rejects duplicate returned rows instead of reducing them to a single valid marker", async () => {
    const row = marker(); const db = database([row, { ...row }]);
    await expect(readTaskRequestBatchDecision(db.value, ["task-one", "unmarked-other"])).resolves.toEqual(invalid);
  });
  it("continues after a valid marked chunk so a later malformed row takes the closed invalid precedence", async () => {
    const ids = Array.from({ length: TASK_REQUEST_GUARD_BATCH_SIZE * 2 + 1 }, (_, index) => `task-${index}`);
    const db = database(); db.findMany.mockResolvedValueOnce([marker(ids[0])]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...marker(ids.at(-1)!), state: "UNKNOWN" }]);
    await expect(readTaskRequestBatchDecision(db.value, ids)).resolves.toEqual(invalid);
    expect(db.findMany).toHaveBeenCalledTimes(3); expect(db.write).not.toHaveBeenCalled();
  });
  it("does not swallow storage failure after a marked result into a successful denial or legacy fallback", async () => {
    const ids = Array.from({ length: TASK_REQUEST_GUARD_BATCH_SIZE + 1 }, (_, index) => `task-${index}`);
    const failure = new Error("SYNTHETIC_STORAGE_FAILURE"); const db = database();
    db.findMany.mockResolvedValueOnce([marker(ids[0])]).mockRejectedValueOnce(failure);
    await expect(readTaskRequestBatchDecision(db.value, ids)).rejects.toBe(failure);
    expect(db.write).not.toHaveBeenCalled();
  });
  it("never opens its own transaction and propagates a query exception without legacy fallback", async () => {
    const failure = new Error("SYNTHETIC_STORAGE_FAILURE"); const db = database(); db.findMany.mockRejectedValueOnce(failure);
    await expect(readTaskRequestBatchDecision(db.value, ["task-one"])).rejects.toBe(failure);
    expect(db.openTransaction).not.toHaveBeenCalled(); expect(db.write).not.toHaveBeenCalled();
  });
  it.each([{}, { taskRequest: {} }])("missing delegate/method is a failure rather than absence: %j", async value => {
    await expect(readTaskRequestBatchDecision(value as Database, ["task-one"])).rejects.toThrow();
  });
  it("rejects an own accessor taskId without invoking its getter", async () => {
    const getter = vi.fn(() => { throw new Error("PRIVATE_MARKER_CONTENT"); }); const row = marker();
    Object.defineProperty(row, "taskId", { get: getter, enumerable: true });
    const db = database([row]); await expect(readTaskRequestBatchDecision(db.value, ["task-one"])).resolves.toEqual(invalid);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects a throwing descriptor proxy without leaking its exception or marker data", async () => {
    const row = new Proxy(marker(), { getOwnPropertyDescriptor() { throw new Error("PRIVATE_MARKER_CONTENT"); } });
    const db = database([row]); await expect(readTaskRequestBatchDecision(db.value, ["task-one"])).resolves.toEqual(invalid);
  });
  it("does not mutate frozen returned rows", async () => {
    const row = Object.freeze(marker()), rows = Object.freeze([row]), db = database(rows);
    await expect(readTaskRequestBatchDecision(db.value, Object.freeze(["task-one"]))).resolves.toEqual(marked);
    expect(rows).toEqual([marker()]); expect(row).toEqual(marker());
  });
});
