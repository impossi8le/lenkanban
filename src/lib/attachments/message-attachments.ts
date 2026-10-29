import { MAX_UPLOAD_FILES } from "./upload-validation";
import {
  attachmentBelongsToTask,
  parseAttachmentFileUrl,
  parseStoredAttachments,
  type StoredAttachment,
} from "./task-port";

export type MessageAttachmentInput = {
  url: string;
  name: string;
  size: number;
  mime: string;
};

export class MessageAttachmentError extends Error {
  constructor(readonly code: "ATTACHMENT_NOT_OWNED" | "TOO_MANY_ATTACHMENTS") {
    super(code === "TOO_MANY_ATTACHMENTS" ? "Too many message attachments" : "Message attachment is not owned by this task");
    this.name = "MessageAttachmentError";
  }
}

/**
 * Resolves message attachments against the current committed Task.attachments.
 *
 * The client URL must be the exact canonical `/api/tasks/{taskId}/files/{uuid}`
 * for this task and must already be present in the task metadata. A foreign,
 * external or merely well-shaped URL is never accepted, and the stored DTO is
 * returned so the client cannot substitute its own name/size/mime. This helper
 * is the integration point for the socket writer; the HTTP route calls it
 * inside the same transaction as the message insert.
 */
export function resolveMessageAttachments(
  input: readonly MessageAttachmentInput[],
  storedAttachments: unknown,
  taskId: string,
): StoredAttachment[] {
  if (input.length === 0) return [];
  if (input.length > MAX_UPLOAD_FILES) throw new MessageAttachmentError("TOO_MANY_ATTACHMENTS");
  const stored = parseStoredAttachments(storedAttachments);
  const resolved: StoredAttachment[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const fileId = parseAttachmentFileUrl(item.url, taskId);
    if (!fileId) throw new MessageAttachmentError("ATTACHMENT_NOT_OWNED");
    const match = attachmentBelongsToTask(stored, taskId, fileId);
    if (!match) throw new MessageAttachmentError("ATTACHMENT_NOT_OWNED");
    if (seen.has(match.url)) continue;
    seen.add(match.url);
    resolved.push(match);
  }
  return resolved;
}
