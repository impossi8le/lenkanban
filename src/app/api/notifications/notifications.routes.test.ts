import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireApiUser: vi.fn(),
    getNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
    getUnreadCount: vi.fn(),
    getUnreadNotificationSummary: vi.fn(),
    findUnique: vi.fn(),
    logger: { error: vi.fn() },
  };
});

vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: mocks.UnauthorizedError,
}));
vi.mock("@/lib/notifications", () => ({
  getNotifications: mocks.getNotifications,
  markNotificationRead: mocks.markNotificationRead,
  markAllNotificationsRead: mocks.markAllNotificationsRead,
  getUnreadCount: mocks.getUnreadCount,
  getUnreadNotificationSummary: mocks.getUnreadNotificationSummary,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { notification: { findUnique: mocks.findUnique } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: mocks.logger }));

import { GET } from "./route";
import { PATCH as PATCH_ITEM } from "./[id]/route";
import { PATCH as PATCH_ALL } from "./mark-all-read/route";
import { GET as GET_UNREAD } from "./unread-count/route";

const user = { id: "actor-1", globalRole: "USER" };
const request = (url = "http://localhost/api/notifications") => new NextRequest(url);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue(user);
  mocks.getNotifications.mockResolvedValue([]);
  mocks.markNotificationRead.mockResolvedValue({ id: "notice-1", read: true });
  mocks.markAllNotificationsRead.mockResolvedValue({ count: 0 });
  mocks.getUnreadCount.mockResolvedValue(0);
  mocks.getUnreadNotificationSummary.mockResolvedValue({actorId:user.id,count:0,byProject:{},byTask:{},unscopedCount:0});
});

describe("notification HTTP access is scoped to the authenticated actor", () => {
  it.each([
    ["list", () => GET(request())],
    ["mark all", () => PATCH_ALL(request())],
    ["unread count", () => GET_UNREAD(request())],
  ])("rejects an unauthenticated %s request", async (_name, call) => {
    mocks.requireApiUser.mockRejectedValue(new mocks.UnauthorizedError());
    const response = await call();
    expect(response.status).toBe(401);
  });

  it("lists only the authenticated user's notifications", async () => {
    const response = await GET(request("http://localhost/api/notifications?limit=5&offset=10&unreadOnly=true"));
    expect(response.status).toBe(200);
    expect(mocks.getNotifications).toHaveBeenCalledExactlyOnceWith("actor-1", {
      limit: 5, offset: 10, unreadOnly: true,
    });
  });

  it("marks all notifications only for the authenticated user", async () => {
    const response = await PATCH_ALL(request());
    expect(response.status).toBe(200);
    expect(mocks.markAllNotificationsRead).toHaveBeenCalledExactlyOnceWith("actor-1");
  });

  it("counts unread notifications only for the authenticated user", async () => {
    const response = await GET_UNREAD(request());
    expect(response.status).toBe(200);
    expect(mocks.getUnreadNotificationSummary).toHaveBeenCalledExactlyOnceWith("actor-1");
  });

  it("refuses to mark another user's notification without writing", async () => {
    mocks.findUnique.mockResolvedValue({ userId: "other-user" });
    const response = await PATCH_ITEM(request(), { params: Promise.resolve({ id: "notice-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.markNotificationRead).not.toHaveBeenCalled();
  });

  it("hides a missing notification without writing", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PATCH_ITEM(request(), { params: Promise.resolve({ id: "notice-1" }) });
    expect(response.status).toBe(404);
    expect(mocks.markNotificationRead).not.toHaveBeenCalled();
  });

  it("marks the authenticated user's own notification", async () => {
    mocks.findUnique.mockResolvedValue({ userId: "actor-1" });
    const response = await PATCH_ITEM(request(), { params: Promise.resolve({ id: "notice-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.markNotificationRead).toHaveBeenCalledExactlyOnceWith("notice-1", "actor-1");
  });

  it("hides an owned notification when its task is no longer visible", async () => {
    mocks.findUnique.mockResolvedValue({ userId: "actor-1" });
    mocks.markNotificationRead.mockResolvedValue(null);
    const response = await PATCH_ITEM(request(), { params: Promise.resolve({ id: "notice-1" }) });
    expect(response.status).toBe(404);
    expect(mocks.markNotificationRead).toHaveBeenCalledExactlyOnceWith("notice-1", "actor-1");
  });

  it("logs a safe named event without leaking the thrown error", async () => {
    const failure = new Error("synthetic-private-notification-content");
    mocks.getNotifications.mockRejectedValue(failure);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { event: "notifications.list.failed", err: failure },
      "Failed to fetch notifications",
    );
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private");
  });
});
