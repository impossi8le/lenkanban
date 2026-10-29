import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskReadPredicate } from "@/lib/access-policy";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  taskGroupBy: vi.fn(),
  taskCount: vi.fn(),
  assigneeGroupBy: vi.fn(),
  userFindMany: vi.fn(),
  grants: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {
  task: { groupBy: mocks.taskGroupBy, count: mocks.taskCount },
  taskAssignee: { groupBy: mocks.assigneeGroupBy },
  user: { findMany: mocks.userFindMany },
  scopedPrivilegeAssignment: { findMany: mocks.grants },
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { GET } from "./route";

const actor = { id: "employee", globalRole: "USER" as const };
// This injected client has no project.findMany: OWN applies without a board fence.
const ownPolicy = taskReadPredicate(actor, ["own"], [], true);

function analyticsRequest(projectId?: string) {
  return new Request(`http://localhost/api/analytics${projectId ? `?projectId=${projectId}` : ""}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own");
  mocks.requireApiUser.mockResolvedValue(actor);
  mocks.grants.mockResolvedValue([]);
  mocks.taskGroupBy.mockResolvedValue([]);
  mocks.taskCount.mockResolvedValue(0);
  mocks.assigneeGroupBy.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("analytics aggregates use the shared task read predicate", () => {
  it("scopes status, priority and completion groups to visible tasks only", async () => {
    const response = await GET(analyticsRequest());
    expect(response.status).toBe(200);

    expect(mocks.taskGroupBy).toHaveBeenCalledTimes(3);
    for (const [query] of mocks.taskGroupBy.mock.calls) {
      // The completion group adds its own status/window filters, so compare
      // the policy segment that every aggregate must carry.
      expect(query.where.AND[0]).toEqual(ownPolicy);
      expect(query.where.AND[1]).toEqual({});
    }
  });

  it("keeps the predicate when a client supplies a projectId, so a forged board cannot widen counts", async () => {
    const response = await GET(analyticsRequest("own"));
    expect(response.status).toBe(200);

    for (const [query] of mocks.taskGroupBy.mock.calls) {
      expect(query.where.AND[0]).toEqual(ownPolicy);
      expect(query.where.AND[1]).toEqual({ projectId: "own" });
    }
    for (const [query] of mocks.taskCount.mock.calls) {
      expect(query.where.AND).toEqual([ownPolicy, { projectId: "own" }]);
    }
    expect(mocks.assigneeGroupBy.mock.calls[0][0].where.task.AND).toEqual([ownPolicy, { projectId: "own" }]);
  });

  it("applies the predicate to velocity, overdue and burndown counters", async () => {
    await GET(analyticsRequest());

    // Four velocity weeks, one overdue and fourteen burndown days. The total is
    // derived from the status groups, which already carry the same predicate.
    expect(mocks.taskCount).toHaveBeenCalledTimes(19);
    for (const [query] of mocks.taskCount.mock.calls) {
      expect(query.where.AND[0]).toEqual(ownPolicy);
    }
    const burndown = mocks.taskCount.mock.calls.find(([query]) => query.where.OR !== undefined);
    expect(burndown?.[0].where.AND).toEqual([ownPolicy, {}]);
  });

  it("lets a global administrator read every board without a per-user predicate", async () => {
    mocks.requireApiUser.mockResolvedValue({ id: "admin", globalRole: "ADMIN" });
    const response = await GET(analyticsRequest("other"));
    expect(response.status).toBe(200);
    for (const [query] of mocks.taskGroupBy.mock.calls) {
      // A global administrator reads every board: no per-user predicate remains.
      expect(query.where.projectId).toBe("other");
      expect(query.where.AND).toBeUndefined();
    }
  });
});
