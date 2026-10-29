import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotification } from "./notifications";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  notification: { create: vi.fn() },
  user: { findUnique: vi.fn() }, task: { findFirst: vi.fn() },
  emit: vi.fn(),
  diagnostic: vi.fn(),
}));
vi.mock("./project-access", () => ({ getTaskReadWhere: async (_actor: unknown, filters: unknown) => filters }));
vi.mock("./prisma", () => ({ prisma: db }));
vi.mock("./logger", () => ({ socketLogger: { error: db.diagnostic } }));
vi.mock("@/socket/board-events", () => ({ emitUserNotification: db.emit }));

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, globalRole: "USER", isBlocked: false, blockedAt: null }));
  db.task.findFirst.mockResolvedValue({ id: "task" });
  db.$queryRaw.mockResolvedValue([{ count: 1 }]);
  db.notification.create.mockImplementation(async ({ data }) => ({ id: "notification-1", ...data }));
  db.emit.mockImplementation(() => {});
  db.diagnostic.mockImplementation(() => {});
});

describe("notification recipient rate limit", () => {
  it("creates a notification using a distinct recipient bucket, without a Request", async () => {
    for (const userId of ["recipient-a", "recipient-b"]) {
      const result = await createNotification({ userId, type: "task_assigned", title: "Задача", message: "Назначена задача", metadata: { taskId: "task", projectId: "project" } });
      expect(result?.userId).toBe(userId);
      expect(db.$queryRaw.mock.calls.some(call => call.slice(1).includes(`notifications:create:${userId}`))).toBe(true);
    }
    expect(db.notification.create).toHaveBeenCalledTimes(2);
  });

  it("does not persist a notification when the recipient limit is exhausted", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(createNotification({ userId: "recipient-a", type: "task_assigned", title: "Задача", message: "Назначена задача", metadata: { taskId: "task", projectId: "project" } }))
      .rejects.toMatchObject({ status: 429 });
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("returns a committed single notification even when delivery and diagnostics throw", async () => {
    db.emit.mockImplementation(() => { throw new Error("Synthetic bridge failure"); });
    db.diagnostic.mockImplementation(() => { throw new Error("Synthetic sink failure"); });
    await expect(createNotification({ userId: "recipient-a", type: "task_assigned", title: "Задача", message: "Назначена задача", metadata: { taskId: "task", projectId: "project" } }))
      .resolves.toMatchObject({ id: "notification-1", userId: "recipient-a" });
    expect(db.notification.create).toHaveBeenCalledOnce();
    expect(db.emit).toHaveBeenCalledOnce();
  });
});
