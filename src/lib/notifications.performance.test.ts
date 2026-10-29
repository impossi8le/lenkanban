import type { Notification } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({
  rows: vi.fn(), user: vi.fn(), taskMany: vi.fn(), taskFirst: vi.fn(),
  projectMany: vi.fn(), allowed: vi.fn(), where: vi.fn(),
  calls: [] as string[],
}));

vi.mock("./prisma", () => ({ prisma: {
  notification: { findMany: stub.rows, findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  user: { findUnique: stub.user },
  task: { findMany: stub.taskMany, findFirst: stub.taskFirst },
  project: { findMany: stub.projectMany },
} }));
vi.mock("./project-access", () => ({ getProjectAccess: vi.fn(), getTaskReadWhere: stub.where }));
vi.mock("./auth", () => ({ isAccountAllowed: stub.allowed }));
vi.mock("./logger", () => ({ socketLogger: { error: vi.fn() } }));
vi.mock("@/socket/board-events", () => ({ emitUserNotification: vi.fn() }));

import { getNotifications, getUnreadCount } from "./notifications";

const row = (id: string, taskId = `task-${id}`, userId = "alice"): Notification => ({
  id, userId, type: "task_assigned", title: "private title", message: "private message",
  actionUrl: `/projects/board/board?task=${taskId}`, metadata: { projectId: "board", taskId },
  read: false, readAt: null, createdAt: new Date("2026-10-21T10:00:00Z"),
});

beforeEach(() => {
  vi.resetAllMocks();
  stub.calls.length = 0;
  stub.allowed.mockImplementation(async () => { stub.calls.push("isAccountAllowed"); return true; });
  stub.user.mockImplementation(async ({ where }: { where: { id: string } }) => {
    stub.calls.push("user.findUnique");
    return { id: where.id, globalRole: "USER" };
  });
  stub.where.mockImplementation(async (actor: { id: string }, filters: object) => ({ actor: actor.id, ...filters }));
  stub.taskMany.mockImplementation(async () => { stub.calls.push("task.findMany"); return []; });
  stub.taskFirst.mockImplementation(async () => { stub.calls.push("task.findFirst"); return null; });
  stub.projectMany.mockImplementation(async () => { stub.calls.push("project.findMany"); return []; });
  stub.rows.mockImplementation(async () => { stub.calls.push("notification.findMany"); return []; });
});
afterEach(() => vi.unstubAllEnvs());

describe("notification visibility costs a constant number of queries", () => {
  it("loads every referenced task in one query for fifty unread notifications", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(`n${index}`));
    stub.rows.mockImplementation(async () => { stub.calls.push("notification.findMany"); return rows; });
    stub.taskMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      stub.calls.push("task.findMany");
      return where.id.in.map(id => ({ id, projectId: "board" }));
    });

    await expect(getUnreadCount("alice")).resolves.toBe(50);

    // One notification read, one account-status probe, one recipient read and
    // one task read — independent of how many notifications the user has.
    expect(stub.calls).toEqual([
      "notification.findMany", "isAccountAllowed", "user.findUnique", "task.findMany",
    ]);
    expect(stub.taskFirst).not.toHaveBeenCalled();
    expect(stub.allowed).toHaveBeenCalledTimes(1);
    expect(stub.user).toHaveBeenCalledTimes(1);
  });

  it("still hides a notification whose task the reader cannot see", async () => {
    const hidden = row("hidden", "secret-task");
    const visible = row("visible");
    stub.rows.mockImplementation(async () => { stub.calls.push("notification.findMany"); return [hidden, visible]; });
    stub.taskMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      stub.calls.push("task.findMany");
      // The shared predicate returns only the readable task; the hidden one is
      // filtered inside the database by getTaskReadWhere, never in memory.
      return where.id.in.filter(id => id !== "secret-task").map(id => ({ id, projectId: "board" }));
    });

    await expect(getUnreadCount("alice")).resolves.toBe(1);
    expect(await getNotifications("alice")).toEqual([visible]);
    const [taskQuery] = stub.taskMany.mock.calls[0];
    expect(taskQuery.where.id).toEqual({ in: ["secret-task", "task-visible"] });
    expect(stub.where).toHaveBeenCalledWith({ id: "alice", globalRole: "USER" }, { id: { in: ["secret-task", "task-visible"] } }, expect.objectContaining({task:expect.objectContaining({findMany:stub.taskMany})}));
  });

  it("rejects every row of a blocked account without reading tasks", async () => {
    stub.rows.mockImplementation(async () => { stub.calls.push("notification.findMany"); return [row("a"), row("b")]; });
    stub.allowed.mockImplementation(async () => { stub.calls.push("isAccountAllowed"); return false; });

    await expect(getUnreadCount("alice")).resolves.toBe(0);
    expect(stub.calls).toEqual(["notification.findMany", "isAccountAllowed"]);
    expect(stub.taskMany).not.toHaveBeenCalled();
  });

  it("resolves project notifications with one project read instead of one per row", async () => {
    const projectRow = (id: string, projectId: string): Notification => ({
      ...row(id), type: "project_member_added", actionUrl: `/projects/${projectId}/board`,
      metadata: { projectId },
    });
    stub.rows.mockImplementation(async () => {
      stub.calls.push("notification.findMany");
      return [projectRow("p1", "board-one"), projectRow("p2", "board-two")];
    });
    stub.projectMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      stub.calls.push("project.findMany");
      return where.id.in
        .filter(id => id === "board-one")
        .map(id => ({ id, ownerId: "alice", members: [] }));
    });

    await expect(getUnreadCount("alice")).resolves.toBe(1);
    expect(stub.calls.filter(name => name === "project.findMany")).toHaveLength(1);
  });
});

describe("notification list applies its window in the database", () => {
  it("paginates visible rows while issuing a bounded query", async () => {
    const all = [row("hidden-1", "secret-1"), row("first"), row("second"), row("hidden-2", "secret-2"), row("third")];
    stub.rows.mockImplementation(async ({ skip = 0, take }: { skip?: number; take?: number }) => {
      stub.calls.push("notification.findMany");
      return all.slice(skip, take === undefined ? undefined : skip + take);
    });
    stub.taskMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      stub.calls.push("task.findMany");
      return where.id.in.filter(id => !id.startsWith("secret")).map(id => ({ id, projectId: "board" }));
    });

    // Visibility is applied before offsets, exactly as before the change.
    await expect(getNotifications("alice", { limit: 2, offset: 1 })).resolves.toEqual([
      all[2], all[4],
    ]);
    const firstQuery = stub.rows.mock.calls[0][0];
    expect(firstQuery.take).toBeGreaterThan(0);
    expect(firstQuery.skip).toBe(0);
  });
});
