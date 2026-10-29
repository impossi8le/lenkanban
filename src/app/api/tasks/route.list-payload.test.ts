// Message count privacy has its own real shared-reader contract suite.
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db:unknown,_actor:unknown,ids:string[]) => new Map(ids.map(id=>[id,{total:0,unread:0}])) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: async (_db: unknown, _actor: string, ids: string[]) => new Map(ids.map(id => [id, null])) }));
// Admission is covered separately; these fixtures exercise list payload only.
vi.mock("@/lib/rate-limit", async original => ({
  ...await original<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: async () => {},
}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  urgentCount: vi.fn(),
  queryRaw: vi.fn(),
  groupBy: vi.fn(),
  requireApiUser: vi.fn(),
  userFindMany: vi.fn(),
  projectFindUnique: vi.fn(),
  privilegeFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: mocks.findMany, count: mocks.urgentCount },
    taskChecklistItem: { groupBy: mocks.groupBy },
    user: { findMany: mocks.userFindMany },
    project: { findUnique: mocks.projectFindUnique },
    scopedPrivilegeAssignment: { findMany: mocks.privilegeFindMany },
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { GET } from "./route";
import { TASK_LIST_DEFAULT_LIMIT, TASK_LIST_MAX_LIMIT, TASK_SEARCH_LIMIT } from "@/lib/task-list-limits";

function row(index: number) {
  return {
    id: `task-${index}`,
    title: `Synthetic ${index}`,
    projectId: "project-1",
    columnId: "column-1",
    _count: { messages: 1, checklistItems: 3 },
  };
}

async function list(query = "") {
  const response = await GET(new Request(`http://localhost/api/tasks${query}`));
  return { response, body: await response.json() };
}

describe("GET /api/tasks list payload", () => {
  beforeEach(() => {
    mocks.findMany.mockReset().mockResolvedValue([]);
    mocks.urgentCount.mockReset().mockResolvedValue(10000);
    mocks.queryRaw.mockReset().mockResolvedValue([]);
    mocks.groupBy.mockReset().mockResolvedValue([]);
    mocks.userFindMany.mockReset().mockResolvedValue([]);
    mocks.projectFindUnique.mockReset().mockResolvedValue(null);
    mocks.privilegeFindMany.mockReset().mockResolvedValue([]);
    mocks.requireApiUser.mockReset().mockResolvedValue({
      id: "user-1",
      globalRole: "ADMIN",
    });
  });

  it("bounds an unbounded request with the default limit and asks for one sentinel row", async () => {
    mocks.findMany.mockResolvedValueOnce(
      Array.from({ length: TASK_LIST_DEFAULT_LIMIT + 1 }, (_, index) => row(index)),
    );

    const { response, body } = await list("?projectId=project-1");

    expect(response.status).toBe(200);
    expect(mocks.findMany.mock.calls[0][0]).toMatchObject({
      skip: 0,
      take: TASK_LIST_DEFAULT_LIMIT + 1,
    });
    expect(body.data).toHaveLength(TASK_LIST_DEFAULT_LIMIT);
    expect(body.meta).toMatchObject({
      page: 1,
      limit: TASK_LIST_DEFAULT_LIMIT,
      hasMore: true,
    });
  });

  it("never returns more rows than the hard ceiling", async () => {
    mocks.findMany.mockResolvedValue([]);

    const { body } = await list("?limit=100000");

    expect(mocks.findMany.mock.calls[0][0].take).toBe(TASK_LIST_MAX_LIMIT + 1);
    expect(body.meta.limit).toBe(TASK_LIST_MAX_LIMIT);
  });

  it("keeps client pagination and the fixed search page", async () => {
    mocks.findMany.mockResolvedValue([]);

    await list("?limit=25&page=3");
    expect(mocks.findMany.mock.calls[0][0]).toMatchObject({ skip: 50, take: 26 });

    const beforeSearch = mocks.findMany.mock.calls.length;
    await list("?search=synthetic&limit=25");
    expect(mocks.findMany.mock.calls[beforeSearch][0]).toMatchObject({
      skip: 0,
      take: TASK_SEARCH_LIMIT + 1,
    });
  });

  it("does not select checklist item rows and only aggregates their count", async () => {
    mocks.findMany.mockResolvedValueOnce([row(1)]);

    await list("?projectId=project-1");

    const include = mocks.findMany.mock.calls[0][0].include;
    expect(include).not.toHaveProperty("checklistItems");
    expect(include._count.select).toEqual({ messages: true, checklistItems: true });
    // Tags only need id/name/color; the whole tag row was unnecessary weight.
    expect(include.tags.select.tag.select).toEqual({
      id: true,
      name: true,
      color: true,
    });
  });

  it("returns checklist progress as an aggregate instead of item rows", async () => {
    mocks.findMany.mockResolvedValueOnce([row(1), row(2)]);
    mocks.groupBy.mockResolvedValue([{ taskId: "task-1", _count: { _all: 2 } }]);

    const { body } = await list("?projectId=project-1");

    expect(body.data[0]).not.toHaveProperty("checklistItems");
    expect(body.data[0].checklist).toEqual({ total: 3, completed: 2 });
    expect(body.data[1].checklist).toEqual({ total: 3, completed: 0 });
    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ["taskId"],
      where: { taskId: { in: ["task-1", "task-2"] }, completed: true },
      _count: { _all: true },
    });
  });

  it("removes inherited internal file metadata from the list for an unauthorized reader", async () => {
    const attachment = {
      url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000001",
      name: "public.txt", size: 6, mime: "text/plain",
    };
    const internal = { ...attachment, url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000002", name: "internal.txt", isInternal: true };
    mocks.findMany.mockResolvedValueOnce([{ ...row(1), attachments: [attachment, internal] }]);
    mocks.requireApiUser.mockResolvedValue({ id: "reader", globalRole: "USER" });
    mocks.projectFindUnique.mockResolvedValue({
      id: "project-1", departmentId: null, department: null,
      responsibleGroupId: "group",
      responsibleGroup: { id: "group", archivedAt: null, members: [{ userId: "someone-else" }] },
    });

    const { body } = await list("?projectId=project-1");

    expect(body.data[0].attachments).toEqual([attachment]);
    expect(JSON.stringify(body)).not.toContain("internal.txt");
    expect(JSON.stringify(body)).not.toContain("isInternal");
  });

  it("retains the internal file for an authorized internal reader without exposing the flag", async () => {
    const attachment = {
      url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000001",
      name: "public.txt", size: 6, mime: "text/plain",
    };
    const internal = { ...attachment, url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000002", name: "internal.txt", isInternal: true };
    mocks.findMany.mockResolvedValueOnce([{ ...row(1), attachments: [attachment, internal] }]);
    mocks.requireApiUser.mockResolvedValue({ id: "reader", globalRole: "USER" });
    mocks.projectFindUnique.mockResolvedValue({
      id: "project-1", departmentId: null, department: null,
      responsibleGroupId: "group",
      responsibleGroup: { id: "group", archivedAt: null, members: [{ userId: "reader" }] },
    });

    const { body } = await list("?projectId=project-1");

    const internalDto = { url: internal.url, name: internal.name, size: internal.size, mime: internal.mime };
    expect(body.data[0].attachments).toEqual([attachment, internalDto]);
    expect(body.data[0].attachments[1]).not.toHaveProperty("isInternal");
  });
});
