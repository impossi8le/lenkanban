import { beforeEach, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { readTaskVisibleWorkPage } from "./task-visible-work-order";
import type { DiscussionDb } from "@/app/api/tasks/[id]/messages/discussion-access";

const access = vi.hoisted(() => ({ internal: vi.fn(), facts: vi.fn() }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-access", () => ({ canActorReadInternal: access.internal, loadProjectDiscussionFacts: access.facts }));
const findMany = vi.fn(), aggregate = vi.fn();
const db = { task: { findMany }, $queryRaw: aggregate } as unknown as DiscussionDb;
const actor = { id: "reader", globalRole: "USER" as const };
beforeEach(() => {
  vi.clearAllMocks(); access.internal.mockResolvedValue(false); access.facts.mockResolvedValue({ projectId: "board" });
  findMany.mockResolvedValue([{ id: "new-normal" }, { id: "old-urgent" }]);
  aggregate.mockResolvedValue([{ id: "new-normal", lastVisibleWorkAt: new Date("2026-10-28T12:00:00Z") }, { id: "old-urgent", lastVisibleWorkAt: new Date("2026-10-28T10:00:00Z") }]);
});

it("passes the entire ACL-narrowed board to aggregation before applying a page, including more than 1000 tasks", async () => {
  const ids = Array.from({ length: 1205 }, (_, index) => ({ id: "t-" + index }));
  findMany.mockResolvedValue(ids); aggregate.mockResolvedValue([]);
  const where: Prisma.TaskWhereInput = { AND: [{ projectId: "board" }, { id: { in: ["authorized"] } }] };
  await readTaskVisibleWorkPage({ db, actor, projectId: "board", where, offset: 1000, pageSize: 50 });
  expect(findMany).toHaveBeenCalledExactlyOnceWith({ where, select: { id: true } });
  expect(aggregate).toHaveBeenCalledOnce();
  const query = aggregate.mock.calls[0][0] as Prisma.Sql;
  expect(query.values).toContainEqual(ids.map(row => row.id));
  expect(query.values.slice(-2)).toEqual([1000, 51]);
  expect(query.sql.indexOf("GROUP BY")).toBeLessThan(query.sql.indexOf("OFFSET"));
  expect(query.sql).not.toContain('"updatedAt"');
  expect(query.sql).not.toContain('"priority"');
  expect(query.sql).not.toContain('"TaskViewReceipt"');
  expect(query.sql).not.toContain('"Notification"');
});

it("keeps the database's newest-visible ordering and ISO timestamp instead of reapplying urgency", async () => {
  expect(await readTaskVisibleWorkPage({ db, actor, projectId: "board", where: {}, offset: 0, pageSize: 1 })).toEqual([
    { id: "new-normal", lastVisibleWorkAt: "2026-10-28T12:00:00.000Z" },
    { id: "old-urgent", lastVisibleWorkAt: "2026-10-28T10:00:00.000Z" },
  ]);
  expect(access.internal).toHaveBeenCalledExactlyOnceWith(db, actor, { projectId: "board" });
  const query = aggregate.mock.calls[0][0] as Prisma.Sql;
  expect(query.values.filter(value => value === false)).toHaveLength(2);
  expect(query.values.filter(Array.isArray).flat()).not.toContain("request_invoice_ready");
});

it("does no raw or internal-authority reads when the shared ACL yields no tasks", async () => {
  findMany.mockResolvedValue([]);
  expect(await readTaskVisibleWorkPage({ db, actor, projectId: "board", where: {}, offset: 0, pageSize: 2 })).toEqual([]);
  expect(aggregate).not.toHaveBeenCalled(); expect(access.internal).not.toHaveBeenCalled();
});

it("fails closed for rows outside the authorized set and invalid pagination", async () => {
  aggregate.mockResolvedValue([{ id: "hidden", lastVisibleWorkAt: new Date() }]);
  await expect(readTaskVisibleWorkPage({ db, actor, projectId: "board", where: {}, offset: 0, pageSize: 2 })).rejects.toThrow("INVALID_VISIBLE_WORK_RESULT");
  await expect(readTaskVisibleWorkPage({ db, actor, projectId: "board", where: {}, offset: -1, pageSize: 2 })).rejects.toThrow("INVALID_VISIBLE_WORK_PAGE");
});
