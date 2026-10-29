import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorizeTaskAttachmentDetach } from "@/features/kanban/server/task-lifecycle-service";
import { TaskCommandError, type TaskCommandAck } from "@/lib/task-command";
import { NotFoundError } from "@/lib/errors";
import { logActivityWithClient } from "@/lib/activity-logger";
import { filterTaskAttachmentsForReader, parseStoredAttachments } from "./task-port";

export const detachAttachmentSchema = z.object({ operationId: z.string().uuid().transform(id => id.toLowerCase()),
  expectedVersion: z.number().int().min(0).max(2147483646), url: z.string().min(1).max(4096) }).strict();
export class AttachmentInMessageError extends Error {
  readonly code = "ATTACHMENT_IN_MESSAGE";
  constructor() { super("Этот файл опубликован в сообщении и остаётся частью переписки. Убрать его из карточки этим действием нельзя."); }
}

/** Same Project/Task authority, durable receipts and CAS as the command family.
 * Only the reference is detached; object deletion is deliberately absent. */
export async function detachTaskAttachment(database: Pick<PrismaClient, "$transaction">,
  input: { actorId: string; taskId: string } & z.input<typeof detachAttachmentSchema>,
): Promise<TaskCommandAck> {
  const parsed = detachAttachmentSchema.safeParse(input && { operationId: input.operationId, expectedVersion: input.expectedVersion, url: input.url });
  if (!parsed.success || typeof input.actorId !== "string" || typeof input.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.actorId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.taskId)) throw new TaskCommandError("INVALID_COMMAND");
  const command = { ...parsed.data, actorId: input.actorId, taskId: input.taskId };
  const requestHash = createHash("sha256").update(JSON.stringify(["task-attachment-detach-v1", command.actorId, command.taskId, command.expectedVersion, command.url])).digest("hex");
  return database.$transaction(async tx => {
    // Existing actor/operation receipt namespace; the mutex follows lifecycle commands.
    const operationKey = JSON.stringify(["task-request-lifecycle-v1", command.actorId, command.operationId]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))::text AS locked`;
    const identity = await tx.task.findUnique({ where: { id: command.taskId }, select: { projectId: true } });
    if (!identity) throw new NotFoundError();
    const authority = await authorizeTaskAttachmentDetach({ tx, actorId: command.actorId, taskId: command.taskId, expectedProjectId: identity.projectId });
    const receipt = await tx.taskCommandOperation.findUnique({ where: { actorId_operationId: { actorId: command.actorId, operationId: command.operationId } } });
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new TaskCommandError("OPERATION_ID_REUSED");
      if (receipt.actorId !== command.actorId || receipt.operationId !== command.operationId || receipt.taskId !== command.taskId || receipt.projectId !== identity.projectId
        || receipt.expectedVersion !== command.expectedVersion || typeof receipt.changed !== "boolean" || !Number.isInteger(receipt.committedVersion)
        || receipt.committedVersion !== command.expectedVersion + (receipt.changed ? 1 : 0) || receipt.committedVersion > 2147483647) throw new TaskCommandError("INVALID_RECEIPT");
      return { taskId: command.taskId, projectId: identity.projectId, version: receipt.committedVersion, changed: receipt.changed, replayed: true };
    }
    if (authority.version !== command.expectedVersion) throw new TaskCommandError("STALE_TASK_VERSION");
    const current = await tx.task.findUnique({ where: { id: command.taskId }, select: { attachments: true } });
    if (!current) throw new NotFoundError();
    const target = parseStoredAttachments(current.attachments).filter(file => file.url === command.url);
    if (!target.length || !(await filterTaskAttachmentsForReader(tx, authority.actor, identity.projectId, target)).length) throw new NotFoundError();
    const published = await tx.chatMessage.findFirst({ where: { taskId: command.taskId, attachments: { array_contains: [{ url: command.url }] } }, select: { id: true } });
    if (published) throw new AttachmentInMessageError();
    const attachments = Array.isArray(current.attachments) ? current.attachments.filter(entry => !(entry && typeof entry === "object" && !Array.isArray(entry) && entry.url === command.url)) : [];
    const updated = await tx.task.updateMany({ where: { id: command.taskId, projectId: identity.projectId, version: command.expectedVersion }, data: { attachments, version: { increment: 1 } } });
    if (updated.count !== 1) throw new TaskCommandError("STALE_TASK_VERSION");
    // Only removing the exact currently selected invoice resets readiness.
    await tx.taskRequest.updateMany({where:{taskId:command.taskId,currentInvoiceUrl:command.url},data:{beznalPhase:"WAITING",currentInvoiceUrl:null}});
    await logActivityWithClient(tx, { taskId: command.taskId, userId: command.actorId, action: "attachment_removed", newValue: { count: 1 } });
    const version = command.expectedVersion + 1;
    await tx.taskCommandOperation.create({ data: { actorId: command.actorId, operationId: command.operationId, taskId: command.taskId, projectId: identity.projectId, requestHash,
      expectedVersion: command.expectedVersion, committedVersion: version, changed: true } });
    return { taskId: command.taskId, projectId: identity.projectId, version, changed: true, replayed: false };
  });
}
