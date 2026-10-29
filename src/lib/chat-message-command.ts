import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { authorizeTaskRequestContentWrite } from "@/features/kanban/server/task-lifecycle-service";
import { canActorReadInternal, loadInternalMessageIds, loadProjectDiscussionFacts } from "@/app/api/tasks/[id]/messages/discussion-access";
import { TaskCommandError } from "./task-command";
import { ForbiddenError, NotFoundError } from "./errors";
import { logActivityWithClient } from "./activity-logger";
import { getProjectAccess } from "./project-access";
import { projectChatMessage } from "./chat-message-projection";

const base = { operationId: z.string().uuid().transform(id => id.toLowerCase()), expectedVersion: z.number().int().min(0).max(2147483646) };
export const editOwnMessageSchema = z.object({ ...base, contentText: z.string().trim().max(20_000) }).strict();
export const deleteOwnMessageSchema = z.object(base).strict();
const ackSchema = z.object({ taskId: z.string(), messageId: z.string(), version: z.number().int().nonnegative(), changed: z.boolean(), replayed: z.literal(false) }).strict();
export type OwnMessageAck = Omit<z.infer<typeof ackSchema>, "replayed"> & { replayed: boolean };
export class MessageDeletedError extends Error { readonly code = "MESSAGE_DELETED"; constructor() { super("Сообщение уже удалено. Обновите переписку."); } }

/** Same Project/Task/actor authority and durable receipt family as comment creation;
 * the message has its own CAS, so corrections do not invalidate task-field drafts. */
export async function changeOwnMessage(database: Pick<PrismaClient, "$transaction">, input: {
  actorId: string; taskId: string; messageId: string; action: "edit" | "delete";
  operationId: string; expectedVersion: number; contentText?: string;
}) {
  const parsed = (input.action === "edit" ? editOwnMessageSchema : deleteOwnMessageSchema).safeParse({
    operationId: input.operationId, expectedVersion: input.expectedVersion, ...(input.action === "edit" ? { contentText: input.contentText } : {}),
  });
  if (!parsed.success || ![input.actorId, input.taskId, input.messageId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))
    || !["edit", "delete"].includes(input.action)) throw new TaskCommandError("INVALID_COMMAND");
  const command = { ...input, ...parsed.data };
  const nextText = "contentText" in parsed.data && typeof parsed.data.contentText === "string" ? parsed.data.contentText : "";
  const requestHash = createHash("sha256").update(JSON.stringify(["own-message-v1", input.actorId, input.taskId, input.messageId, input.action, command.expectedVersion, nextText])).digest("hex");
  return database.$transaction(async tx => {
    const operationKey = JSON.stringify(["task-http-operation-v1", command.operationId]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))::text AS locked`;
    const identity = await tx.task.findUnique({ where: { id: input.taskId }, select: { projectId: true } });
    if (!identity) throw new NotFoundError();
    const authority = await authorizeTaskRequestContentWrite({ tx, actorId: input.actorId, taskId: input.taskId, expectedProjectId: identity.projectId, kind: "comment" });
    if (!authority.allowed) throw new TaskCommandError(authority.code);
    if (!authority.marked) {
      const actor = await tx.user.findUnique({ where: { id: input.actorId }, select: { id: true, globalRole: true } });
      if (!actor || !(await getProjectAccess(actor, identity.projectId, tx)).canWrite) throw new NotFoundError();
    }
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ChatMessage" WHERE "id" = ${input.messageId} AND "taskId" = ${input.taskId} FOR UPDATE`;
    if (!Array.isArray(locked) || locked.length !== 1) throw new NotFoundError();
    const current = await tx.chatMessage.findUnique({ where: { id: input.messageId }, include: { author: { select: { id: true, email: true, name: true, avatarUrl: true } } } });
    if (!current || current.taskId !== input.taskId) throw new NotFoundError();
    if (current.authorId !== input.actorId) throw new ForbiddenError();
    const internalIds = await loadInternalMessageIds(tx, input.taskId);
    const isInternal = current.isInternal || internalIds?.has(current.id) === true;
    if (isInternal) {
      const actor = await tx.user.findUnique({ where: { id: input.actorId }, select: { id: true, globalRole: true } });
      if (!actor || !(await canActorReadInternal(tx, actor, await loadProjectDiscussionFacts(tx, identity.projectId)))) throw new NotFoundError();
    }
    // Every retry re-authorizes above. Receipts store metadata only, never historical text.
    const receipt = await tx.taskMoveOperation.findUnique({ where: { operationId: command.operationId } });
    if (receipt) {
      if (receipt.requestHash !== requestHash || receipt.taskId !== input.taskId || receipt.projectId !== identity.projectId) throw new TaskCommandError("OPERATION_ID_REUSED");
      const ack = ackSchema.safeParse(receipt.response);
      if (!ack.success || ack.data.taskId !== input.taskId || ack.data.messageId !== input.messageId
        || ack.data.version !== command.expectedVersion + (ack.data.changed ? 1 : 0)) throw new TaskCommandError("INVALID_RECEIPT");
      return { ack: { ...ack.data, replayed: true } as OwnMessageAck, projectId: identity.projectId, message: null };
    }
    if (current.version !== command.expectedVersion) throw new TaskCommandError("STALE_TASK_VERSION");
    if (current.deletedAt) throw new MessageDeletedError();
    if (input.action === "edit" && !nextText && (!Array.isArray(current.attachments) || current.attachments.length === 0)) throw new TaskCommandError("INVALID_COMMAND");
    const changed = input.action === "delete" || nextText !== current.contentText;
    const version = current.version + (changed ? 1 : 0);
    if (changed) {
      const now = new Date();
      const saved = await tx.chatMessage.updateMany({ where: { id: current.id, taskId: input.taskId, authorId: input.actorId, version: command.expectedVersion, deletedAt: null },
        data: input.action === "delete" ? { deletedAt: now, version: { increment: 1 } } : { contentText: nextText, editedAt: now, version: { increment: 1 } } });
      if (saved.count !== 1) throw new TaskCommandError("STALE_TASK_VERSION");
      await logActivityWithClient(tx, { taskId: input.taskId, userId: input.actorId, action: input.action === "edit" ? "message_edited" : "message_deleted",
        oldValue: { messageId: current.id, contentText: current.contentText, isInternal }, newValue: { messageId: current.id, contentText: nextText, isInternal } });
    }
    const ack = { taskId: input.taskId, messageId: current.id, version, changed, replayed: false as const };
    await tx.taskMoveOperation.create({ data: { operationId: command.operationId, taskId: input.taskId, projectId: identity.projectId, requestHash, response: ack } });
    const updated = changed ? await tx.chatMessage.findUniqueOrThrow({ where: { id: current.id }, include: { author: { select: { id: true, email: true, name: true, avatarUrl: true } } } }) : current;
    return { ack: ack as OwnMessageAck, projectId: identity.projectId, message: projectChatMessage({ ...updated, isInternal, visibility: isInternal ? "INTERNAL" : "PUBLIC" }) };
  });
}
