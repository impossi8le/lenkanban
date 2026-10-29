import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ emit: vi.fn(), limit: vi.fn(), database: {} as object }));
vi.mock("./prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(bridge.database, key) }) }));
vi.mock("./rate-limit", () => ({ rateLimitOrThrowKey: bridge.limit }));
vi.mock("./auth", () => ({ isAccountAllowed: async () => true }));
vi.mock("./logger", () => ({ socketLogger: { error: vi.fn() } }));
vi.mock("@/socket/board-events", () => ({ emitUserNotification: bridge.emit }));
import { createNotification, createNotifications, filterTaskNotificationRecipientIds, getNotifications, getUnreadCount,
  isNotificationVisible, persistNotificationsWithClient,
  type CreateNotificationParams } from "./notifications";
import { requireTaskRead } from "./project-access";
import { createVisibilityDelivery, type VisibilitySocket } from "@/socket/visibility-delivery";

// Executes the real common Prisma predicate against synthetic rows. This is a
// policy/persistence contract test, not a PostgreSQL or transport integration.
function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (key === "OR") return (value as unknown[]).some(item => matches(row, item));
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item, value));
    if (key === "none") return Array.isArray(row) && !row.some(item => matches(item, value));
    if (key === "not") return !matches(row, value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (key === "has") return Array.isArray(row) && row.includes(value);
    if (key === "isEmpty") return Array.isArray(row) && (row.length === 0) === value;
    if (!row || typeof row !== "object" || !(key in row)) throw new Error(`Unsupported predicate: ${key}`);
    return matches((row as Record<string, unknown>)[key], value);
  });
}

function fixture() {
  const ids = ["author", "selected", "neighbor", "leader", "dept-leader", "other-leader", "watcher", "scoped", "admin"];
  const actors = new Map(ids.map(id => [id, { id, globalRole: id === "admin" ? "ADMIN" : "USER", isBlocked: false, blockedAt: null as Date | null, primaryDepartmentId: ["selected", "neighbor"].includes(id) ? "department" : null }]));
  const department = { id: "department", leaderId: "dept-leader", archivedAt: null as Date | null,
    get employees() { return [...actors.values()].filter(actor => actor.primaryDepartmentId === "department"); } };
  const project = { id: "board", departmentId: "department", ownerId: "leader", members: [{ userId: "leader" }],
    department: department as typeof department | null,
    responsibleGroup: { leaderId: "leader", archivedAt: null as Date | null,
      members: ids.filter(id => id !== "dept-leader" && id !== "watcher").map(userId => ({ userId })) } };
  const record = { id: "task", projectId: "board", project, createdById: "author", assignees: [], watchers: [{ userId: "watcher" }],
    request: { contractVersion: 1, authorId: "author", executorId: null, deletedAt: null, state: "SUBMITTED", audienceUserIds: ["selected"] } };
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: `n-${data.userId}`, read: false, readAt: null, createdAt: new Date() }));
  const executors = new Set(["selected", "neighbor"]);
  const db = {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => actors.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; globalRole?: string } }) => where.id.in.map(id => actors.get(id)).filter(actor => actor && (!where.globalRole || actor.globalRole === where.globalRole))) },
    project: { findMany: vi.fn(async () => [{ id: "board" }]), findUnique: vi.fn(async () => ({ ...project, departmentId: "department", responsibleGroupId: "group" })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
      (executors.has(where.userId) || ["scoped", "leader", "other-leader"].includes(where.userId)) ? [{ id: "grant", userId: where.userId, profileId: "profile", scopeKind: "organization", projectId: null, departmentId: null,
        profile: { archivedAt: null, permissions: executors.has(where.userId) ? ["request.execute"] : ["request.read"] } }] : []) },
    task: {
      findFirst: vi.fn(async ({ where }: { where: unknown }) => matches(record, where) ? { id: record.id } : null),
      findMany: vi.fn(async ({ where }: { where: unknown }) => matches(record, where) ? [{ id: record.id,projectId:record.projectId }] : []),
    },
    notification: { create, findMany: vi.fn(async ({ where }: { where: { userId: string } }) => [{
      ...notification(where.userId), id: `old-${where.userId}`, read: false, readAt: null, createdAt: new Date(),
    }]) },
  };
  const client = db as unknown as Parameters<typeof persistNotificationsWithClient>[0];
  bridge.database = { ...db, $transaction: async (run: (tx: typeof client) => Promise<unknown>) => run(client) };
  return { ids, actors, record, db, client, create, revokeExecutor(userId: string) { executors.delete(userId); }, grantExecutor(userId: string) { executors.add(userId); actors.get(userId)!.primaryDepartmentId = "department"; } };
}

