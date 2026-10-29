import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ content: vi.fn(), legacy: vi.fn() }));
vi.mock("@/features/kanban/server/task-lifecycle-service", () => ({ authorizeTaskRequestContentWrite: calls.content }));
vi.mock("@/lib/task-command", async original => ({ ...await original<typeof import("@/lib/task-command")>(), prepareLegacyTaskScalarBatch: calls.legacy }));
import { prepareTaskAttachmentWrite } from "./write-access";
beforeEach(() => { vi.resetAllMocks(); calls.legacy.mockResolvedValue([{ projectId: "project" }]); });
function input(presence: unknown) {
  return { tx: { taskRequest: { findUnique: vi.fn().mockResolvedValue(presence) } } as unknown as Prisma.TransactionClient,
    actorId: "actor", taskId: "task", expectedProjectId: "project" };
}
it("uses presence only for dispatch and delegates marked authority to the shared content helper", async () => {
  calls.content.mockResolvedValue({ allowed: true, marked: true, state: "NEEDS_INFO" });
  const args = input({ taskId: "task" });
  expect(await prepareTaskAttachmentWrite(args)).toEqual({ marked: true, projectId: "project" });
  expect(calls.content).toHaveBeenCalledExactlyOnceWith({ ...args, kind: "attachment" });
  expect(calls.legacy).not.toHaveBeenCalled();
});
it("keeps legacy admission and a newly introduced marker under the existing guard", async () => {
  const args = input(null);
  expect(await prepareTaskAttachmentWrite(args)).toEqual({ marked: false, projectId: "project" });
  expect(calls.legacy).toHaveBeenCalledExactlyOnceWith({ tx: args.tx, actorId: "actor", expectedTasks: [{ id: "task", projectId: "project" }] });
  expect(calls.content).not.toHaveBeenCalled();
  calls.legacy.mockRejectedValue(Error("guard-refused-new-marker"));
  await expect(prepareTaskAttachmentWrite(args)).rejects.toThrow("guard-refused-new-marker");
});
it("never turns removal of a dispatched marker into a legacy write grant", async () => {
  calls.content.mockResolvedValue({ allowed: true, marked: false });
  calls.legacy.mockRejectedValue(Error("fresh-legacy-ACL-denied"));
  await expect(prepareTaskAttachmentWrite(input({ taskId: "task" }))).rejects.toThrow("fresh-legacy-ACL-denied");
});
it.each(["INVALID_REQUEST_MARKER", "FORBIDDEN_ROLE", "INVALID_TRANSITION"])("preserves canonical %s denial", async code => {
  calls.content.mockResolvedValue({ allowed: false, code });
  await expect(prepareTaskAttachmentWrite(input({ taskId: "task" }))).rejects.toMatchObject({ code });
  expect(calls.legacy).not.toHaveBeenCalled();
});
it("does not convert a failed lookup or canonical admission into marker absence", async () => {
  const args = input(null);
  vi.mocked(args.tx.taskRequest.findUnique).mockRejectedValue(Error("private-storage-secret"));
  await expect(prepareTaskAttachmentWrite(args)).rejects.toThrow();
  calls.content.mockRejectedValue(Error("private-admission-secret"));
  await expect(prepareTaskAttachmentWrite(input({ taskId: "task" }))).rejects.toThrow();
  expect(calls.legacy).not.toHaveBeenCalled();
});
