import { createHash } from "node:crypto";
import {commitBeznalContentEffect} from "@/features/kanban/server/task-lifecycle-service";
import {persistTaskContentNotifications} from "@/app/api/tasks/[id]/messages/discussion-notifications";
import type { Notification, Prisma } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { logActivityWithClient } from "@/lib/activity-logger";
import { TaskCommandError } from "@/lib/task-command";
import { prepareTaskAttachmentWrite } from "./write-access";
import { parseStoredAttachments, type StoredAttachment } from "./task-port";

/** Per-task quota, independent of the per-request five-file limit. */
export const MAX_TASK_ATTACHMENTS = 100;
export const MAX_TASK_ATTACHMENT_BYTES = 500 * 1024 * 1024;

/** The task already holds the maximum number or total size of attachments. */
export class AttachmentQuotaError extends Error {
  readonly code = "ATTACHMENT_QUOTA_EXCEEDED";
  constructor() {
    super("Task attachment quota exceeded");
    this.name = "AttachmentQuotaError";
  }
}

export type AppendTaskAttachmentsInput = {
  taskId: string;
  actorId: string;
  expectedProjectId: string;
  attachments: readonly StoredAttachment[];
  /** Trusted direct invoice action only; chat staging never marks invoice readiness. */
  invoiceIntent?:boolean;
  /** Chat staging is not published work until its message commits. */
  discussionDraft?:boolean;
  /** Called immediately before the metadata write, so a caller can distinguish
   * a refusal (safe cleanup) from an ambiguous committed-or-not outcome. */
  onWriteStart?: () => void;
};

export type AppendTaskAttachmentsResult = {
  projectId: string;
  /** Attachments actually appended; empty when every URL was already present. */
  added: StoredAttachment[];
  notifications?: Notification[];
  queueRecipientIds?: string[];
};

/**
 * The single atomic attachment append: shared lock/fresh-access/marker guard,
 * current-array read, deduplicating append and mandatory Activity. Used by
 * direct upload and by chat finalize so both channels share one writer.
 */
export async function appendTaskAttachments(
  tx: Prisma.TransactionClient,
  { taskId, actorId, expectedProjectId, attachments, onWriteStart, invoiceIntent, discussionDraft }: AppendTaskAttachmentsInput,
): Promise<AppendTaskAttachmentsResult> {
  const locked = await prepareTaskAttachmentWrite({
    tx, actorId, taskId, expectedProjectId,
  });
  if (!locked) throw new NotFoundError();

  const current = await tx.task.findUnique({
    where: { id: taskId },
    select: { attachments: true, ...(locked.marked ? { version: true } : {}) },
  });
  if (!current) throw new NotFoundError();

  const existing = parseStoredAttachments(current.attachments);
  const seen = new Set(existing.map(attachment => attachment.url));
  const added: StoredAttachment[] = [];
  for (const attachment of attachments) {
    if (seen.has(attachment.url)) continue;
    seen.add(attachment.url);
    added.push(discussionDraft?{...attachment,pendingMessageAuthorId:actorId}:attachment);
  }
  if (added.length === 0) return { projectId: locked.projectId, added };

  // The shared admission holds the task lock, so this check and the
  // write below are one admission decision for concurrent appends.
  const count = existing.length + added.length;
  const bytes = [...existing, ...added].reduce((sum, attachment) => sum + attachment.size, 0);
  if (count > MAX_TASK_ATTACHMENTS || !Number.isSafeInteger(bytes) || bytes > MAX_TASK_ATTACHMENT_BYTES) {
    throw new AttachmentQuotaError();
  }

  if (locked.marked) {
    if (!Number.isInteger(current.version) || current.version < 0 || current.version >= 2147483647) {
      throw new TaskCommandError("VERSION_EXHAUSTED");
    }
    onWriteStart?.();
    const updated = await tx.task.updateMany({
      where: { id: taskId, projectId: expectedProjectId, version: current.version },
      data: { attachments: [...existing, ...added], version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new TaskCommandError("STALE_TASK_VERSION");
  } else {
    onWriteStart?.();
    await tx.task.update({ where: { id: taskId }, data: { attachments: [...existing, ...added] } });
  }
  await logActivityWithClient(tx, {
    taskId, userId: actorId, action: "attachment_added",
    newValue: { count: added.length, ...(discussionDraft?{discussionDraft:true}:{}), files: added.map(file => ({ url: file.url, isInternal: file.isInternal === true })) },
  });
  const publicFile=added.find(file=>!file.isInternal);
  const effect=!discussionDraft&&invoiceIntent===true&&locked.beznal&&publicFile?await commitBeznalContentEffect({tx,actorId,taskId,projectId:locked.projectId,kind:"invoice",public:true,invoiceUrl:publicFile.url,versionAlreadyIncremented:locked.marked}):{claimed:false,phaseChanged:false};
  const actor=discussionDraft?null:await tx.user.findUnique({where:{id:actorId},select:{name:true}});
  const notifications=discussionDraft?[]:await persistTaskContentNotifications({db:tx,taskId,actorId,actorName:actor?.name?.trim()||"Участник",visibility:added.every(file=>file.isInternal)?"INTERNAL":"PUBLIC",event:"file",eventId:createHash("sha256").update(JSON.stringify(added.map(file=>file.url).sort())).digest("hex")});
  return { projectId: locked.projectId, added, notifications, ...("queueRecipientIds" in effect?{queueRecipientIds:effect.queueRecipientIds}:{}) };
}
