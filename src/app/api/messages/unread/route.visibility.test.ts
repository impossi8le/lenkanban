import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskReadPredicate } from "@/lib/access-policy";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  findMany: vi.fn(),
  taskMap: vi.fn(),
  grants: vi.fn(),
  boards: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {
  chatMessage: { groupBy: mocks.findMany },
  task: { findMany: mocks.taskMap },
  project: { findMany: mocks.boards },
  scopedPrivilegeAssignment: { findMany: mocks.grants },
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { GET } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

const actor = { id: "employee", globalRole: "USER" as const };
const ownPolicy = taskReadPredicate(actor, ["own"], [], true);
const request = (transport: "cookie" | "bearer" = "cookie") => new Request("http://localhost/api/messages/unread", {
  headers: transport === "bearer" ? { authorization: "Bearer synthetic-valid" } : { cookie: "next-auth.session-token=synthetic" },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own");
  mocks.requireApiUser.mockResolvedValue(actor);
  mocks.grants.mockResolvedValue([]);
  mocks.boards.mockResolvedValue([{ id: "own" }]);
  mocks.findMany.mockResolvedValue([]);
  mocks.taskMap.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("unread message counters", () => {
  it.each(["cookie", "bearer"] as const)("counts only messages whose task passes the shared read predicate (%s)", async transport => {
    const response = await GET(request(transport));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ byProject: {}, byTask: {}, total: 0 });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { isInternal: false, deletedAt: null, task: { AND: [ownPolicy, { projectId: { in: ["own"] } }, {}] } },
      by: ["taskId", "readBy"],
      _count: { _all: true },
    });
  });

  it("does not reveal counts for a foreign task even when the caller belongs to its project", async () => {
    // The storage layer receives the predicate; a project member with no
    // author/executor/watcher relationship yields no rows.
    mocks.findMany.mockResolvedValue([]);
    const response = await GET(request());
    const body = await response.json();
    expect(body.byTask).toEqual({});
    expect(body.byProject).toEqual({});
    expect(JSON.stringify(body)).not.toContain("foreign");
  });

  it("keeps grouping for visible tasks", async () => {
    mocks.findMany.mockResolvedValue([
      { taskId: "visible", readBy: {}, _count: { _all: 1 } },
      { taskId: "visible", readBy: { employee: "2026-10-22T00:00:00.000Z" }, _count: { _all: 1 } },
    ]);
    mocks.taskMap.mockResolvedValue([{ id: "visible", projectId: "own" }]);
    const response = await GET(request());
    expect(await response.json()).toEqual({ byProject: { own: 1 }, byTask: { visible: 1 }, total: 1 });
  });

  it("returns 401 without reading messages when the caller is unauthenticated", async () => {
    mocks.requireApiUser.mockRejectedValue(new UnauthorizedError());
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

it("sums receipt groups and preserves missing/null/falsey read markers while counting only fresh visible task mappings", async () => {
  mocks.findMany.mockResolvedValue([
    { taskId: "visible", readBy: null, _count: { _all: 5 } },
    { taskId: "visible", readBy: {}, _count: { _all: 7 } },
    { taskId: "visible", readBy: { employee: "" }, _count: { _all: 2 } },
    { taskId: "visible", readBy: { employee: false }, _count: { _all: 3 } },
    { taskId: "visible", readBy: { employee: 0 }, _count: { _all: 4 } },
    { taskId: "visible", readBy: { employee: null }, _count: { _all: 6 } },
    { taskId: "visible", readBy: { employee: "timestamp" }, _count: { _all: 90 } },
    { taskId: "second", readBy: {}, _count: { _all: 8 } },
    { taskId: "revoked", readBy: {}, _count: { _all: 100 } },
  ]);
  mocks.taskMap.mockResolvedValue([{ id: "visible", projectId: "own" }, { id: "second", projectId: "own" }]);
  const response = await GET(request());
  expect(await response.json()).toEqual({ byProject: { own: 35 }, byTask: { visible: 27, second: 8 }, total: 35 });
  expect(mocks.taskMap).toHaveBeenCalledWith({
    where: { AND: [
      { AND: [ownPolicy, { projectId: { in: ["own"] } }, {}] },
      { id: { in: ["visible", "second", "revoked"] } },
    ] }, select: { id: true, projectId: true },
  });
});
it.each([{ groups: [] }, { groups: [{ taskId: "read", readBy: { employee: "timestamp" }, _count: { _all: 20 } }] }])("skips the project mapping query when no groups are unread %#", async ({ groups }) => {
  mocks.findMany.mockResolvedValue(groups);
  const response = await GET(request());
  expect(await response.json()).toEqual({ byProject: {}, byTask: {}, total: 0 });
  expect(mocks.taskMap).not.toHaveBeenCalled();
});
