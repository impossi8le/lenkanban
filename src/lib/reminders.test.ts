import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insert: vi.fn(), visible: vi.fn(), deliver: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: { notification: { createManyAndReturn: mocks.insert } } }));
vi.mock("./notifications", () => ({ isNotificationVisible: mocks.visible, deliverNotifications: mocks.deliver }));
import { createDeadlineReminders, deadlineNotificationKey } from "./reminders";

const params = { taskId: "task", taskTitle: "Задача", projectId: "project", deadline: new Date("2026-10-23T12:00:00Z"), userIds: ["one", "two"] };
beforeEach(() => { vi.resetAllMocks(); mocks.visible.mockResolvedValue(true); });

describe("deadline reminder deduplication", () => {
  it("keys task + notification type + exact deadline independently of recipient", () => {
    expect(deadlineNotificationKey("task", params.deadline)).toBe(deadlineNotificationKey("task", new Date("2026-10-23T15:00:00+03:00")));
    expect(deadlineNotificationKey("other", params.deadline)).not.toBe(deadlineNotificationKey("task", params.deadline));
    expect(deadlineNotificationKey("task", new Date("2026-10-24T12:00:00Z"))).not.toBe(deadlineNotificationKey("task", params.deadline));
  });
  it("uses the database unique PK and skipDuplicates for repeats and races; delivers only inserted rows", async () => {
    const stored = new Map<string, object>();
    mocks.insert.mockImplementation(async ({ data, skipDuplicates }) => {
      expect(skipDuplicates).toBe(true);
      const created = [];
      for (const row of data) if (!stored.has(row.id)) { stored.set(row.id, row); created.push(row); }
      return created;
    });
    const results = await Promise.all([createDeadlineReminders(params), createDeadlineReminders(params)]);
    expect(results.map(result => result.count).sort()).toEqual([0, 2]);
    expect(stored.size).toBe(2);
    expect(mocks.deliver.mock.calls.flatMap(([rows]) => rows)).toHaveLength(2);
    await createDeadlineReminders({ ...params, taskTitle: "Новое название", userIds: ["one", "one", "two"] });
    expect(stored.size).toBe(2);
    await createDeadlineReminders({ ...params, deadline: new Date("2026-10-24T12:00:00Z") });
    expect(stored.size).toBe(4);
  });
  it("does not persist or deliver notifications to unreadable tasks", async () => {
    mocks.visible.mockResolvedValue(false);
    expect(await createDeadlineReminders(params)).toEqual({ count: 0 });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
  it("does not deliver after a database failure", async () => {
    mocks.insert.mockRejectedValue(new Error("database failure"));
    await expect(createDeadlineReminders(params)).rejects.toThrow("database failure");
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
