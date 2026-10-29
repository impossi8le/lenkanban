import type { Notification } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({
  actor: vi.fn(), task: vi.fn(), taskMany: vi.fn(), project: vi.fn(), projectMany: vi.fn(),
  where: vi.fn(), allowed: vi.fn(),
  rows: vi.fn(), find: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  changed:vi.fn(), attachments: vi.fn(), internal: vi.fn(), facts: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: {
  user: { findUnique: stub.actor },
  task: { findFirst: stub.task, findMany: stub.taskMany },
  project: { findMany: stub.projectMany },
  notification: { findMany: stub.rows, findFirst: stub.find, update: stub.update, updateMany: stub.updateMany },
} }));
vi.mock("./project-access", () => ({ getProjectAccess: stub.project, getTaskReadWhere: stub.where }));
vi.mock("./auth", () => ({ isAccountAllowed: stub.allowed }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-access", () => ({ canActorReadInternal: stub.internal, loadProjectDiscussionFacts: stub.facts }));
vi.mock("./attachments/task-port", async original => ({ ...await original<typeof import("./attachments/task-port")>(), readVisibleTaskAttachments: stub.attachments }));
vi.mock("./logger", () => ({ socketLogger: { error: vi.fn() } }));
vi.mock("@/socket/board-events", () => ({ emitUserNotification: vi.fn(), emitUserNotificationChanged: stub.changed }));

import { getNotifications, getUnreadCount, getUnreadNotificationSummary, isNotificationVisible, markAllNotificationsRead, markNotificationRead } from "./notifications";

const row = (id: string, taskId = "task-a", userId = "alice"): Notification => ({
  id, userId, type: "task_assigned", title: "private title", message: "private message",
  actionUrl: `/projects/board/board?task=${taskId}`, metadata: { projectId: "board", taskId },
  read: false, readAt: null, createdAt: new Date(),
});

beforeEach(() => {
  vi.resetAllMocks();
  stub.allowed.mockResolvedValue(true);
  stub.actor.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, globalRole: "USER" }));
  stub.where.mockImplementation(async (actor: { id: string }, filters: object) => ({ actor: actor.id, ...filters }));
  stub.task.mockResolvedValue({ id: "task-a" });
  stub.taskMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map(id => ({ id,projectId:"board" })));
  stub.project.mockResolvedValue({ canRead: true });
  stub.projectMany.mockResolvedValue([]);
  stub.rows.mockResolvedValue([]);
  stub.updateMany.mockResolvedValue({count:0});
  stub.attachments.mockResolvedValue([]);
  stub.internal.mockResolvedValue(false); stub.facts.mockResolvedValue({ projectId: "board" });
});

