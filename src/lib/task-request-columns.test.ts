import { describe, expect, it } from "vitest";
import { decodeLifecycleColumnMap, lifecycleColumnId, validateLifecycleColumnTargets } from "./task-request-columns";

const map = { contractVersion: 1 as const, submittedColumnId: "new", inProgressColumnId: "work", needsInfoColumnId: "wait", completedColumnId: "resolved", closedColumnId: "closed" };
const keys: Record<string, string> = { closed: "DONE", resolved: "REVIEW", wait: "CUSTOM", new: "TODO", work: "IN_PROGRESS" };
const columns = ["closed", "resolved", "wait", "new", "work"].map(id => ({ id, projectId: "board", workflowKey: keys[id], name: "Unrelated renamed label", position: 999 }));
describe("explicit lifecycle columns", () => {
  it("uses exact IDs despite arbitrary names, order and custom workflow keys", () => {
    const decoded = decodeLifecycleColumnMap(map)!;
    validateLifecycleColumnTargets(decoded, columns, "board");
    expect(lifecycleColumnId(decoded, "NEEDS_INFO")).toBe("wait");
    expect(lifecycleColumnId(decoded, "COMPLETED")).toBe("resolved");
    expect(lifecycleColumnId(decoded, "CANCELLED")).toBeNull();
    expect(decodeLifecycleColumnMap(null)).toBeNull();
  });
  it.each([undefined, {}, { ...map, unexpected: "secret" }, { ...map, contractVersion: 2 }, { ...map, needsInfoColumnId: "work" }, { ...map, closedColumnId: "" }])("fails closed on malformed persisted or proposed mapping %#", value => {
    expect(() => decodeLifecycleColumnMap(value)).toThrow();
  });
  it("rejects missing, foreign and duplicate targets and prevents completion into DONE", () => {
    for (const rows of [columns.slice(1), columns.map(row => ({ ...row, projectId: "other" })), [...columns, columns[0]], columns.map(row => row.id === "resolved" ? { ...row, workflowKey: "DONE" } : row)]) {
      expect(() => validateLifecycleColumnTargets(map, rows, "board")).toThrow();
    }
  });
  it.each(["new", "work", "resolved", "closed"])("rejects a noncanonical semantic workflow key on %s without rewriting it", id => {
    const rows = columns.map(column => column.id === id ? { ...column, workflowKey: "COLUMN_arbitrary" } : column);
    expect(() => validateLifecycleColumnTargets(map, rows, "board")).toThrow();
    expect(rows.find(column => column.id === id)?.workflowKey).toBe("COLUMN_arbitrary");
  });
});
