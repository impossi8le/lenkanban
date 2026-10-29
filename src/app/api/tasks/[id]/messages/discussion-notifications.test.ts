import { beforeEach, describe, expect, it, vi } from "vitest";

const notifications = vi.hoisted(() => ({ createNotifications: vi.fn(), filter: vi.fn(), persist: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: notifications.createNotifications, filterTaskNotificationRecipientIds: notifications.filter, persistNotificationsWithClient: notifications.persist }));

import {
  persistTaskContentNotifications,
  dispatchCommentNotifications,
  dispatchQueueNotifications,
  loadCommentNotificationContext,
} from "./discussion-notifications";
import type { DiscussionDb } from "./discussion-access";

type Row = Record<string, unknown>;

function database(task: Row | null, options: {
  project?: Row | null;
  watchers?: Array<{ userId: string }>;
  admins?: Array<{ id: string }>;
  grants?: Row[];
} = {}) {
  return {
    task: { findUnique: vi.fn(async () => task) },
    project: {
      findUnique: vi.fn(async () => options.project === undefined
        ? {
            id: "project",
            departmentId: "dept",
            responsibleGroupId: "group",
            department: { id: "dept", leaderId: "leader", archivedAt: null },
            responsibleGroup: {
              id: "group",
              archivedAt: null,
              members: [{ userId: "group-member" }, { userId: "author" }, { userId: "executor" }],
            },
          }
        : options.project),
    },
    user: { findMany: vi.fn(async () => options.admins ?? []) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => options.grants ?? []) },
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) =>
      parts.join("?").includes("TaskWatcher") ? options.watchers ?? [] : []),
    $executeRaw: vi.fn(async () => 1),
  } as unknown as DiscussionDb;
}

const assignedTask = {
  id: "task",
  title: "Синтетическая заявка",
  projectId: "project",
  request: { authorId: "author", executorId: "executor" },
  assignees: [],
};

beforeEach(() => {
  notifications.persist.mockReset().mockImplementation(async (_db, rows) => rows.map((row: Row, index: number) => ({ ...row, id: `n-${index}` })));
  notifications.createNotifications.mockReset();
  notifications.createNotifications.mockResolvedValue({ count: 0 });
  notifications.filter.mockReset();
  notifications.filter.mockImplementation(async (_db, _taskId, _projectId, candidates) => candidates);
});