describe("notifications follow current shared visibility", () => {
  it("requires fresh internal permission for the feed, count and individual notification read", async () => {
    const internal = { ...row("internal"), metadata: { taskId: "task-a", projectId: "board", visibility: "INTERNAL" } };
    stub.rows.mockResolvedValue([internal]);
    expect(await getNotifications("alice")).toEqual([]);
    expect(await getUnreadCount("alice")).toBe(0);
    expect(await isNotificationVisible(internal)).toBe(false);
    stub.internal.mockResolvedValue(true);
    expect(await getNotifications("alice")).toEqual([internal]);
    expect(await getUnreadCount("alice")).toBe(1);
    expect(await isNotificationVisible(internal)).toBe(true);
    stub.internal.mockResolvedValue(false);
    expect(await getNotifications("alice")).toEqual([]);
    expect(stub.internal).toHaveBeenCalledWith(expect.anything(), { id: "alice", globalRole: "USER" }, { projectId: "board" });
  });

  it("projects the same current board phase in batches and never exposes hidden attachment metadata", async () => {
    const queue = { ...row("queue"), metadata: { taskId: "task-a", projectId: "board", reason: "queue" } };
    stub.rows.mockResolvedValue([queue, row("duplicate"), row("other", "task-b")]);
    const privateFiles = [{ name: "PRIVATE_FILE", url: "/private", size: 1, mime: "application/pdf", isInternal: true }];
    stub.taskMany.mockImplementation(async ({ select }: { select: { status?: boolean } }) => select.status ? [
      { id: "task-a", projectId: "board", status: "IN_PROGRESS", request: { state: "IN_PROGRESS" }, project: { name: "Безнал ОП" }, attachments: privateFiles },
      { id: "task-b", projectId: "board", status: "IN_PROGRESS", request: { state: "IN_PROGRESS" }, project: { name: "Поддержка" } },
    ]  : [{ id: "task-a",projectId:"board" }, { id: "task-b",projectId:"board" }]);
    const result = await getNotifications("alice");
    expect(result).toMatchObject([
      { id: "queue", currentTask: { taskId: "task-a", projectId: "board", phase: { code: "WAITING", label: "Ждут обработки" } } },
      { id: "duplicate", currentTask: { phase: { code: "WAITING" } } },
      { id: "other", currentTask: { phase: { code: "IN_PROGRESS", label: "В работе" } } },
    ]);
    expect(stub.taskMany).toHaveBeenCalledTimes(2);
    expect(stub.attachments).toHaveBeenCalledExactlyOnceWith(expect.anything(), { id: "alice", globalRole: "USER" }, "board", privateFiles);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FILE");
    stub.attachments.mockResolvedValue([{ name: "visible", url: "/visible" }]);
    privateFiles.push({ name: "visible", url: "/visible", size: 1, mime: "application/pdf", isInternal: false });
    expect((await getNotifications("alice"))[0]).toMatchObject({ currentTask: { phase: { code: "INVOICED", label: "Со счётом" } } });
  });

  it("removes notifications revoked between visibility filtering and the fresh phase read", async () => {
    stub.rows.mockResolvedValue([row("queue")]);
    stub.taskMany.mockResolvedValueOnce([{ id: "task-a",projectId:"board" }]).mockResolvedValueOnce([]);
    expect(await getNotifications("alice")).toEqual([]);
  });

  it("rejects a current task whose real project differs from the stored reference", async () => {
    stub.rows.mockResolvedValue([row("queue")]);
    stub.taskMany.mockResolvedValue([{ id: "task-a", projectId: "different", status: "IN_PROGRESS", project: { name: "Support" } }]);
    expect(await getNotifications("alice")).toEqual([]);
  });

  it("checks two recipients independently and rechecks rights without a reconnect", async () => {
    let revoked = false;
    stub.task.mockImplementation(async ({ where }: { where: { actor: string } }) =>
      where.actor === "alice" && !revoked ? { id: "task-a" } : null);
    expect(await isNotificationVisible(row("a"))).toBe(true);
    expect(await isNotificationVisible(row("b", "task-a", "bob"))).toBe(false);
    revoked = true;
    expect(await isNotificationVisible(row("a"))).toBe(false);
    expect(stub.actor).toHaveBeenCalledTimes(3);
    expect(stub.where).toHaveBeenCalledWith({ id: "alice", globalRole: "USER" }, { id: "task-a", projectId: "board" });
  });

  it.each([
    null, {}, { ...row("a"), metadata: { taskId: 7 } },
    { ...row("a"), metadata: {} },
    { ...row("a"), actionUrl: "https://outside.invalid/projects/board/board?task=task-a" },
    { ...row("a"), actionUrl: "/projects/board/board?task=task-b" },
    { ...row("a"), actionUrl: "/projects/board/board?task=task-a&task=task-b" },
    { ...row("a"), metadata: { taskId: "task-a", projectId: "other-board" } },
    { ...row("a"), metadata: { taskId: "task-a", projectId: "board", visibility: "unrecognized" } },
  ])("fails closed for malformed or inconsistent references %j", async value => {
    expect(await isNotificationVisible(value)).toBe(false);
    expect(stub.task).not.toHaveBeenCalled();
  });

  it("rejects a blocked or deleted account and uses a freshly demoted role", async () => {
    stub.allowed.mockResolvedValueOnce(false);
    expect(await isNotificationVisible(row("a"))).toBe(false);
    stub.actor.mockResolvedValueOnce(null);
    expect(await isNotificationVisible(row("a"))).toBe(false);
    stub.actor.mockResolvedValueOnce({ id: "alice", globalRole: "USER" });
    await isNotificationVisible(row("a"));
    expect(stub.where).toHaveBeenCalledExactlyOnceWith({ id: "alice", globalRole: "USER" }, { id: "task-a", projectId: "board" });
  });

  it("filters history before pagination and counts only currently visible unread rows", async () => {
    const hidden = row("hidden", "secret");
    const first = row("first");
    const second = row("second");
    stub.rows.mockResolvedValue([hidden, first, second]);
    stub.taskMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter(id => id !== "secret").map(id => ({ id,projectId:"board" })));
    expect(await getNotifications("alice", { limit: 1, offset: 1 })).toEqual([second]);
    expect(await getUnreadCount("alice")).toBe(2);
    expect(stub.rows).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { userId: "alice", read: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
  });

  it("never returns a revoked notification from the read mutation", async () => {
    stub.find.mockResolvedValue(row("hidden"));
    stub.task.mockResolvedValue(null);
    expect(await markNotificationRead("hidden", "alice")).toBeNull();
    expect(stub.find).toHaveBeenCalledExactlyOnceWith({ where: { id: "hidden", userId: "alice" } });
    expect(stub.update).not.toHaveBeenCalled();
  });

  it("limits mark-all to visible notification IDs", async () => {
    stub.rows.mockResolvedValue([row("hidden", "secret"), row("visible")]);
    stub.taskMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter(id => id !== "secret").map(id => ({ id,projectId:"board" })));
    await markAllNotificationsRead("alice");
    expect(stub.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "alice", read: false, id: { in: ["visible"] } },
      data: { read: true, readAt: expect.any(Date) },
    });
  });

  it("revalidates project membership history through the shared project adapter", async () => {
    stub.project.mockResolvedValue({ canRead: false });
    expect(await isNotificationVisible({ ...row("project"), type: "project_member_added", metadata: { projectId: "board" }, actionUrl: "/projects/board/board" })).toBe(false);
    expect(stub.project).toHaveBeenCalledExactlyOnceWith({ id: "alice", globalRole: "USER" }, "board");
  });
});

