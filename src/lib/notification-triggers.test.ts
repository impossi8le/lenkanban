import { beforeEach, describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { id: "prisma-client" } }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-notifications", () => ({
  dispatchQueueNotifications: queue.dispatch,
}));
vi.mock("@/lib/notifications", () => ({
  createNotification: vi.fn(),
  createNotifications: vi.fn(),
}));

import { notifyTaskRequestQueueEntered, notifyTaskTakenOver } from "./notification-triggers";
import { createNotification } from "./notifications";

beforeEach(() => {
  vi.resetAllMocks();
  queue.dispatch.mockResolvedValue(["group-member"]);
});

it("notifies the previous executor through the shared ACL notification channel without request content", async () => {
  const input = { taskId: "task", projectId: "project", previousExecutorId: "previous", actorId: "replacement", actorName: "Замещающий сотрудник" };
  await notifyTaskTakenOver(input);
  expect(createNotification).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "previous", type: "task_assigned",
    actionUrl: "/projects/project/board?task=task", metadata: { taskId: "task", projectId: "project", assignedById: "replacement" } }));
  vi.mocked(createNotification).mockClear();
  await notifyTaskTakenOver({ ...input, previousExecutorId: "replacement" });
  expect(createNotification).not.toHaveBeenCalled();
});

describe("queue-entry notification trigger", () => {
  it("delegates to the existing discussion notification module", async () => {
    const recipients = await notifyTaskRequestQueueEntered({
      taskId: "task",
      projectId: "project",
      actorId: "author",
      actorName: "Автор",
    });

    expect(recipients).toEqual(["group-member"]);
    expect(queue.dispatch).toHaveBeenCalledExactlyOnceWith({
      db: { id: "prisma-client" },
      taskId: "task",
      actorId: "author",
      actorName: "Автор",
    });
  });

  it("passes the actor through so the actor is never notified of their own action", async () => {
    await notifyTaskRequestQueueEntered({
      taskId: "task",
      projectId: "project",
      actorId: "actor-1",
      actorName: "Исполнитель",
    });
    expect(queue.dispatch.mock.calls[0]?.[0]).toMatchObject({ actorId: "actor-1" });
  });
});
