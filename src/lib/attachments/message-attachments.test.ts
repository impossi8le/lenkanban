import { describe, expect, it } from "vitest";
import { MessageAttachmentError, resolveMessageAttachments } from "./message-attachments";
import { attachmentFileUrl } from "./task-port";

const taskId = "task-1";
const fileId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
const stored = { url: attachmentFileUrl(taskId, fileId), name: "report.pdf", size: 42, mime: "application/pdf" };

describe("message attachment ownership", () => {
  it("accepts only an exact canonical URL present in the task metadata", () => {
    expect(resolveMessageAttachments([{ ...stored, name: "renamed.pdf" }], [stored], taskId)).toEqual([stored]);
  });

  it("rejects a foreign, external, signed or non-canonical URL", () => {
    const urls = [
      "https://public.example/report.pdf",
      "/files/a",
      `/api/tasks/other-task/files/${fileId}`,
      `${stored.url}?signature=old`,
      `/api/tasks/${taskId}/files/%30${fileId.slice(1)}`,
      `/api/tasks/${taskId}/files/../${fileId}`,
      `/api/tasks/${taskId}/files/00000000-0000-1000-8000-000000000000`,
    ];
    for (const url of urls) {
      expect(() => resolveMessageAttachments([{ ...stored, url }], [stored], taskId))
        .toThrow(expect.objectContaining({ code: "ATTACHMENT_NOT_OWNED" }));
    }
  });

  it("rejects a canonical URL that the task does not currently contain", () => {
    expect(() => resolveMessageAttachments([stored], [], taskId))
      .toThrow(expect.objectContaining({ code: "ATTACHMENT_NOT_OWNED" }));
  });

  it("does not read client-supplied name, size or mime into the stored DTO", () => {
    const [resolved] = resolveMessageAttachments(
      [{ url: stored.url, name: "evil.html", size: 1, mime: "text/html" }], [stored], taskId,
    );
    expect(resolved).toEqual(stored);
  });

  it("caps a message at the shared five-file limit", () => {
    const six = Array.from({ length: 6 }, () => stored);
    expect(() => resolveMessageAttachments(six, [stored], taskId))
      .toThrow(expect.objectContaining({ code: "TOO_MANY_ATTACHMENTS" }));
    expect(resolveMessageAttachments([], [stored], taskId)).toEqual([]);
    expect(MessageAttachmentError).toBeTypeOf("function");
  });
});
