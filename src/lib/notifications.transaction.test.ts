import type { Notification } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const stub = vi.hoisted(() => ({ error: vi.fn(), emit: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: {} }));
vi.mock("./project-access", () => ({ getTaskReadWhere: async (_actor: unknown, filters: unknown) => filters }));
vi.mock("./logger", () => ({ socketLogger: { error: stub.error } }));
vi.mock("@/socket/board-events", () => ({ emitUserNotification: stub.emit }));
import { persistNotificationsWithClient, deliverNotifications, type CreateNotificationParams } from "./notifications";
beforeEach(() => { vi.clearAllMocks(); stub.error.mockImplementation(() => {}); stub.emit.mockImplementation(() => {}); });
const inputs: CreateNotificationParams[] = ["a", "b"].map(userId => ({ userId, type: "automation_rule", title: "synthetic-private-title", message: "synthetic-private-message", metadata: { taskId: "task", projectId: "project" } }));
const client = (create: unknown) => ({
  notification: { create },
  user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, globalRole: "USER", isBlocked: false, blockedAt: null })) },
  task: { findFirst: vi.fn(async () => ({ id: "task" })) },
} as unknown as Parameters<typeof persistNotificationsWithClient>[0]);
describe("existing notification transaction/delivery extensions", () => {
  it("returns exact sequential insert results with no recent-notification reread", async () => {
    const inserted = inputs.map((input, i) => ({ ...input, id: `exact-${i}`, createdAt: new Date(), read: false, actionUrl: null, metadata: {} }));
    const create = vi.fn().mockResolvedValueOnce(inserted[0]).mockResolvedValueOnce(inserted[1]);
    const result = await persistNotificationsWithClient(client(create), inputs);
    expect(result).toEqual(inserted); expect(result[0]).toBe(inserted[0]); expect(create).toHaveBeenCalledTimes(2); expect(stub.error).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toEqual({ data: { ...inputs[0], actionUrl: undefined } });
  });
  it("propagates insertion failure rather than returning a partial result", async () => {
    const create = vi.fn().mockResolvedValueOnce({ id: "first" }).mockRejectedValueOnce(new Error("synthetic-private-insert"));
    await expect(persistNotificationsWithClient(client(create), inputs)).rejects.toThrow("synthetic-private-insert"); expect(create).toHaveBeenCalledTimes(2);
  });
  it("attempts every supplied exact row despite throwing bridge and diagnostic sink", () => {
    const rows = inputs.map((input, i) => ({ ...input, id: `exact-${i}`, createdAt: new Date(), read: false, actionUrl: null, metadata: {} })) as Notification[];
    stub.error.mockImplementation(() => { throw new Error("sink unavailable"); });
    stub.emit.mockImplementation(() => { throw new Error("bridge unavailable"); });
    expect(() => deliverNotifications(rows)).not.toThrow();
    expect(stub.emit.mock.calls).toEqual(rows.map(row => [row]));
    expect(stub.error.mock.calls.map(([record]) => ({ userId: record.userId, notificationId: record.notificationId }))).toEqual([{ userId: "a", notificationId: "exact-0" }, { userId: "b", notificationId: "exact-1" }]);
  });
});
