import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskReadPredicate } from "@/lib/access-policy";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  taskGroupBy: vi.fn(),
  taskCount: vi.fn(),
  assigneeGroupBy: vi.fn(),
  userFindMany: vi.fn(),
  grants: vi.fn(),
  inflight: 0,
  maxInflight: 0,
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
const ownPolicy = taskReadPredicate(actor, ["own"], [], true);

function analyticsRequest(projectId?: string) {
  return new Request(`http://localhost/api/analytics${projectId ? `?projectId=${projectId}` : ""}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own");
  mocks.inflight = 0;
  mocks.maxInflight = 0;
  mocks.requireApiUser.mockResolvedValue(actor);
  mocks.grants.mockResolvedValue([]);
  mocks.taskGroupBy.mockResolvedValue([]);
  mocks.taskCount.mockImplementation(async () => {
    mocks.inflight += 1;
    mocks.maxInflight = Math.max(mocks.maxInflight, mocks.inflight);
    await Promise.resolve();
    mocks.inflight -= 1;
    return 0;
  });
  mocks.assigneeGroupBy.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("analytics aggregation cost and response contract", () => {
  it("runs independent counters concurrently instead of one round trip each", async () => {
    await GET(analyticsRequest());

    // Four velocity weeks and fourteen burndown days are independent; they must
    // overlap rather than wait for each other one by one.
    expect(mocks.maxInflight).toBeGreaterThanOrEqual(14);
  });

  it("derives the total from the status groups instead of a second full count", async () => {
    mocks.taskGroupBy.mockResolvedValueOnce([
      { status: "TODO", _count: { id: 2 } },
      { status: "DONE", _count: { id: 3 } },
    ]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const response = await GET(analyticsRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.summary.totalTasks).toBe(5);

    // No count call may carry the bare visibility predicate: that would be the
    // redundant "total tasks" round trip.
    for (const [query] of mocks.taskCount.mock.calls) {
      expect(query.where).not.toEqual({ AND: [ownPolicy, {}] });
    }
    expect(mocks.taskCount).toHaveBeenCalledTimes(19);
  });

  it("keeps the response shape and every aggregate on the shared read predicate", async () => {
    const response = await GET(analyticsRequest("own"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(Object.keys(body.data).sort()).toEqual(
      ["assigneeWorkload", "burndown", "summary", "tasksByPriority", "tasksByStatus", "velocity"],
    );
    expect(Object.keys(body.data.summary).sort()).toEqual(
      ["completedThisMonth", "overdueTasks", "totalTasks"],
    );
    expect(body.data.velocity).toHaveLength(4);
    expect(body.data.burndown).toHaveLength(14);
    expect(body.data.velocity[0]).toHaveProperty("week", "Week 1");
    expect(body.data.velocity[0]).toHaveProperty("completed");
    expect(body.data.velocity[0]).toHaveProperty("date");
    expect(body.data.burndown[0]).toHaveProperty("date");
    expect(body.data.burndown[0]).toHaveProperty("remaining");
    expect(body.data.burndown[0]).toHaveProperty("ideal");

    for (const [query] of mocks.taskGroupBy.mock.calls) {
      expect(query.where.AND[0]).toEqual(ownPolicy);
    }
    for (const [query] of mocks.taskCount.mock.calls) {
      expect(query.where.AND[0]).toEqual(ownPolicy);
    }
    expect(mocks.assigneeGroupBy.mock.calls[0][0].where.task.AND[0]).toEqual(ownPolicy);
  });
});
