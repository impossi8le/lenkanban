import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db: unknown, _actor: unknown, ids: readonly string[]) => new Map(ids.map(id => [id, { total: 0, unread: 0 }])) }));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), readable: vi.fn(), unseen: vi.fn(), arrivals: vi.fn(), list: vi.fn(), count: vi.fn(), raw: vi.fn(), checklist: vi.fn(), limit: vi.fn(), attachments: vi.fn(), prisma: {} as object }));
vi.mock("@/lib/prisma", () => {
  const prisma = { project: { findUnique: async () => null }, task: { findMany: mocks.list, count: mocks.count }, $queryRaw: mocks.raw, taskChecklistItem: { groupBy: mocks.checklist } };
  mocks.prisma = prisma; return { prisma };
});
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.auth, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: mocks.readable }));
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueUnseenWhere: mocks.unseen, readRequestQueueArrivalMap: mocks.arrivals }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: mocks.limit, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/attachments/task-port", () => ({ readVisibleTaskAttachments: mocks.attachments }));
import { GET } from "./route";
import { taskListVisibilityWhere } from "@/lib/task-list-visibility";
import { taskSearchPredicate } from "@/lib/task-search";

const run = (query = "") => GET(new Request("http://localhost/api/tasks?" + query));
const row = (id: string) => ({ id, projectId: "board", title: id, attachments: [], request: null, _count: { checklistItems: 0, messages: 0 } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.readable.mockResolvedValue({ scopedRead: "test-sentinel" });
  mocks.unseen.mockResolvedValue({ narrowedUnseen: "test-sentinel" });
  mocks.arrivals.mockResolvedValue(new Map());
  mocks.list.mockResolvedValue([]); mocks.count.mockResolvedValue(1);
  mocks.raw.mockResolvedValue([]); mocks.checklist.mockResolvedValue([]); mocks.attachments.mockResolvedValue(undefined);
});

describe("unseen list narrowing and actor queue DTO", () => {
  it("intersects scope, search/status/project filters and unseen before urgency count/rows paging", async () => {
    expect((await run("unseen=1&projectId=board&status=IN_PROGRESS&columnId=active&assignedToMe=true&search=Анна&page=2")).status).toBe(200);
    expect(mocks.readable).toHaveBeenCalledWith({ id: "actor", globalRole: "USER" }, {
      AND: [{ projectId: "board", status: "IN_PROGRESS", columnId: "active", OR: [
        { request: { is: { contractVersion: 1, executorId: "actor", deletedAt: null } } },
        { request: { is: null }, assignees: { some: { userId: "actor" } } },
      ] }, taskSearchPredicate("Анна")],
    }, mocks.prisma, { projectId: "board" });
    expect(mocks.unseen).toHaveBeenCalledExactlyOnceWith(mocks.prisma, "actor", { AND: [{ scopedRead: "test-sentinel" }, taskListVisibilityWhere()] });
    for (const [options] of mocks.list.mock.calls) expect(options.where.AND[0]).toEqual({ narrowedUnseen: "test-sentinel" });
    // Normal page2 needs the urgency count; the same predicate must reach it.
    await run("unseen=1&page=2&limit=2");
    expect(mocks.count).toHaveBeenCalledWith({ where: { AND: [{ narrowedUnseen: "test-sentinel" }, { priority: { in: ["CRITICAL", "URGENT", "HIGH"] } }] } });
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 1, take: 3 }));
  });

  it.each(["", "unseen=0", "unseen=true"])("does not activate unseen filtering for %s", async query => {
    expect((await run(query)).status).toBe(200);
    expect(mocks.unseen).not.toHaveBeenCalled();
  });

  it("projects canonical/legacy independently, overrides raw actor data and omits a revoked row", async () => {
    mocks.list.mockResolvedValueOnce([{ ...row("fresh"), queueArrival: { epoch: 999, unseen: false } }, row("legacy"), row("revoked")]);
    mocks.arrivals.mockResolvedValueOnce(new Map([["fresh", { epoch: 7, unseen: true }], ["legacy", null]]));
    const response = await run();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = (await response.json()).data;
    expect(data.map((item: { id: string }) => item.id)).toEqual(["fresh", "legacy"]);
    expect(data[0].queueArrival).toEqual({ epoch: 7, unseen: true });
    expect(data[1].queueArrival).toBeNull();
    expect(mocks.arrivals).toHaveBeenCalledWith(mocks.prisma, "actor", ["fresh", "legacy", "revoked"]);
    expect(mocks.attachments).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of returning raw DTOs when actor projection fails", async () => {
    mocks.list.mockResolvedValueOnce([row("fresh")]);
    mocks.arrivals.mockRejectedValueOnce(new Error("private query details"));
    const response = await run();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).not.toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain("private query details");
  });
});
