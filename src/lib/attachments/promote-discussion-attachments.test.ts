import { beforeEach, expect, it, vi } from "vitest";
import { promoteDiscussionAttachments } from "./promote-discussion-attachments";
import { attachmentFileUrl, parseStoredAttachments, publicTaskAttachmentDTOs } from "./task-port";
const file = { url: attachmentFileUrl("task", "00000000-0000-4000-8000-000000000001"), name: "server.pdf", size: 4, mime: "application/pdf" };
const findUnique = vi.fn(), update = vi.fn();
const tx = { task: { findUnique, update } } as unknown as Parameters<typeof promoteDiscussionAttachments>[0];
beforeEach(() => { vi.resetAllMocks(); update.mockResolvedValue({}); });

it.each(["PUBLIC", "INTERNAL"] as const)("publishes only owned pending files inside the writer's transaction as %s", async visibility => {
  const raw = [{ ...file, pendingMessageAuthorId: "uploader" }, { unrelated: "preserve" }];
  expect(publicTaskAttachmentDTOs(raw)).toEqual([]);
  const result = await promoteDiscussionAttachments(tx, "task", "uploader", [{ ...file, name: "CLIENT_FORGED" }], visibility, raw);
  expect(result).toEqual([file]);
  expect(findUnique).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledExactlyOnceWith({ where: { id: "task" }, data: { attachments: [{ ...file, ...(visibility === "INTERNAL" ? { isInternal: true } : {}) }, { unrelated: "preserve" }] } });
  const persisted = update.mock.calls[0][0].data.attachments;
  expect(parseStoredAttachments(persisted)).toEqual([{ ...file, ...(visibility === "INTERNAL" ? { isInternal: true } : {}) }]);
  expect(publicTaskAttachmentDTOs(persisted)).toEqual(visibility === "PUBLIC" ? [file] : []);
  expect(JSON.stringify(update.mock.calls)).not.toContain('"version"');
  expect(JSON.stringify(result)).not.toMatch(/pendingMessageAuthorId|isInternal|CLIENT_FORGED/);
});

it("rejects another uploader's staged file, even if a duplicate public entry or forged metadata is supplied", async () => {
  for (const visibility of ["PUBLIC", "INTERNAL"] as const) {
    await expect(promoteDiscussionAttachments(tx, "task", "other", [file], visibility,
      [file, { ...file, pendingMessageAuthorId: "uploader" }])).rejects.toMatchObject({ code: "ATTACHMENT_NOT_OWNED" });
  }
  expect(update).not.toHaveBeenCalled();
});

it("never declassifies an existing internal duplicate into a public message", async () => {
  await expect(promoteDiscussionAttachments(tx, "task", "uploader", [file], "PUBLIC",
    [{ ...file, pendingMessageAuthorId: "uploader" }, { ...file, isInternal: true }])).rejects.toMatchObject({ code: "ATTACHMENT_NOT_OWNED" });
  expect(update).not.toHaveBeenCalled();
});

it("uses persisted metadata and leaves an existing public reference unchanged on replay", async () => {
  findUnique.mockResolvedValue({ attachments: [file] });
  expect(await promoteDiscussionAttachments(tx, "task", "uploader", [{ ...file, name: "forged" }], "PUBLIC")).toEqual([file]);
  expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "task" }, select: { attachments: true } });
  expect(update).not.toHaveBeenCalled();
});

it("propagates metadata persistence failures for rollback and never mutates the caller's raw snapshot", async () => {
  const raw = [{ ...file, pendingMessageAuthorId: "uploader" }];
  update.mockRejectedValue(new Error("synthetic write failure"));
  await expect(promoteDiscussionAttachments(tx, "task", "uploader", [file], "INTERNAL", raw)).rejects.toThrow("synthetic write failure");
  expect(raw).toEqual([{ ...file, pendingMessageAuthorId: "uploader" }]);
});
