// Message count privacy has its own real shared-reader contract suite.
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db:unknown,_actor:unknown,ids:string[]) => new Map(ids.map(id=>[id,{total:0,unread:0}])) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
// Admission is covered separately; these fixtures exercise workflow filters.
vi.mock("@/lib/rate-limit", async original => ({
  ...await original<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: async () => {},
}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: mocks.findMany },
    project:{findUnique:vi.fn(async()=>({name:"Synthetic board"}))},
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { GET } from "./route";
import { taskSearchPredicate } from "@/lib/task-search";

describe("GET /api/tasks workflow filters", () => {
  beforeEach(() => {
    mocks.findMany.mockReset().mockResolvedValue([]);
    mocks.requireApiUser.mockReset().mockResolvedValue({
      id: "user-1",
      globalRole: "ADMIN",
    });
  });

  it.each([false, true])("keeps the dynamic column inside ADMIN's mandatory list restriction (search/status=%s)", async search => {
    const response = await GET(
      new Request(
        `http://localhost/api/tasks?projectId=project-1&columnId=column-custom${search ? "&status=IN_REVIEW&search=synthetic" : ""}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    const filters = { projectId: "project-1", columnId: "column-custom", ...(search ? { status: "IN_REVIEW" } : {}) };
    const readableWhere = { AND: [search ? { AND: [filters, taskSearchPredicate("synthetic")] } : filters, { projectId: "project-1" }] };
    const visibleWhere = { AND: [readableWhere, { OR: [
      { request: { is: null } },
      { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } },
    ] }] };
    for (const [index, priority] of [{ in: ["CRITICAL", "URGENT", "HIGH"] }, { notIn: ["CRITICAL", "URGENT", "HIGH"] }].entries()) {
      expect(mocks.findMany.mock.calls[index][0].where).toEqual({ AND: [visibleWhere, { priority }] });
      expect(mocks.findMany.mock.calls[index][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    }
    expect(mocks.findMany.mock.calls[0][0].where.AND[0]).toBe(mocks.findMany.mock.calls[1][0].where.AND[0]);
  });
});
