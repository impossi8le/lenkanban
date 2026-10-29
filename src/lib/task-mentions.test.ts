import { describe, expect, it, vi } from "vitest";
vi.mock("./prisma", () => ({ prisma: {} }));
vi.mock("./logger", () => ({ socketLogger: { error: vi.fn() } }));
vi.mock("@/socket/board-events", () => ({ emitUserNotification: vi.fn() }));
import { filterMentionReaders, mentionUserIdsSchema, persistTaskMentions, sameMentionIds, TaskMentionError, validateTaskMentions } from "./task-mentions";

function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === "OR") return (value as unknown[]).some(part => matches(row, part));
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(part => matches(part, value));
    if (key === "none") return Array.isArray(row) && !row.some(part => matches(part, value));
    if (key === "not") return !matches(row, value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (key === "has") return Array.isArray(row) && row.includes(value);
    if (key === "isEmpty") return Array.isArray(row) && (row.length === 0) === value;
    if (!row || typeof row !== "object" || !(key in row)) throw new Error(`Unsupported fixture predicate ${key}`);
    return matches((row as Record<string, unknown>)[key], value);
  });
}
function fixture() {
  const actors = ["author", "selected", "neighbor", "watcher", "leader", "admin", "blocked"].map(id => ({ id, globalRole: id === "admin" ? "ADMIN" as const : "USER" as const, isBlocked: id === "blocked", blockedAt: null as Date | null }));
  const record = { id: "task", projectId: "board", createdById: "author", assignees: [], watchers: [{ userId: "watcher" }],
    request: { contractVersion: 1, state: "SUBMITTED", deletedAt: null as Date | null, authorId: "author", executorId: null, audienceUserIds: ["selected"] as string[] },
    project: { id: "board", ownerId: "none", members: [], departmentId: "department", responsibleGroup: null,
      department: { archivedAt: null, leaderId: "leader", employees: [actors[1], actors[2]] } } };
  const notifications: unknown[] = [];
  const db = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => actors.find(actor => actor.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => actors.filter(actor => where.id.in.includes(actor.id) && !actor.isBlocked && actor.blockedAt === null)) },
    project: { findMany: vi.fn(async () => [{ id: "board" }]) }, scopedPrivilegeAssignment: { findMany: vi.fn(async ({ where }: { where: { userId: string } }) => ["selected", "neighbor"].includes(where.userId) ? [{ id: "execute", userId: where.userId, profileId: "profile", scopeKind: "board", departmentId: null, projectId: "board", profile: { archivedAt: null, permissions: ["request.execute"] } }] : []) },
    task: { findFirst: vi.fn(async ({ where }: { where: unknown }) => matches(record, where) ? { id: "task" } : null) },
    notification: { create: vi.fn(async ({ data }: { data: unknown }) => { notifications.push(data); return data; }) },
  };
  return { actors, record, notifications, db, client: db as never };
}
describe("explicit task mention intent", () => {
  it("normalizes ID set order and rejects duplicates, malformed and oversized lists", () => {
    expect(mentionUserIdsSchema.parse(["b", "a"])).toEqual(["a", "b"]); expect(mentionUserIdsSchema.parse(undefined)).toEqual([]);
    for (const value of [["a", "a"], ["@name"], Array.from({ length: 21 }, (_, i) => `user${i}`)]) expect(mentionUserIdsSchema.safeParse(value).success).toBe(false);
    expect(sameMentionIds(["b", "a"], ["a", "b"])).toBe(true); expect(sameMentionIds(["other"], ["a"])).toBe(false);
  });
  it("uses the actual common personal audience for readers including outside-department watchers, while denying nonexecutor leaders", async () => {
    const f = fixture(); expect(await filterMentionReaders(f.client, "task", "board", f.actors)).toEqual(["author", "selected", "watcher", "admin"]);
    f.record.request.audienceUserIds = []; expect(await filterMentionReaders(f.client, "task", "board", f.actors)).toContain("neighbor");
  });
  it.each(["neighbor", "blocked", "missing"])("rejects %s identically before notification persistence", async id => {
    const f = fixture(); await expect(validateTaskMentions(f.client, "task", "board", [id], "PUBLIC")).rejects.toMatchObject({ code: "MENTION_RECIPIENT_UNAVAILABLE" });
    expect(f.notifications).toEqual([]);
  });
  it.each(["removed", "draft", "deleted", "blocked"])("rechecks a selected outside watcher after %s", async change => {
    const f = fixture(); await validateTaskMentions(f.client, "task", "board", ["watcher"], "PUBLIC");
    if (change === "removed") f.record.watchers = []; if (change === "draft") f.record.request.state = "DRAFT";
    if (change === "deleted") f.record.request.deletedAt = new Date(); if (change === "blocked") f.actors.find(actor => actor.id === "watcher")!.blockedAt = new Date();
    await expect(validateTaskMentions(f.client, "task", "board", ["watcher"], "PUBLIC")).rejects.toBeInstanceOf(TaskMentionError);
  });
  it("stores one existing task_mentioned notification per explicit non-self recipient without leaking content", async () => {
    const f = fixture(); await validateTaskMentions(f.client, "task", "board", ["author", "selected", "watcher"], "PUBLIC");
    await persistTaskMentions(f.client, { taskId: "task", projectId: "board", actorId: "author", messageId: "message", mentionUserIds: ["author", "selected", "watcher"] });
    expect(f.notifications).toEqual(["selected", "watcher"].map(userId => expect.objectContaining({ userId, type: "task_mentioned", title: "Вас упомянули в обращении", metadata: expect.objectContaining({ taskId: "task", projectId: "board", messageId: "message" }) })));
    expect(JSON.stringify(f.notifications)).not.toContain("audienceUserIds");
  });
  it("fails the transaction if fresh notification visibility drops a selected recipient", async () => {
    const f = fixture(); f.record.watchers = [];
    await expect(persistTaskMentions(f.client, { taskId: "task", projectId: "board", actorId: "author", messageId: "message", mentionUserIds: ["watcher"] })).rejects.toBeInstanceOf(TaskMentionError);
  });
  it("does no recipient work for empty intent and explicitly rejects internal mentions", async () => {
    const f = fixture(); await validateTaskMentions(f.client, "task", "board", [], "INTERNAL");
    await expect(validateTaskMentions(f.client, "task", "board", ["selected"], "INTERNAL")).rejects.toMatchObject({ code: "MENTIONS_INTERNAL_UNSUPPORTED" });
    expect(f.db.user.findMany).not.toHaveBeenCalled(); expect(f.db.task.findFirst).not.toHaveBeenCalled();
  });
});


it("a read profile and direct audience do not make a staff member mention-readable without execute", async () => {
  const f = fixture();
  f.db.scopedPrivilegeAssignment.findMany.mockImplementation(async ({ where }) => [{ id: "read", userId: where.userId, profileId: "profile", scopeKind: "board", departmentId: null, projectId: "board", profile: { archivedAt: null, permissions: ["request.read"] } }]);
  expect(await filterMentionReaders(f.client, "task", "board", f.actors)).toEqual(["author", "watcher", "admin"]);
  await expect(validateTaskMentions(f.client, "task", "board", ["selected"], "PUBLIC")).rejects.toMatchObject({ code: "MENTION_RECIPIENT_UNAVAILABLE" });
  expect(f.notifications).toEqual([]);
});
