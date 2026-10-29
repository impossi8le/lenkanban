import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ dispatch: vi.fn(), database: {} }));
vi.mock("./prisma", () => ({ prisma: api.database }));
vi.mock("./notifications", () => ({ createNotification: vi.fn(), createNotifications: vi.fn() }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-notifications", () => ({ dispatchCommentNotifications: api.dispatch, dispatchQueueNotifications: vi.fn() }));
import { notifyChatMessage } from "./notification-triggers";
beforeEach(() => { vi.resetAllMocks(); api.dispatch.mockResolvedValue(["other"]); });
const input = { taskId: "task", taskTitle: "Title", projectId: "board", authorId: "actor", authorName: "Author", messagePreview: "PRIVATE_TEXT" };
it("uses the common reader-authorized recipient policy and preserves explicit mention exclusions", async () => {
  expect(await notifyChatMessage(input)).toEqual(["other"]);
  expect(api.dispatch).toHaveBeenLastCalledWith({ db: api.database, taskId: "task", actorId: "actor", actorName: "Author", visibility: "PUBLIC", excludedRecipientIds: undefined });
  await notifyChatMessage({ ...input, excludedRecipientIds: ["mentioned"] });
  expect(api.dispatch).toHaveBeenLastCalledWith({ db: api.database, taskId: "task", actorId: "actor", actorName: "Author", visibility: "PUBLIC", excludedRecipientIds: ["mentioned"] });
  expect(JSON.stringify(api.dispatch.mock.calls)).not.toContain("PRIVATE_TEXT");
});
