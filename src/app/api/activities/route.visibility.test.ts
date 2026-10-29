import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskReadPredicate } from "@/lib/access-policy";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  taskFindFirst: vi.fn(),
  activityFindMany: vi.fn(),
  grants: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {
  task: { findFirst: mocks.taskFindFirst },
  activity: { findMany: mocks.activityFindMany },
  scopedPrivilegeAssignment: { findMany: mocks.grants },
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { GET } from "./route";

const actor = { id: "employee", globalRole: "USER" as const };
const ownPolicy = taskReadPredicate(actor, ["own"], [], true);
const historySelection = { id: true, projectId: true, request: { select: {
  taskId: true, contractVersion: true, state: true, authorId: true, executorId: true,
  needsInfoSince: true, pausedTotalMs: true, deletedAt: true,
} } };

function historyRequest(taskId = "foreign-task") {
  return new Request(`http://localhost/api/activities?taskId=${taskId}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own");
  mocks.requireApiUser.mockResolvedValue(actor);
  mocks.grants.mockResolvedValue([]);
  mocks.taskFindFirst.mockResolvedValue(null);
  mocks.activityFindMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("task history read channel", () => {
  it("resolves the task through the shared predicate before reading history", async () => {
    await GET(historyRequest());

    expect(mocks.taskFindFirst).toHaveBeenCalledWith({
      where: { AND: [ownPolicy, { id: "foreign-task" }] },
      select: historySelection,
    });
    expect(mocks.activityFindMany).not.toHaveBeenCalled();
  });

  it("does not disclose a hidden task's history to a project member", async () => {
    const response = await GET(historyRequest());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("foreign-task");
    expect(mocks.activityFindMany).not.toHaveBeenCalled();
  });

  it("returns history only after the predicate matched", async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: "visible-task" });
    const response = await GET(historyRequest("visible-task"));
    expect(response.status).toBe(200);
    expect(mocks.activityFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: "visible-task" } }));
  });

  it("lets a global administrator read history without a per-user predicate", async () => {
    mocks.requireApiUser.mockResolvedValue({ id: "admin", globalRole: "ADMIN" });
    mocks.taskFindFirst.mockResolvedValue(null);
    const response = await GET(historyRequest());
    expect(response.status).toBe(200);
    expect(mocks.taskFindFirst).toHaveBeenCalledWith({ where: { id: "foreign-task" }, select: historySelection });
  });
});