const notification = (userId: string): CreateNotificationParams => ({ userId, type: "task_assigned", title: "synthetic-private-title",
  message: "synthetic-private-message", actionUrl: "/projects/board/board?task=task", metadata: { taskId: "task", projectId: "board" } });

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", ""); });
afterEach(() => vi.unstubAllEnvs());

describe("audience caps notification persistence", () => {
  it.each(["removed", "draft", "deleted"])("rechecks an outsider watcher for feed/native/socket delivery after %s", async change => {
    const f = fixture();
    expect(f.record.project.responsibleGroup.members).not.toContainEqual({ userId: "watcher" });
    expect((await persistNotificationsWithClient(f.client, [notification("watcher")])).map(row => row.userId)).toEqual(["watcher"]);
    expect(await isNotificationVisible(notification("watcher"))).toBe(true);
    expect(await getUnreadCount("watcher")).toBe(1);
    expect(await getNotifications("watcher")).toHaveLength(1);
    const socket: VisibilitySocket = { id: "watcher-socket", data: { userId: "watcher" }, rooms: new Set(["watcher-socket", "task:task", "user:watcher"]),
      emit: vi.fn(), leave: vi.fn(function (this: VisibilitySocket, room: string) { this.rooms.delete(room); }) };
    const delivery = createVisibilityDelivery({ sockets: () => [socket],
      canReadTask: async (_userId, taskId) => { await requireTaskRead({ id: "watcher", globalRole: "USER" }, taskId, f.client); return true; },
      canReadProject: async () => false, canReadNotification: isNotificationVisible,
    });
    const payload = { id: "task", taskId: "task", title: "synthetic-private-title" };
    await delivery.task("task", "task:updated", payload);
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith("task:updated", payload);
    f.create.mockClear(); vi.mocked(socket.emit).mockClear();
    if (change === "removed") f.record.watchers = [];
    if (change === "draft") f.record.request.state = "DRAFT";
    if (change === "deleted") Object.assign(f.record.request, { deletedAt: new Date() });
    await expect(createNotification(notification("watcher"))).resolves.toBeNull();
    expect(f.create).not.toHaveBeenCalled();
    expect(await isNotificationVisible(notification("watcher"))).toBe(false);
    expect(await getUnreadCount("watcher")).toBe(0);
    expect(await getNotifications("watcher")).toEqual([]);
    await delivery.dispatch("notification:new", "user:watcher", notification("watcher"));
    expect(socket.emit).not.toHaveBeenCalled();
    await delivery.task("task", "task:updated", payload);
    expect(socket.emit).not.toHaveBeenCalledWith("task:updated", expect.anything());
    expect(socket.emit).toHaveBeenCalledWith("auth.revoked", { userId: "watcher", reason: "task-access-revoked" });
    expect(bridge.emit).not.toHaveBeenCalled();
  });
  it("admits selected eligible executors and personal readers, denying leadership and read profiles alone", async () => {
    const f = fixture();
    const created = await persistNotificationsWithClient(f.client, f.ids.map(notification));
    expect(created.map(row => row.userId)).toEqual(["author", "selected", "watcher", "admin"]);
    expect(f.create.mock.calls.map(([{ data }]) => data.userId)).toEqual(["author", "selected", "watcher", "admin"]);
    expect(bridge.emit).not.toHaveBeenCalled();
    expect(f.db.project.findMany).toHaveBeenCalledWith({ where: { id: "board" }, select: { id: true } });
  });

  it("retains only explicit eligible department executors and personal readers for general tasks", async () => {
    const f = fixture(); f.record.request.audienceUserIds = [];
    expect(await filterTaskNotificationRecipientIds(f.client, "task", "board", f.ids)).toEqual(["author", "selected", "neighbor", "watcher", "admin"]);
  });

  it("rechecks identity, block status and task visibility for every later write", async () => {
    const f = fixture();
    expect(await filterTaskNotificationRecipientIds(f.client, "task", "board", ["selected", "selected"])).toEqual(["selected"]);
    f.actors.get("selected")!.isBlocked = true;
    f.actors.get("admin")!.globalRole = "USER";
    expect(await persistNotificationsWithClient(f.client, [notification("selected"), notification("admin"), notification("missing")])).toEqual([]);
    expect(f.create).not.toHaveBeenCalled();
    f.actors.get("selected")!.isBlocked = false;
    f.record.project.responsibleGroup.members = [];
    f.actors.get("selected")!.primaryDepartmentId = null;
    expect(await filterTaskNotificationRecipientIds(f.client, "task", "board", ["selected"])).toEqual([]);
  });

  it("keeps internal notification recipients subject to the task cap too", async () => {
    const f = fixture();
    const rows = ["selected", "leader", "dept-leader", "other-leader", "watcher"].map(userId => ({ ...notification(userId), type: "chat_message" as const,
      metadata: { taskId: "task", projectId: "board", visibility: "INTERNAL" } }));
    expect((await persistNotificationsWithClient(f.client, rows)).map(row => row.userId)).toEqual(["selected"]);
  });

  it("rechecks an internal role before storing content even when the revoked employee remains a personal watcher", async () => {
    const f = fixture();
    const internal = { ...notification("watcher"), type: "chat_message" as const,
      metadata: { taskId: "task", projectId: "board", visibility: "INTERNAL" } };
    f.record.project.responsibleGroup.members.push({ userId: "watcher" });
    expect((await persistNotificationsWithClient(f.client, [internal])).map(row => row.userId)).toEqual(["watcher"]);
    f.record.project.responsibleGroup.members = f.record.project.responsibleGroup.members.filter(member => member.userId !== "watcher");
    f.create.mockClear();
    expect(await persistNotificationsWithClient(f.client, [internal])).toEqual([]);
    expect(f.create).not.toHaveBeenCalled();
    expect(await isNotificationVisible(internal)).toBe(false);
    expect((await persistNotificationsWithClient(f.client, [notification("watcher")])).map(row => row.userId)).toEqual(["watcher"]);
  });

  it("filters single and bulk public APIs before persistence and delivers only exact allowed rows", async () => {
    const f = fixture();
    await expect(createNotification(notification("neighbor"))).resolves.toBeNull();
    expect(f.create).not.toHaveBeenCalled(); expect(bridge.emit).not.toHaveBeenCalled();
    await expect(createNotifications([notification("neighbor"), notification("selected")])).resolves.toEqual({ count: 1 });
    expect(bridge.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "selected", id: "n-selected" }));
  });

  it("revalidates old stored notifications for bell counts, feed and native socket delivery", async () => {
    const f = fixture();
    for (const userId of f.ids) {
      const allowed = ["author", "selected", "watcher", "admin"].includes(userId);
      expect(await isNotificationVisible(notification(userId))).toBe(allowed);
      expect(await getUnreadCount(userId)).toBe(allowed ? 1 : 0);
      expect(await getNotifications(userId)).toHaveLength(allowed ? 1 : 0);
    }
  });

  it.each(["task:created", "task:updated", "task:moved", "message:new"])("never sends private IDs/content to other project room members through %s", async event => {
    const f = fixture();
    const sockets: VisibilitySocket[] = f.ids.map(userId => ({ id: `socket-${userId}`, data: { userId },
      rooms: new Set([`socket-${userId}`, "project:board"]), emit: vi.fn(), leave: vi.fn() }));
    const delivery = createVisibilityDelivery({ sockets: () => sockets,
      canReadTask: async (userId, taskId) => {
        const actor = f.actors.get(userId);
        if (!actor) return false;
        await requireTaskRead(actor as { id: string; globalRole: "USER" | "ADMIN" }, taskId, f.client);
        return true;
      },
      canReadProject: async () => true, canReadNotification: isNotificationVisible,
    });
    const payload = { id: "task", taskId: "task", task: { id: "task" }, title: "synthetic-private-title", attachments: [{ name: "synthetic-private-file" }] };
    await delivery.dispatch(event, "project:board", payload);
    for (const socket of sockets) {
      if (["author", "selected", "watcher", "admin"].includes(socket.data.userId!)) expect(socket.emit).toHaveBeenCalledExactlyOnceWith(event, payload);
      else expect(socket.emit).not.toHaveBeenCalled();
    }
    // Even the eventual deletion must not reveal a never-visible personal ID.
    await delivery.dispatch("task:deleted", "project:board", { taskId: "task" });
    for (const socket of sockets.filter(socket => !["author", "selected", "watcher", "admin"].includes(socket.data.userId!))) {
      expect(socket.emit).not.toHaveBeenCalled();
    }
  });

  it("denies the active destination department leader without execution eligibility", async () => {
    const f = fixture();
    expect(f.record.project.responsibleGroup.members).not.toContainEqual({ userId: "dept-leader" });
    expect(f.record.project.members).not.toContainEqual({ userId: "dept-leader" });
    expect(await filterTaskNotificationRecipientIds(f.client, "task", "board", ["dept-leader", "other-leader"])).toEqual([]);
    expect(await f.db.scopedPrivilegeAssignment.findMany({ where: { userId: "dept-leader" } })).toEqual([]);
  });

  it.each(["leader-changed", "department-archived", "department-missing", "draft"])("eligible executor loses the private department-leader audience exception after %s for persistence, stored feed, native policy and an open socket", async change => {
    const f = fixture();
    f.grantExecutor("dept-leader");
    const socket: VisibilitySocket = { id: "department-leader-socket", data: { userId: "dept-leader" }, rooms: new Set(["department-leader-socket", "project:board"]),
      emit: vi.fn(), leave: vi.fn(function (this: VisibilitySocket, room: string) { this.rooms.delete(room); }) };
    const delivery = createVisibilityDelivery({ sockets: () => [socket],
      canReadTask: async (_userId, taskId) => { await requireTaskRead({ id: "dept-leader", globalRole: "USER" }, taskId, f.client); return true; },
      canReadProject: async () => true, canReadNotification: isNotificationVisible,
    });
    const payload = { id: "task", title: "synthetic-private-title" };
    expect((await persistNotificationsWithClient(f.client, [notification("dept-leader")])).map(row => row.userId)).toEqual(["dept-leader"]);
    await delivery.dispatch("task:updated", "project:board", payload);
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith("task:updated", payload);
    f.create.mockClear(); vi.mocked(socket.emit).mockClear();
    if (change === "leader-changed") f.record.project.department!.leaderId = "replacement";
    if (change === "department-archived") f.record.project.department!.archivedAt = new Date();
    if (change === "department-missing") f.record.project.department = null;
    if (change === "draft") f.record.request.state = "DRAFT";
    await expect(createNotification(notification("dept-leader"))).resolves.toBeNull();
    expect(f.create).not.toHaveBeenCalled();
    expect(await isNotificationVisible(notification("dept-leader"))).toBe(false);
    expect(await getUnreadCount("dept-leader")).toBe(0);
    expect(await getNotifications("dept-leader")).toEqual([]);
    await delivery.dispatch("task:updated", "project:board", payload);
    expect(socket.emit).not.toHaveBeenCalledWith("task:updated", expect.anything());
    expect(socket.emit).toHaveBeenCalledWith("auth.revoked", { userId: "dept-leader", reason: "task-access-revoked" });
    expect(bridge.emit).not.toHaveBeenCalled();
  });

  it.each(["membership-removed", "leader-changed", "group-archived"])("eligible executor loses the private group-leader audience exception after %s for persistence, stored feed, native policy and an open socket", async change => {
    const f = fixture();
    f.grantExecutor("leader");
    const socket: VisibilitySocket = { id: "leader-socket", data: { userId: "leader" }, rooms: new Set(["leader-socket", "project:board"]),
      emit: vi.fn(), leave: vi.fn(function (this: VisibilitySocket, room: string) { this.rooms.delete(room); }) };
    const delivery = createVisibilityDelivery({ sockets: () => [socket],
      canReadTask: async (_userId, taskId) => { await requireTaskRead({ id: "leader", globalRole: "USER" }, taskId, f.client); return true; },
      canReadProject: async () => true, canReadNotification: isNotificationVisible,
    });
    const payload = { id: "task", title: "synthetic-private-title" };
    expect((await persistNotificationsWithClient(f.client, [notification("leader")])).map(row => row.userId)).toEqual(["leader"]);
    await delivery.dispatch("task:updated", "project:board", payload);
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith("task:updated", payload);
    f.create.mockClear(); vi.mocked(socket.emit).mockClear();
    if (change === "membership-removed") f.record.project.responsibleGroup.members = f.record.project.responsibleGroup.members.filter(member => member.userId !== "leader");
    if (change === "leader-changed") f.record.project.responsibleGroup.leaderId = "replacement";
    if (change === "group-archived") f.record.project.responsibleGroup.archivedAt = new Date();
    await expect(createNotification(notification("leader"))).resolves.toBeNull();
    expect(f.create).not.toHaveBeenCalled();
    expect(await isNotificationVisible(notification("leader"))).toBe(false);
    expect(await getUnreadCount("leader")).toBe(0);
    expect(await getNotifications("leader")).toEqual([]);
    await delivery.dispatch("task:updated", "project:board", payload);
    expect(socket.emit).not.toHaveBeenCalledWith("task:updated", expect.anything());
    expect(socket.emit).toHaveBeenCalledWith("auth.revoked", { userId: "leader", reason: "task-access-revoked" });
    expect(bridge.emit).not.toHaveBeenCalled();
  });

  it("denies inconsistent/missing task references without persisting content", async () => {
    const f = fixture();
    const input = notification("selected");
    const malformed = [{ ...input, metadata: {} }, { ...input, metadata: { taskId: "task", projectId: "other" } },
      { ...input, actionUrl: "https://outside.invalid/task" }, { ...input, metadata: { ...input.metadata, visibility: "UNKNOWN" } }];
    expect(await persistNotificationsWithClient(f.client, malformed)).toEqual([]);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("propagates unavailable policy without writing a recipient row", async () => {
    const f = fixture(); f.db.task.findFirst.mockRejectedValueOnce(new Error("synthetic-policy-unavailable"));
    await expect(persistNotificationsWithClient(f.client, [notification("selected")])).rejects.toThrow("synthetic-policy-unavailable");
    expect(f.create).not.toHaveBeenCalled();
  });
});


it("revokes notification/feed visibility with execute while preserving personal watcher access", async () => {
  const f = fixture();
  expect(await isNotificationVisible(notification("selected"))).toBe(true);
  f.revokeExecutor("selected");
  expect(await isNotificationVisible(notification("selected"))).toBe(false);
  expect(await getUnreadCount("selected")).toBe(0);
  expect(await getNotifications("selected")).toEqual([]);
  expect(await persistNotificationsWithClient(f.client, [notification("selected")])).toEqual([]);
  f.record.watchers.push({ userId: "selected" });
  expect(await isNotificationVisible(notification("selected"))).toBe(true);
});
