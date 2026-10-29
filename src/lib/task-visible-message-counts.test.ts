import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { readVisibleMessageCounts } from "./task-visible-message-counts";

const access = vi.hoisted(() => ({ where: vi.fn(), facts: vi.fn(), internal: vi.fn() }));
vi.mock("./project-access", () => ({ getTaskReadWhere: access.where }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-access", () => ({ loadProjectDiscussionFacts: access.facts, canActorReadInternal: access.internal }));
const tasks = vi.fn(), raw = vi.fn();
const db = { task: { findMany: tasks }, $queryRaw: raw } as unknown as Prisma.TransactionClient;
const actor = { id: "reader", globalRole: "USER" as const };
beforeEach(() => {
  vi.clearAllMocks();
  access.where.mockImplementation(async (_actor, filter) => ({ AND: [{ actorReadGuard: true }, filter] }));
  access.facts.mockImplementation(async (_db, projectId) => ({ projectId }));
  access.internal.mockImplementation(async (_db, _actor, facts) => facts.projectId === "internal-project");
  tasks.mockResolvedValue([{ id: "public", projectId: "public-project" }, { id: "private", projectId: "internal-project" }, { id: "private-two", projectId: "internal-project" }]);
  raw.mockResolvedValue([{ taskId: "public", total: 3n, unread: 1n }, { taskId: "private", total: 4n, unread: 2n }]);
});

it("counts only freshly readable task IDs and grants internal counts per project in one batched SQL read", async () => {
  const result = await readVisibleMessageCounts(db, actor, ["public", "private", "private-two", "revoked", "public"]);
  expect(access.where).toHaveBeenCalledExactlyOnceWith(actor, { id: { in: ["public", "private", "private-two", "revoked"] } }, db);
  expect(tasks).toHaveBeenCalledExactlyOnceWith({ where: { AND: [{ actorReadGuard: true }, { id: { in: ["public", "private", "private-two", "revoked"] } }] }, select: { id: true, projectId: true } });
  expect(access.internal).toHaveBeenCalledTimes(2);
  expect(raw).toHaveBeenCalledOnce();
  const query = raw.mock.calls[0][0] as Prisma.Sql;
  expect(query.values).not.toContain("revoked");
  expect(query.values.filter(value => value === "public")).toHaveLength(1);
  expect(query.values.filter(value => value === "private")).toHaveLength(2);
  expect(query.values.filter(value => value === "private-two")).toHaveLength(2);
  expect(result).toEqual(new Map([["public", { total: 3, unread: 1 }], ["private", { total: 4, unread: 2 }], ["private-two", { total: 0, unread: 0 }]]));
  expect(result.has("revoked")).toBe(false);
});

it("rechecks revoked task and internal access on every call without returning cached counts", async () => {
  await readVisibleMessageCounts(db, actor, ["public", "private"]);
  access.internal.mockResolvedValue(false);
  raw.mockResolvedValue([{ taskId: "public", total: 1n, unread: 0n }]);
  const afterInternalRevocation = await readVisibleMessageCounts(db, actor, ["public", "private"]);
  expect(afterInternalRevocation.get("public")).toEqual({ total: 1, unread: 0 });
  const latestQuery = raw.mock.calls.at(-1)![0] as Prisma.Sql;
  expect(latestQuery.sql).not.toContain('OR "taskId"');
  tasks.mockResolvedValue([]);
  const calls = raw.mock.calls.length;
  expect(await readVisibleMessageCounts(db, actor, ["public", "private"])).toEqual(new Map());
  expect(raw).toHaveBeenCalledTimes(calls);
});

it.each([
  { total: -1n, unread: 0n }, { total: 1n, unread: -1n }, { total: 1n, unread: 2n },
  { total: 9007199254740992n, unread: 0n }, { total: Number.NaN, unread: 0n },
])("fails closed for invalid aggregate values %#", async counts => {
  raw.mockResolvedValue([{ taskId: "public", ...counts }]);
  await expect(readVisibleMessageCounts(db, actor, ["public"])).rejects.toThrow("INVALID_VISIBLE_MESSAGE_COUNTS");
});

it("does not promote unexpected aggregate task IDs into a read grant", async () => {
  raw.mockResolvedValue([{ taskId: "not-authorized", total: 999n, unread: 999n }]);
  const result = await readVisibleMessageCounts(db, actor, ["public"]);
  expect(result.has("not-authorized")).toBe(false);
});

it("rejects malformed or excessive IDs before reading storage and avoids reads for an empty list", async () => {
  expect(await readVisibleMessageCounts(db, actor, [])).toEqual(new Map());
  await expect(readVisibleMessageCounts(db, actor, ["bad id"])).rejects.toThrow("Invalid task identities");
  await expect(readVisibleMessageCounts(db, actor, Array.from({ length: 1001 }, (_, index) => "task-" + index))).rejects.toThrow("Invalid task identities");
  expect(tasks).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
});

it("propagates authority and SQL failures rather than emitting zero or legacy unrestricted counters", async () => {
  access.where.mockRejectedValueOnce(new Error("synthetic authority unavailable"));
  await expect(readVisibleMessageCounts(db, actor, ["public"])).rejects.toThrow("synthetic authority unavailable");
  raw.mockRejectedValueOnce(new Error("synthetic aggregation unavailable"));
  await expect(readVisibleMessageCounts(db, actor, ["public"])).rejects.toThrow("synthetic aggregation unavailable");
});
