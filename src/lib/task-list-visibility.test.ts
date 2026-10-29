import { describe, expect, it } from "vitest";
import { isTaskVisibleInRequestList, taskListVisibilityWhere } from "./task-list-visibility";
// Small fail-closed query double: this is not real PostgreSQL verification.
function matches(row: unknown, predicate: unknown): boolean {
  if (predicate === null || typeof predicate !== "object") return row === predicate;
  return Object.entries(predicate).every(([key, value]) => {
    if (key === "OR") return (value as unknown[]).some(child => matches(row, child));
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "not") return !matches(row, value);
    if (row === null || typeof row !== "object" || !(key in row)) throw new Error("Unsupported field");
    return matches((row as Record<string, unknown>)[key], value);
  });
}

describe("request list visibility without changing direct-read ACL", () => {
  it("narrows lists to legacy or non-draft/nondeleted canonical rows", () => {
    const where = taskListVisibilityWhere();
    expect(matches({ request: null }, where)).toBe(true);
    for (const state of ["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED", "CANCELLED"]) {
      expect(matches({ request: { contractVersion: 1, state, deletedAt: null } }, where)).toBe(true);
    }
    expect(matches({ request: { contractVersion: 1, state: "DRAFT", deletedAt: null } }, where)).toBe(false);
    expect(matches({ request: { contractVersion: 1, state: "SUBMITTED", deletedAt: new Date() } }, where)).toBe(false);
    expect(matches({ request: { contractVersion: 2, state: "SUBMITTED", deletedAt: null } }, where)).toBe(false);
  });

  it("requires a hydrated marker before accepting realtime rows as list entries", () => {
    expect(isTaskVisibleInRequestList({})).toBe(false);
    expect(isTaskVisibleInRequestList({ request: null })).toBe(true);
    expect(isTaskVisibleInRequestList({ request: {} })).toBe(false);
    expect(isTaskVisibleInRequestList({ request: { state: "DRAFT" } })).toBe(false);
    expect(isTaskVisibleInRequestList({ request: { state: "SUBMITTED" } })).toBe(true);
    expect(isTaskVisibleInRequestList({ request: { state: "SUBMITTED", deletedAt: "removed" } })).toBe(false);
  });
});
