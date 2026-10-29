// Message count privacy has its own real shared-reader contract suite.
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db:unknown,_actor:unknown,ids:string[]) => new Map(ids.map(id=>[id,{total:0,unread:0}])) }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), boards: vi.fn(), grants: vi.fn(), tasks: vi.fn(), urgentCount: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  project: { findMany: mocks.boards, findFirst: mocks.project, findUnique: vi.fn(async()=>({name:"Synthetic board"})) },
  scopedPrivilegeAssignment: { findMany: mocks.grants }, task: { findMany: mocks.tasks, count: mocks.urgentCount },
} }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: mocks.actor,
  UnauthorizedError: (await import("./errors")).UnauthorizedError }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: vi.fn() }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: vi.fn() }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: vi.fn() }));
import { GET as list } from "@/app/api/tasks/route";
import { GET as project } from "@/app/api/projects/[id]/route";
import { taskSearchPredicate } from "./task-search";
import { getTaskReadWhere } from "./project-access";

const actor = { id: "reader", globalRole: "USER" as const };
const listVisibility = { OR: [
  { request: { is: null } },
  { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } },
] };
beforeEach(() => {
  vi.resetAllMocks(); mocks.actor.mockResolvedValue(actor); mocks.tasks.mockResolvedValue([]); mocks.urgentCount.mockResolvedValue(0);
  mocks.grants.mockResolvedValue([]); mocks.boards.mockResolvedValue([{ id: "board" }]);
  mocks.project.mockResolvedValue({ id: "board" });
});
describe("board GET routes pass an explicit narrowing to the real shared reader (mock DB)", () => {
  it("bounds a selected task board, including filtered search", async () => {
    const expected = await getTaskReadWhere(actor, { projectId: "board" }, undefined, { projectId: "board" });
    mocks.boards.mockClear();
    expect((await list(new Request("http://localhost/api/tasks?projectId=board"))).status).toBe(200);
    expect(mocks.boards).toHaveBeenCalledExactlyOnceWith({ where: { id: "board" }, select: { id: true } });
    expect(mocks.tasks).toHaveBeenCalledTimes(2);
    for (const [index, priority] of [{ in: ["CRITICAL", "URGENT", "HIGH"] }, { notIn: ["CRITICAL", "URGENT", "HIGH"] }].entries()) {
      expect(mocks.tasks.mock.calls[index][0].where).toEqual({ AND: [{ AND: [expected, listVisibility] }, { priority }] });
      expect(mocks.tasks.mock.calls[index][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    }
    const expectedSearch = await getTaskReadWhere(actor, { AND: [{ projectId: "board", columnId: "custom", status: "IN_REVIEW" }, taskSearchPredicate("synthetic")] }, undefined, { projectId: "board" });
    mocks.tasks.mockClear();
    mocks.boards.mockClear();
    expect((await list(new Request("http://localhost/api/tasks?projectId=board&columnId=custom&status=IN_REVIEW&search=synthetic"))).status).toBe(200);
    expect(mocks.boards).toHaveBeenCalledExactlyOnceWith({ where: { id: "board" }, select: { id: true } });
    expect(mocks.tasks).toHaveBeenCalledTimes(2);
    for (const [index, priority] of [{ in: ["CRITICAL", "URGENT", "HIGH"] }, { notIn: ["CRITICAL", "URGENT", "HIGH"] }].entries()) expect(mocks.tasks.mock.calls[index][0].where).toEqual({ AND: [{ AND: [expectedSearch, listVisibility] }, { priority }] });
  });
  it("uses the same narrowed reader, column, status and list visibility for the urgent count and paginated rows", async () => {
    const expected = await getTaskReadWhere(actor, { projectId: "board", columnId: "custom", status: "IN_REVIEW" }, undefined, { projectId: "board" });
    mocks.boards.mockClear();
    expect((await list(new Request("http://localhost/api/tasks?projectId=board&columnId=custom&status=IN_REVIEW&page=2&limit=2"))).status).toBe(200);
    expect(mocks.boards).toHaveBeenCalledExactlyOnceWith({ where: { id: "board" }, select: { id: true } });
    expect(mocks.urgentCount).toHaveBeenCalledExactlyOnceWith({ where: {
      AND: [{ AND: [expected, listVisibility] }, { priority: { in: ["CRITICAL", "URGENT", "HIGH"] } }],
    } });
    expect(mocks.tasks).toHaveBeenCalledOnce();
    const rows = mocks.tasks.mock.calls[0][0];
    expect(rows.where).toEqual({ AND: [{ AND: [expected, listVisibility] }, { priority: { notIn: ["CRITICAL", "URGENT", "HIGH"] } }] });
    expect(rows.where.AND[0]).toBe(mocks.urgentCount.mock.calls[0][0].where.AND[0]);
    expect(rows).toMatchObject({ skip: 2, take: 3, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  });
  it.each(["", "?search=synthetic"])("keeps global listing/search unscoped %s", async query => {
    expect((await list(new Request(`http://localhost/api/tasks${query}`))).status).toBe(200);
    expect(mocks.boards).toHaveBeenCalledExactlyOnceWith({ select: { id: true } });
  });
  it("bounds the project GET task count to its route ID", async () => {
    const expected = await getTaskReadWhere(actor, {}, undefined, { projectId: "board" });
    mocks.boards.mockClear();
    expect((await project(new Request("http://localhost/api/projects/board"), { params: Promise.resolve({ id: "board" }) })).status).toBe(200);
    expect(mocks.boards).toHaveBeenCalledExactlyOnceWith({ where: { id: "board" }, select: { id: true } });
    expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({
      _count: { select: { tasks: { where: expected }, members: true } },
    }) }));
    expect(mocks.tasks).not.toHaveBeenCalled();
  });
});
