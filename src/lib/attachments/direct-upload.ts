import {deliverNotifications} from "@/lib/notifications";
import {emitRequestQueueInvalidation} from "@/socket/request-queue-events";
import type { PrismaClient } from "@prisma/client";
import { apiLogger } from "@/lib/logger";
import { NotFoundError } from "@/lib/errors";
import { prepareTaskAttachmentWrite } from "./write-access";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { emitTaskUpdated } from "@/socket/board-events";
import type { PrivateAttachmentStore } from "./storage";
import { MAX_UPLOAD_BATCH_BYTES, validateAttachmentUpload } from "./upload-validation";
import { AttachmentBodyError, parseUploadForm, readBoundedBody, requireMultipart } from "./http";
import { attachmentFileUrl, type StoredAttachment } from "./task-port";
import { appendTaskAttachments } from "./append";
import { withDecodeSlot } from "./decode-gate";

export type DirectUploadDatabase = Pick<PrismaClient, "$transaction" | "task">;

export type DirectUploadActor = { id: string; globalRole: "USER" | "ADMIN" };

export type DirectUploadResult = {
  uploaded: StoredAttachment[];
  count: number;
  projectId: string;
};

/**
 * Direct multipart upload through canonical marked or unchanged legacy admission.
 *
 * Order: authenticate (caller) → bounded body → content validation → authoritative
 * preflight (Project/Task locks, fresh actor, common project write access, marker)
 * → storage writes outside the DB lock → the same guard again plus atomic append
 * and mandatory Activity inside one transaction.
 *
 * There is no automatic retry and no exactly-once claim: an ambiguous transaction
 * result keeps its objects rather than risking deletion of committed metadata.
 */
export async function directUpload(
  request: Request,
  { actor, database, store }: { actor: DirectUploadActor; database: DirectUploadDatabase; store: PrivateAttachmentStore },
): Promise<DirectUploadResult> {
  const contentType = requireMultipart(request);
  const body = await readBoundedBody(request);
  const { taskId, files } = await parseUploadForm(body, contentType);

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total) || total > MAX_UPLOAD_BATCH_BYTES) {
    throw new AttachmentBodyError("TOO_LARGE");
  }

  const validated: { name: string; mime: string; bytes: Uint8Array }[] = [];
  for (const file of files) validated.push(await withDecodeSlot(() => validateAttachmentUpload(file)));

  const outer = await database.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!outer) throw new NotFoundError();

  // Initial authoritative preflight: no storage write happens before it passes.
  await database.$transaction(async tx => {
    const locked = await prepareTaskAttachmentWrite({
      tx, actorId: actor.id, taskId, expectedProjectId: outer.projectId,
    });
    if (!locked) throw new NotFoundError();
  });

  const created: { fileId: string; size: number }[] = [];
  const cleanup = async () => {
    for (const object of created) {
      try {
        await store.deleteOwned(taskId, object.fileId);
      } catch {
        // Cleanup is best effort; it never changes the caller's outcome.
      }
    }
  };

  try {
    for (const file of validated) created.push(await store.put(taskId, file.bytes));
  } catch (error) {
    await cleanup();
    throw error;
  }

  const uploaded: StoredAttachment[] = validated.map((file, index) => ({
    url: attachmentFileUrl(taskId, created[index].fileId),
    name: file.name,
    size: created[index].size,
    mime: file.mime,
  }));

  const commit = async (): Promise<{ projectId: string; notifications?: Awaited<ReturnType<typeof appendTaskAttachments>>["notifications"]; queueRecipientIds?:string[] }> => {
    let writeStarted = false;
    try {
      return await database.$transaction(async tx => {
        const result = await appendTaskAttachments(tx, {
          taskId, actorId: actor.id, expectedProjectId: outer.projectId, attachments: uploaded, invoiceIntent:true,
          onWriteStart: () => { writeStarted = true; },
        });
        return { projectId: result.projectId, notifications: result.notifications, queueRecipientIds:result.queueRecipientIds };
      });
    } catch (error) {
      // A refusal before the metadata write makes cleanup safe. Once the write has
      // started, the outcome is ambiguous and objects are kept for reconciliation.
      if (!writeStarted) await cleanup();
      throw error;
    }
  };

  const { projectId,notifications,queueRecipientIds } = await commit();
  if(notifications?.length)deliverNotifications(notifications);
  if(queueRecipientIds)await emitRequestQueueInvalidation({taskId,projectId,previousRecipientIds:queueRecipientIds});
  try {
    const fullTask = await loadTaskWithRelations(taskId);
    if (fullTask?.project.id === projectId) await emitTaskUpdated(projectId, fullTask);
  } catch (error) {
    try {
      apiLogger.warn({ event: "attachments.upload.realtime.failed", route: "/api/uploads/direct", err: error });
    } catch {
      // Diagnostics cannot replace committed success.
    }
  }

  return { uploaded, count: uploaded.length, projectId };
}
