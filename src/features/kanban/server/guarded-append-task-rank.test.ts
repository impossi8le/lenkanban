import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createBase36RankService } from "../rank/rank-service";
import { allocateAppendRank, createGuardedAppendTaskRankPort, TaskRankMaintenanceError } from "./append-task-rank";

const ranks = createBase36RankService();
const exhausted = "0|ZZZZZZZZZZZZZZZZZZZY";
function fixture(ids = ["task-b", "task-a"]) {
  const trace: string[] = [];
  const rows = ids.map(id => ({ id, rank: exhausted }));
  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (/FROM "Task"/.test(sql)) { trace.push("task-lock"); return ids.toSorted().map(id => ({ id })); }
    if (/FROM "ProjectColumn"/.test(sql)) { trace.push(/FOR UPDATE/.test(sql) ? "column-lock" : "column-identity"); return [{ id: "column", projectId: "project" }]; }
    trace.push("project-lock"); return [{ id: "project" }];
  });
  const findFirst = vi.fn(async () => { trace.push("last-rank"); return { rank: exhausted }; });
  const findMany = vi.fn(async () => { trace.push("actual-set"); return rows.map(({ id }) => ({ id })); });
  const markerQuery = vi.fn(async (input: { where: { taskId: { in: string[] } } }) => { void input; trace.push("marker"); return [] as unknown[]; });
  const update = vi.fn(async (input: { where: { id: string }; data: { rank: string } }) => {
    trace.push(input.data.rank.startsWith("~") ? "temporary-write" : "final-write");
    rows.find(row => row.id === input.where.id)!.rank = input.data.rank;
    return input;
  });
  const client = { $queryRaw: queryRaw, task: { findFirst, findMany, update }, taskRequest: { findMany: markerQuery } };
  const run = () => allocateAppendRank({ columnId: "column", ranks, port: createGuardedAppendTaskRankPort(client as unknown as Prisma.TransactionClient, ranks) });
  return { client, run, trace, rows, queryRaw, findFirst, findMany, markerQuery, update };
}
const marker = (taskId: string) => ({ taskId, contractVersion: 1, state: "DRAFT", authorId: "author", executorId: null });

