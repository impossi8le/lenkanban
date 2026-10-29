import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db: unknown, _actor: unknown, ids: readonly string[]) => new Map(ids.map(id => [id, { total: 0, unread: 0 }])) }));
const stub = vi.hoisted(() => ({ tasks: vi.fn(), project: vi.fn(), page: vi.fn(), where: vi.fn(), urgentCount: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findMany: stub.tasks, count: stub.urgentCount }, project: { findUnique: stub.project }, $queryRaw: async () => [], taskChecklistItem: { groupBy: async () => [] } } }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: async () => ({ id: "reader", globalRole: "USER" }), UnauthorizedError: class extends Error {} }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: stub.where }));
vi.mock("@/lib/task-visible-work-order", () => ({ readTaskVisibleWorkPage: stub.page }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => {}, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: async (_db: unknown, _actor: string, ids: string[]) => new Map(ids.map(id => [id, null])) }));
import { GET } from "./route";
const newer = { id: "new-normal", title: "New", projectId: "board", priority: "LOW", request: null, _count: { messages: 0, checklistItems: 0 } };
const older = { ...newer, id: "old-urgent", title: "Old", priority: "URGENT" };
beforeEach(() => {
  vi.resetAllMocks(); stub.project.mockResolvedValue({ name: "Безнал ОП" });
  stub.where.mockImplementation(async (_actor, filters) => ({ AND: [{ readable: true }, filters] }));
  stub.tasks.mockResolvedValue([older, newer]);
  stub.page.mockResolvedValue([{ id: newer.id, lastVisibleWorkAt: "2026-10-28T12:00:00.000Z" }, { id: older.id, lastVisibleWorkAt: "2026-10-28T10:00:00.000Z" }]);
});

it("pages the BezNal visible-work ordering before hydration and retains the fresh ACL and sentinel", async () => {
  const response = await GET(new Request("http://localhost/api/tasks?projectId=board&page=2&limit=1"));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.data).toMatchObject([{ id: "new-normal", priority: "LOW", lastVisibleWorkAt: "2026-10-28T12:00:00.000Z" }]);
  expect(result.meta).toMatchObject({ page: 2, limit: 1, hasMore: true });
  expect(stub.page).toHaveBeenCalledWith(expect.objectContaining({ offset: 1, pageSize: 1, where: expect.any(Object) }));
  expect(stub.where).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(stub.where.mock.calls[1][1])).toContain('"readable":true');
  expect(stub.tasks).toHaveBeenCalledOnce();
  expect(stub.urgentCount).not.toHaveBeenCalled();
});

it("keeps the existing urgency pagination on other boards", async () => {
  stub.project.mockResolvedValue({ name: "Поддержка" });
  stub.tasks.mockResolvedValueOnce([older]).mockResolvedValueOnce([]);
  const response = await GET(new Request("http://localhost/api/tasks?projectId=board&limit=1"));
  expect(response.status).toBe(200);
  expect((await response.json()).data[0].id).toBe("old-urgent");
  expect(stub.page).not.toHaveBeenCalled();
  expect(stub.tasks.mock.calls[0][0]).toMatchObject({ skip: 0, take: 2, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
});