describe("comment notification recipients", () => {
  it.each(["comment", "file", "return_for_revision", "approval", "invoice_ready"] as const)("persists %s inside the writer transaction without premature delivery", async event => {
    const db = database(assignedTask, { watchers: [{ userId: "watcher" }, { userId: "author" }] }) as Parameters<typeof persistTaskContentNotifications>[0]["db"];
    const rows = await persistTaskContentNotifications({ db, taskId: "task", actorId: "executor", actorName: "Исполнитель", visibility: "PUBLIC", event, eventId: "activity-1" });
    expect(notifications.persist).toHaveBeenCalledOnce();
    expect(notifications.persist.mock.calls[0][0]).toBe(db);
    expect(rows.map(row => row.userId)).toEqual(["author", "watcher"]);
    expect(rows.every(row => (row.metadata as Row).event === event && (row.metadata as Row).eventId === "activity-1")).toBe(true);
    expect(notifications.createNotifications).not.toHaveBeenCalled();
    expect(rows.some(row => row.userId === "leader" || row.userId === "group-member")).toBe(false);
  });

  it("propagates notification persistence failure so the owning content transaction can roll back", async () => {
    notifications.persist.mockRejectedValue(new Error("synthetic persistence failure"));
    const db = database(assignedTask) as Parameters<typeof persistTaskContentNotifications>[0]["db"];
    await expect(persistTaskContentNotifications({ db, taskId: "task", actorId: "executor", actorName: "Исполнитель", visibility: "PUBLIC", event: "file", eventId: "activity-1" })).rejects.toThrow("synthetic persistence failure");
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });

  it("rejects a missing source event identity before loading or persisting recipient data", async () => {
    const db = database(assignedTask) as Parameters<typeof persistTaskContentNotifications>[0]["db"];
    await expect(persistTaskContentNotifications({ db, taskId: "task", actorId: "executor", actorName: "Исполнитель", visibility: "PUBLIC", event: "file", eventId: "" })).rejects.toThrow("INVALID_NOTIFICATION_EVENT_ID");
    expect(db.task.findUnique).not.toHaveBeenCalled();
    expect(notifications.persist).not.toHaveBeenCalled();
  });

  it("caps watcher and internal grants with current task read before persistence", async () => {
    const db = database(assignedTask, { watchers: [{ userId: "watcher" }] });
    notifications.filter.mockResolvedValue([]);
    expect(await dispatchCommentNotifications({ db, taskId: "task", actorId: "commenter", actorName: "Автор", visibility: "INTERNAL" })).toEqual([]);
    expect(notifications.filter).toHaveBeenCalledExactlyOnceWith(db, "task", "project", ["author", "executor"]);
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });
  it("notifies author, executor, subscribed watchers without management or group broadcast", async () => {
    const db = database(assignedTask, { watchers: [{ userId: "watcher" }] });
    const recipients = await dispatchCommentNotifications({
      db, taskId: "task", actorId: "commenter", actorName: "Комментатор", visibility: "PUBLIC",
    });

    expect(recipients).toEqual(["author", "executor", "watcher"]);
    expect(notifications.createNotifications).toHaveBeenCalledTimes(1);
    const rows = notifications.createNotifications.mock.calls[0]?.[0] as Array<Row>;
    expect(rows.map(row => row.userId)).toEqual(["author", "executor", "watcher"]);
    expect(rows.every(row => row.type === "chat_message")).toBe(true);
    expect(rows.some(row => row.userId === "group-member")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("Синтетическое сообщение");
  });

  it("deduplicates overlapping roles and never notifies the actor", async () => {
    const db = database(assignedTask, { watchers: [{ userId: "author" }, { userId: "leader" }] });
    const recipients = await dispatchCommentNotifications({
      db, taskId: "task", actorId: "executor", actorName: "Исполнитель", visibility: "PUBLIC",
    });
    expect(recipients).toEqual(["author", "leader"]);
    expect(notifications.createNotifications.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("sends internal notifications only to recipients who may read the internal part", async () => {
    const db = database(assignedTask, {
      watchers: [{ userId: "watcher" }, { userId: "outside-watcher" }],
      admins: [],
    });
    const recipients = await dispatchCommentNotifications({
      db, taskId: "task", actorId: "commenter", actorName: "Комментатор", visibility: "INTERNAL",
    });
    // Author and executor are active group members. Unsubscribed leadership
    // and watchers without an internal role are not recipients.
    expect(recipients).toEqual(["author", "executor"]);
    expect(JSON.stringify(notifications.createNotifications.mock.calls[0]?.[0]))
      .not.toContain("outside-watcher");
    expect(JSON.stringify(notifications.createNotifications.mock.calls[0]?.[0]))
      .not.toContain('"watcher"');
    expect(notifications.createNotifications.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Новое внутреннее сообщение в задаче" })]),
    );
  });

  it("uses legacy assignees when the task has no request marker", async () => {
    const db = database({
      ...assignedTask,
      request: null,
      assignees: [{ userId: "assignee" }, { userId: "assignee" }],
    });
    const recipients = await dispatchCommentNotifications({
      db, taskId: "task", actorId: "commenter", actorName: "Комментатор", visibility: "PUBLIC",
    });
    expect(recipients).toEqual(["assignee"]);
  });

  it("does not deliver anything when recipient facts cannot be loaded", async () => {
    const db = database(null);
    const recipients = await dispatchCommentNotifications({
      db, taskId: "task", actorId: "commenter", actorName: "Комментатор", visibility: "PUBLIC",
    });
    expect(recipients).toEqual([]);
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });

  it("loads no watchers when the forward-compatible table is absent", async () => {
    const db = database(assignedTask, { project: null });
    const context = await loadCommentNotificationContext(db, "task");
    expect(context).toMatchObject({ watcherIds: [], managementIds: [], projectFacts: null });
  });
});

describe("queue notifications", () => {
  it("filters current task readers before constructing private queue notification rows", async () => {
    const db = database(assignedTask);
    notifications.filter.mockResolvedValue(["executor"]);
    const recipients = await dispatchQueueNotifications({ db, taskId: "task", actorId: "author", actorName: "Автор" });
    expect(notifications.filter).toHaveBeenCalledExactlyOnceWith(db, "task", "project", ["executor", "group-member", "leader"]);
    expect(recipients).toEqual(["executor"]);
    expect(notifications.createNotifications.mock.calls[0][0]).toEqual([expect.objectContaining({ userId: "executor" })]);
  });
  it("notifies the whole responsible group once on queue entry", async () => {
    const db = database(assignedTask);
    const recipients = await dispatchQueueNotifications({
      db, taskId: "task", actorId: "author", actorName: "Автор",
    });
    expect(recipients).toEqual(["executor", "group-member", "leader"]);
    const rows = notifications.createNotifications.mock.calls[0]?.[0] as Array<Row>;
    expect(rows.map(row => row.userId)).toEqual(["executor", "group-member", "leader"]);
    expect(rows.every(row => row.type === "task_assigned")).toBe(true);
    expect(rows.every(row => row.title === "Заявка поступила в очередь" && typeof row.message === "string" && row.message.includes("поступила в очередь"))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("ожидает в очереди");
    expect(JSON.stringify(rows)).not.toContain("Синтетическое сообщение");
  });

  it("delivers nothing when the board has no responsible group", async () => {
    const db = database(assignedTask, { project: {
      id: "project",
      departmentId: null,
      responsibleGroupId: null,
      department: null,
      responsibleGroup: null,
    } });
    const recipients = await dispatchQueueNotifications({
      db, taskId: "task", actorId: "author", actorName: "Автор",
    });
    expect(recipients).toEqual([]);
    expect(notifications.createNotifications).not.toHaveBeenCalled();
  });
});


it("excludes explicit mention recipients from the ordinary comment notification", async () => {
  const db = database(assignedTask, { watchers: [{ userId: "watcher" }] });
  const recipients = await dispatchCommentNotifications({ db, taskId: "task", actorId: "commenter", actorName: "Автор", visibility: "PUBLIC", excludedRecipientIds: ["author", "watcher"] });
  expect(recipients).not.toContain("author"); expect(recipients).not.toContain("watcher"); expect(recipients).toContain("executor");
  expect(notifications.createNotifications).toHaveBeenCalledWith(expect.not.arrayContaining([expect.objectContaining({ userId: "author" }), expect.objectContaining({ userId: "watcher" })]));
});