describe("guarded generic append maintenance", () => {
  it("ordinary append leaves even a marked sibling untouched and does not acquire Task locks or inspect markers", async () => {
    const f = fixture(); f.findFirst.mockImplementation(async () => { f.trace.push("last-rank"); return { rank: "0|HZZZZZZZZZZZZZZZZZZZ" }; });
    f.markerQuery.mockResolvedValue([marker("task-a")]);
    await expect(f.run()).resolves.toBe("0|QZZZZZZZZZZZZZZZZZZZ");
    expect(f.trace).toEqual(["column-identity", "project-lock", "column-lock", "last-rank"]);
    expect(f.findMany).not.toHaveBeenCalled(); expect(f.markerQuery).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it("uses the real rank engine, actual rank order and two-phase writes only after locks and policy", async () => {
    const f = fixture(); const expected = ranks.rebalance(f.rows.map(row => row.id));
    const result = await f.run();
    expect(result).toBe(ranks.between(expected.get("task-a")!, null));
    expect(f.rows.map(row => row.rank)).toEqual([expected.get("task-b"), expected.get("task-a")]);
    expect(f.trace).toEqual(["column-identity", "project-lock", "column-lock", "last-rank", "task-lock", "actual-set", "marker", "temporary-write", "temporary-write", "final-write", "final-write"]);
    expect(f.queryRaw.mock.calls.find(([sql]) => /FROM "Task"/.test(sql.join("?")))![0].join("?")).toMatch(/ORDER BY "id"\s+FOR UPDATE/);
    expect(f.findMany).toHaveBeenCalledWith({ where: { columnId: "column" }, orderBy: { rank: "asc" }, select: { id: true } });
  });
  it.each([{ ids: [] }, { ids: ["история", "a".repeat(129), "legacy/odd.id"] }])("preserves absent-marker legacy semantics for actual IDs $ids", async ({ ids }) => {
    const f = fixture(ids); await expect(f.run()).resolves.toEqual(expect.any(String));
    expect(f.update).toHaveBeenCalledTimes(ids.length * 2);
    expect(f.markerQuery).toHaveBeenCalledTimes(ids.length ? 1 : 0);
  });
  it("delegates 401 actual siblings to bounded batch queries before any writes", async () => {
    const ids = Array.from({ length: 401 }, (_, index) => `task-${index}`); const f = fixture(ids);
    await f.run();
    expect(f.markerQuery.mock.calls.map(([query]) => query.where.taskId.in.length)).toEqual([200, 200, 1]);
    expect(f.markerQuery.mock.calls.flatMap(([query]) => query.where.taskId.in)).toEqual(ids);
    expect(f.trace.lastIndexOf("marker")).toBeLessThan(f.trace.indexOf("temporary-write"));
    expect(f.update).toHaveBeenCalledTimes(802);
  });
  it.each(["marked", "malformed"] as const)("denies a %s sibling with a closed content-free error before any temporary write", async kind => {
    const f = fixture(); f.markerQuery.mockResolvedValue([{ ...marker("task-a"), ...(kind === "malformed" ? { contractVersion: 99, secret: "PRIVATE_CONTENT" } : {}) }]);
    const error = await f.run().catch(value => value);
    expect(error).toBeInstanceOf(TaskRankMaintenanceError);
    expect(error.code).toBe(kind === "marked" ? "REQUEST_LIFECYCLE_NOT_ENABLED" : "INVALID_REQUEST_MARKER");
    expect(String(error)).not.toMatch(/PRIVATE_CONTENT|author|task-a/); expect(f.update).not.toHaveBeenCalled();
  });
  it("checks a late chunk before the first write", async () => {
    const f = fixture(Array.from({ length: 401 }, (_, index) => `task-${index}`));
    f.markerQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([marker("task-400")]);
    await expect(f.run()).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); expect(f.update).not.toHaveBeenCalled();
  });
  it("rejects an actual write ID outside the held set before marker queries or writes", async () => {
    const f = fixture(); f.findMany.mockResolvedValue([{ id: "unlocked-task" }]);
    await expect(f.run()).rejects.toThrow(); expect(f.markerQuery).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it("passes only the validated locked IDs to the engine when a database row changes during marker lookup", async () => {
    const f = fixture(); const actual = [{ id: "task-b" }, { id: "task-a" }];
    f.findMany.mockResolvedValue(actual);
    f.markerQuery.mockImplementation(async () => { actual[0].id = "unguarded-id"; return []; });
    await f.run();
    expect(f.update.mock.calls.map(([input]) => input.where.id)).toEqual(["task-b", "task-a", "task-b", "task-a"]);
    expect(f.markerQuery.mock.calls[0][0].where.taskId.in).toEqual(["task-b", "task-a"]);
  });
  it.each([undefined, null, {}, [{ id: "task-a" }, { id: "task-a" }], [{ id: 42 }]].map(value => ({ value })))("rejects invalid actual write sets $value before markers or writes", async ({ value }) => {
    const f = fixture(); f.findMany.mockResolvedValue(value as never);
    await expect(f.run()).rejects.toThrow(); expect(f.markerQuery).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it("rejects an invalid locked set before reading the actual set", async () => {
    const f = fixture(); f.queryRaw.mockImplementation(async strings => /FROM "Task"/.test(strings.join("?")) ? undefined as never : [{ id: "column", projectId: "project" }]);
    await expect(f.run()).rejects.toThrow(); expect(f.findMany).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  });
  it.each(["task-lock", "actual-set", "marker-query"] as const)("propagates %s storage failures without writes", async stage => {
    const f = fixture(); const error = new Error("STORAGE_SENTINEL");
    if (stage === "task-lock") f.queryRaw.mockImplementation(async strings => { if (/FROM "Task"/.test(strings.join("?"))) throw error; return [{ id: "column", projectId: "project" }]; });
    if (stage === "actual-set") f.findMany.mockRejectedValue(error);
    if (stage === "marker-query") f.markerQuery.mockRejectedValue(error);
    await expect(f.run()).rejects.toBe(error); expect(f.update).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, "rows"])("rejects malformed marker query result %j without writes", async value => {
    const f = fixture(); f.markerQuery.mockResolvedValue(value as never);
    await expect(f.run()).rejects.toMatchObject({ code: "INVALID_REQUEST_MARKER" }); expect(f.update).not.toHaveBeenCalled();
  });
  it("does not treat a missing transaction marker delegate as absent rows", async () => {
    const f = fixture(); Reflect.deleteProperty(f.client, "taskRequest");
    await expect(f.run()).rejects.toThrow(); expect(f.update).not.toHaveBeenCalled();
  });
});
