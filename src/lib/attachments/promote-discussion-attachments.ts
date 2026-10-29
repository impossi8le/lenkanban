import type { Prisma } from "@prisma/client";
import { MessageAttachmentError } from "./message-attachments";
import { parseStoredAttachments, parseAttachmentFileUrl, toPublicAttachmentDTOs, type StoredAttachment } from "./task-port";

/** Existing message writer owns authorization, Task lock, version/CAS and tx.
 * This helper neither starts a transaction nor increments Task.version. A later
 * message/notification failure rolls this metadata publication back with it.
 */
export async function promoteDiscussionAttachments(
  tx: Pick<Prisma.TransactionClient, "task">,
  taskId: string,
  actorId: string,
  files: readonly StoredAttachment[],
  visibility: "PUBLIC" | "INTERNAL",
  currentRawAttachments?: unknown,
): Promise<StoredAttachment[]> {
  if (!files.length) return [];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(actorId) || (visibility !== "PUBLIC" && visibility !== "INTERNAL")) throw new MessageAttachmentError("ATTACHMENT_NOT_OWNED");
  const raw = currentRawAttachments === undefined
    ? (await tx.task.findUnique({ where: { id: taskId }, select: { attachments: true } }))?.attachments
    : currentRawAttachments;
  const stored = parseStoredAttachments(raw);
  const selected = new Set<string>();
  const promoted: StoredAttachment[] = [];
  let changed = false;
  for (const requested of files) {
    if (!parseAttachmentFileUrl(requested.url, taskId)) throw new MessageAttachmentError("ATTACHMENT_NOT_OWNED");
    if (selected.has(requested.url)) continue;
    const matches = stored.filter(file => file.url === requested.url);
    if (!matches.length || matches.some(file => file.pendingMessageAuthorId !== undefined && file.pendingMessageAuthorId !== actorId)
      || visibility === "PUBLIC" && matches.some(file => file.isInternal)) throw new MessageAttachmentError("ATTACHMENT_NOT_OWNED");
    const authoritative = matches[0];
    selected.add(requested.url);
    changed ||= matches.some(file => file.pendingMessageAuthorId !== undefined || visibility === "INTERNAL" && !file.isInternal);
    promoted.push({ ...authoritative, ...(visibility === "INTERNAL" ? { isInternal: true } : {}) });
  }
  if (changed) {
    // Preserve every unrelated raw entry/field; only the selected persisted
    // references lose pending ownership or acquire INTERNAL classification.
    const attachments = (Array.isArray(raw) ? raw : []).map(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !selected.has(String(entry.url))) return entry;
      const updated: Record<string, unknown> = { ...entry };
      delete updated.pendingMessageAuthorId;
      if (visibility === "INTERNAL") updated.isInternal = true;
      return updated;
    });
    await tx.task.update({ where: { id: taskId }, data: { attachments: attachments as Prisma.InputJsonValue } });
  }
  return toPublicAttachmentDTOs(promoted);
}
