import { describe, expect, it } from "vitest";
import { managerQueueWhere, parseManagerFilters } from "./manager-queues";

const now = new Date("2026-10-22T12:00:00Z");
describe("manager queue filters", () => {
  it("defaults to overdue, with a strict deadline boundary", () => {
    expect(parseManagerFilters({})).toEqual({ queue: "overdue" });
    expect(managerQueueWhere({ queue: "overdue" }, now).AND).toContainEqual({ deadline: { lt: now } });
  });
  it("uses an inclusive start and exclusive seven-day end for upcoming", () => {
    expect(managerQueueWhere({ queue: "upcoming" }, now).AND).toContainEqual({
      deadline: { gte: now, lt: new Date("2026-10-29T12:00:00Z") },
    });
  });
  it("uses the canonical executor for requests and assignees for legacy tasks", () => {
    expect(managerQueueWhere({ queue: "unassigned" }, now).AND).toContainEqual({ OR: [
      { request: { is: null }, assignees: { none: {} } }, { request: { is: { executorId: null } } },
    ] });
  });
  it.each(["overdue", "upcoming", "unassigned", "period"] as const)("ANDs period with %s without overwriting the queue", queue => {
    const where = managerQueueWhere({ queue, from: "2026-10-01", to: "2026-10-22" }, now);
    expect(where.AND).toContainEqual({ deadline: {
      gte: new Date("2026-10-01T00:00:00Z"), lt: new Date("2026-10-23T00:00:00Z"),
    } });
    expect(where.AND).toContainEqual({ OR: [
      { request: { is: null }, status: { notIn: ["DONE", "CANCELLED"] } },
      { request: { is: { contractVersion: 1, deletedAt: null, state: { in: ["SUBMITTED", "IN_PROGRESS"] } } } },
    ] });
  });
  it("accepts leap days and one-sided ranges", () => {
    expect(parseManagerFilters({ queue: "period", from: "2024-02-29" }).from).toBe("2024-02-29");
    expect(managerQueueWhere({ queue: "period", to: "2026-12-31" }, now).AND).toContainEqual({
      deadline: { lt: new Date("2027-01-01T00:00:00Z") },
    });
  });
  it.each([
    { queue: "__proto__" }, { queue: "period" }, { from: "2026-02-29" }, { from: "2026-04-31" },
    { to: "invalid" }, { from: ["2026-10-01"] }, { queue: ["overdue"] },
    { from: "2026-10-23", to: "2026-10-22" },
  ])("rejects invalid query %j", query => {
    expect(() => parseManagerFilters(query)).toThrow();
  });
});