it("canonical unread summary buckets visible events and preserves bell event unit",async()=>{
 stub.rows.mockResolvedValue([row("a"),row("b"),row("c","task-b")]);
 const summary=await getUnreadNotificationSummary("alice");
 expect(summary).toEqual({actorId:"alice",count:3,byProject:{board:3},byTask:{"task-a":2,"task-b":1},unscopedCount:0});
 expect(Object.values(summary.byProject).reduce((a,b)=>a+b,0)+summary.unscopedCount).toBe(summary.count);
});
it("canonical summary hides unavailable task and internal events before counting",async()=>{
 stub.rows.mockResolvedValue([row("public"),{...row("internal"),metadata:{projectId:"board",taskId:"task-a",visibility:"INTERNAL"}},row("hidden","hidden-task")]);
 stub.taskMany.mockResolvedValue([{id:"task-a",projectId:"board"}]);
 expect(await getUnreadNotificationSummary("alice")).toMatchObject({count:1,byProject:{board:1},byTask:{"task-a":1}});
 stub.allowed.mockResolvedValue(false);expect((await getUnreadNotificationSummary("alice")).count).toBe(0);
});

it("manual read and read-all invalidate only after successful committed writes",async()=>{
 stub.find.mockResolvedValue(row("one"));stub.update.mockResolvedValue({...row("one"),read:true});await markNotificationRead("one","alice");
 expect(stub.changed).toHaveBeenCalledExactlyOnceWith("alice");expect(stub.update.mock.invocationCallOrder[0]).toBeLessThan(stub.changed.mock.invocationCallOrder[0]);
 stub.changed.mockClear();stub.rows.mockResolvedValue([row("two")]);stub.updateMany.mockResolvedValue({count:1});await markAllNotificationsRead("alice");expect(stub.changed).toHaveBeenCalledExactlyOnceWith("alice");
 stub.changed.mockClear();stub.updateMany.mockRejectedValueOnce(Error("synthetic-private"));await expect(markAllNotificationsRead("alice")).rejects.toThrow();expect(stub.changed).not.toHaveBeenCalled();
});

it("batches canonical task/project pairs and refuses wrong-board counts or internal grants",async()=>{
 const wrong={...row("wrong"),actionUrl:"/projects/board-b/board?task=task-a",metadata:{projectId:"board-b",taskId:"task-a",visibility:"INTERNAL"}};
 stub.rows.mockResolvedValue([wrong]);stub.taskMany.mockResolvedValue([{id:"task-a",projectId:"board-a"}]);stub.internal.mockResolvedValue(true);
 expect(await getUnreadNotificationSummary("alice")).toMatchObject({count:0,byProject:{},byTask:{}});
 expect(stub.facts).not.toHaveBeenCalled();
 expect(await getNotifications("alice")).toEqual([]);
});

it("rejects link-only task references consistently in feed, count, summary and manual acknowledgement",async()=>{
 const malformed={...row("link-only"),type:"chat_message",metadata:{projectId:"board"}};stub.rows.mockResolvedValue([malformed]);stub.find.mockResolvedValue(malformed);
 expect(await getNotifications("alice")).toEqual([]);expect(await getUnreadCount("alice")).toBe(0);expect((await getUnreadNotificationSummary("alice")).byTask).toEqual({});expect(await markNotificationRead("link-only","alice")).toBeNull();expect(stub.update).not.toHaveBeenCalled();
});
