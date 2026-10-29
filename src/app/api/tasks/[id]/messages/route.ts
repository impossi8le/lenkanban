import {requireTrustedMutationOrigin} from "@/lib/mutation-origin";
import {promoteDiscussionAttachments} from "@/lib/attachments/promote-discussion-attachments";
import {loadTaskWithRelations} from "@/lib/task-queries";
import {commitBeznalContentEffect} from "@/features/kanban/server/task-lifecycle-service";
import {emitRequestQueueInvalidation} from "@/socket/request-queue-events";
import { projectChatMessage, canChangeOwnMessage } from "@/lib/chat-message-projection";
import { mentionUserIdsSchema, validateTaskMentions, persistTaskMentions, sameMentionIds, TaskMentionError } from "@/lib/task-mentions";
import { deliverNotifications } from "@/lib/notifications";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logActivityWithClient } from "@/lib/activity-logger";
import { getTaskReadWhere, getProjectAccess } from "@/lib/project-access";
import { z } from "zod";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { withApiLogging } from "@/middleware/api-logger";
import type { RequestLogContext } from "@/lib/request-context";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiForbidden,
  apiNotFound,
  apiInvalidJson,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";
import { TaskCommandError } from "@/lib/task-command";
import {
  authorizeTaskRequestContentWrite,
  TaskLifecycleError,
} from "@/features/kanban/server/task-lifecycle-service";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { emitTaskMessageCreated,emitTaskUpdated } from "@/socket/board-events";
import { MAX_UPLOAD_FILES } from "@/lib/attachments/upload-validation";
import { MessageAttachmentError, resolveMessageAttachments } from "@/lib/attachments/message-attachments";
import { filterTaskAttachmentsForReader, parseAttachmentFileUrl, parseStoredAttachments } from "@/lib/attachments/task-port";

import {
  canActorReadInternal,
  loadInternalMessageIds,
  loadProjectDiscussionFacts,
  markMessageInternal,
} from "./discussion-access";
import { persistTaskContentNotifications } from "./discussion-notifications";
import { normalizeCommentVisibility } from "./discussion-policy";

const querySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const createMessageSchema = z.object({
  mentionUserIds: mentionUserIdsSchema,
  operationId: z.string().uuid().transform(value => value.toLowerCase()).optional(),
  expectedVersion: z.number().int().min(0).max(2147483646).optional(),
  clientId: z.string().trim().min(1).max(200).optional(),
  contentText: z.string().trim().max(20_000).optional().default(""),
  // `visibility` is the explicit contract. `isInternal` is accepted only as a
  // compatibility spelling; the server resolves both and rejects conflicts.
  visibility: z.enum(["PUBLIC", "INTERNAL"]).optional(),
  isInternal: z.boolean().optional(),
  attachments: z
    .array(
      z.object({
        url: z.string().trim().min(1),
        name: z.string().trim().min(1),
        size: z.number().int().nonnegative(),
        mime: z.string().trim().min(1),
      })
    )
    .max(MAX_UPLOAD_FILES)
    .optional()
    .default([]),
}).refine(value => (value.operationId === undefined) === (value.expectedVersion === undefined), {
  message: "operationId and expectedVersion must be supplied together",
});

const commentReceiptSchema = z.object({
  messageId: z.string().min(1), taskId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }), replayed: z.literal(false),
}).strict();

type TaskAccessRow = { id: string; projectId: string };

/**
 * All readers, including watchers, use the common task predicate. A watcher
 * reads only this request; it never gains board-wide or mutation permissions.
 */
async function findAccessibleTask(
  taskId: string,
  user: Readonly<{ id: string; globalRole: "USER" | "ADMIN" }>,
): Promise<TaskAccessRow | null> {
  const task = await prisma.task.findFirst({
    where: await getTaskReadWhere(user, { id: taskId }),
    select: { id: true, projectId: true },
  });
  return task;
}

function isUniqueClientIdViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "P2002";
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = await context.params;
    const { searchParams } = new URL(request.url);

    const parsedQuery = querySchema.safeParse({
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    if (!parsedQuery.success) {
      return apiValidationError(parsedQuery.error);
    }

    const { limit, cursor } = parsedQuery.data;

    const user = await requireApiUser(request);

    const task = await findAccessibleTask(params.id, user);
    if (!task) {
      return apiNotFound("Задача не найдена");
    }

    const projectFacts = await loadProjectDiscussionFacts(prisma, task.projectId);
    const canReadInternal = await canActorReadInternal(prisma, user, projectFacts);
    const internalIds = await loadInternalMessageIds(prisma, params.id);

    // A non-reader never receives internal rows, their attachments or their
    // cursor. Before the column migration `internalIds` is null and the legacy
    // public discussion is returned unchanged.
    const hiddenInternalIds = internalIds !== null && !canReadInternal
      ? [...internalIds]
      : [];

    // Cursor pagination: fetch newest first, then reverse for UI.
    const items = await prisma.chatMessage.findMany({
      where: {
        taskId: params.id,
        ...(hiddenInternalIds.length > 0 ? { id: { notIn: hiddenInternalIds } } : {}),
      },
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      include: {
        author: { select: { id: true, email: true, name: true, avatarUrl: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const requestMarker = await prisma.taskRequest.findUnique({ where: { taskId: params.id }, select: { state: true, authorId: true, contractVersion: true, deletedAt: true } });
    const legacyCanWrite = requestMarker === null && (await getProjectAccess(user, task.projectId)).canWrite;
    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;

    const nextCursor = hasMore ? slice[slice.length - 1]?.id : null;

    // A PUBLIC message can reference a file subsequently made internal by an
    // internal comment. Its historical DTO is not a current file read grant.
    // Resolve only this page's references against current task-owned metadata;
    // keep public text and pagination even when every file becomes unreadable.
    const referencedUrls = new Set(slice.flatMap(message =>
      parseStoredAttachments(message.attachments).map(attachment => attachment.url)));
    const current = referencedUrls.size > 0 ? await prisma.task.findUnique({
      where: { id: params.id }, select: { id: true, projectId: true, attachments: true },
    }) : null;
    const owned = current?.id === task.id && current.projectId === task.projectId
      ? parseStoredAttachments(current.attachments).filter(attachment =>
        referencedUrls.has(attachment.url) && attachment.url.length > 0
        && (!attachment.url.startsWith("/api/tasks/") || parseAttachmentFileUrl(attachment.url, params.id) !== null))
      : [];
    const readable = await filterTaskAttachmentsForReader(prisma, user, task.projectId, owned);
    const currentByUrl = new Map(readable.map(attachment => [attachment.url, attachment]));

    return apiSuccess({
      items: slice.reverse().map(message => ({
        ...projectChatMessage(message),
        canEdit: canChangeOwnMessage(message, user.id, requestMarker, legacyCanWrite),
        canDelete: canChangeOwnMessage(message, user.id, requestMarker, legacyCanWrite),
        attachments: (message.deletedAt ? [] : parseStoredAttachments(message.attachments))
          .flatMap(attachment => currentByUrl.get(attachment.url) ?? []),
        isInternal: internalIds?.has(message.id) ?? false,
      })),
      nextCursor,
      // The client may hide the toggle, but POST re-checks this on the server.
      canReadInternal,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить сообщения");
  }
}

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiLogging(request, (loggedRequest, logContext) => createMessage(loggedRequest, context, logContext), {
    route: "/api/tasks/:id/messages",
  });
}

async function createMessage(
  request: Request,
  context: { params: Promise<{ id: string }> },
  logContext: RequestLogContext,
): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  const params = await context.params;
  const parsedResult = createMessageSchema.safeParse(json);
  if (!parsedResult.success) {
    return apiValidationError(parsedResult.error);
  }
  const parsed = parsedResult.data;

  const visibility = normalizeCommentVisibility(parsed.visibility, parsed.isInternal);
  if (visibility === null) {
    return apiError("VALIDATION_ERROR", "Conflicting comment visibility", undefined, 422);
  }

  let user: Awaited<ReturnType<typeof requireApiUser>> | undefined;

  try {
    user = await requireApiUser(request);
    requireTrustedMutationOrigin(request);
    logContext.actorId = user.id;

    // Rate limiting
    try {
      await rateLimitOrThrowKey("messages:send", user.id);
    } catch (e) {
      return rateLimitErrorResponse(e);
    }

    const task = await findAccessibleTask(params.id, user);
    if (!task) {
      return apiNotFound("Задача не найдена");
    }

    // The internal type is authorized before any row is written. A client
    // toggle is never accepted as proof of access.
    if (visibility === "INTERNAL") {
      const projectFacts = await loadProjectDiscussionFacts(prisma, task.projectId);
      if (!(await canActorReadInternal(prisma, user, projectFacts))) {
        return apiForbidden("Внутреннее обсуждение недоступно");
      }
    }

    const requestHash = parsed.operationId ? createHash("sha256").update(JSON.stringify([
      "task-comment-v1", user.id, params.id, parsed.expectedVersion,
      parsed.contentText, visibility, parsed.attachments, parsed.clientId ?? null,
      ...(parsed.mentionUserIds.length ? [parsed.mentionUserIds] : []),
    ])).digest("hex") : null;
    const result = await prisma.$transaction(async tx => {
      if (parsed.operationId) {
        const operationKey = JSON.stringify(["task-http-operation-v1", parsed.operationId]);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))::text AS locked`;
      }
      // Discussion is ordinary content, not a lifecycle mutation. The shared
      // content rule re-checks the author/executor/watcher/group/leader inside
      // the transaction and never clears a clarification or moves a state.
      // A watcher outside the board is authorized by the same rule; revocation
      // of the watcher row takes effect immediately.
      const content = await authorizeTaskRequestContentWrite({
        tx,
        actorId: user!.id,
        taskId: params.id,
        expectedProjectId: task.projectId,
        kind: "comment",
      });
      if (!content.allowed) throw new TaskCommandError(content.code);
      if (visibility === "INTERNAL") {
        const actor = await tx.user.findUnique({ where: { id: user!.id }, select: { id: true, globalRole: true } });
        if (!actor || !(await canActorReadInternal(tx, actor, await loadProjectDiscussionFacts(tx, task.projectId)))) {
          return null;
        }
      }
      await validateTaskMentions(tx, params.id, task.projectId, parsed.mentionUserIds, visibility);
      if (parsed.operationId) {
        // Fresh shared content and internal access above apply on every replay.
        const receipt = await tx.taskMoveOperation.findUnique({ where: { operationId: parsed.operationId } });
        if (receipt) {
          if (receipt.requestHash !== requestHash || receipt.taskId !== params.id || receipt.projectId !== task.projectId) {
            throw new TaskCommandError("OPERATION_ID_REUSED");
          }
          const ack = commentReceiptSchema.safeParse(receipt.response);
          if (!ack.success || ack.data.taskId !== params.id) throw new TaskCommandError("INVALID_RECEIPT");
          return { replayed: true, data: { ...ack.data, replayed: true } };
        }
        // The shared content guard already holds the task lock. CAS also
        // protects against writers that use the versioned command boundary.
        const updated = await tx.task.updateMany({
          where: { id: params.id, projectId: task.projectId, version: parsed.expectedVersion },
          data: { version: { increment: 1 } },
        });
        if (updated.count !== 1) throw new TaskCommandError("STALE_TASK_VERSION");
      }
      // Attachments are re-resolved inside the guarded transaction: each URL
      // must be the canonical server URL of this task and must already be in
      // the committed Task.attachments. The stored DTO wins over client fields.
      let attachments: ReturnType<typeof resolveMessageAttachments> = [];
      if (parsed.attachments.length > 0) {
        const current = await tx.task.findUnique({
          where: { id: params.id },
          select: { attachments: true },
        });
        if (!current) throw new NotFoundError();
        attachments = resolveMessageAttachments(parsed.attachments, current.attachments, params.id);
        if (visibility === "PUBLIC" && attachments.some(attachment => attachment.isInternal)) {
          throw new MessageAttachmentError("ATTACHMENT_NOT_OWNED");
        }
        attachments=await promoteDiscussionAttachments(tx,params.id,user!.id,attachments,visibility,current.attachments);
      }

      const message = await tx.chatMessage.create({
        data: {
          taskId: params.id,
          authorId: user!.id,
          clientId: parsed.clientId,
          contentText: parsed.contentText ?? "",
          ...(parsed.mentionUserIds.length ? { mentions: parsed.mentionUserIds } : {}),
          attachments,
        },
        include: {
          author: { select: { id: true, email: true, name: true, avatarUrl: true } },
        },
      });
      // Same transaction: a missing column or a zero-row update rolls the
      // message back instead of silently publishing internal content.
      if (visibility === "INTERNAL") {
        await markMessageInternal(tx, message.id);
      }
      const contentEffect=content.marked&&content.beznal?await commitBeznalContentEffect({tx,actorId:user!.id,taskId:params.id,projectId:task.projectId,kind:attachments.length?"invoice":"comment",invoiceUrl:attachments[0]?.url,public:visibility==="PUBLIC",versionAlreadyIncremented:Boolean(parsed.operationId)}):null;
      const mentionNotifications = await persistTaskMentions(tx, { taskId: params.id, projectId: task.projectId, actorId: user!.id, messageId: message.id, mentionUserIds: parsed.mentionUserIds });
      const contentNotifications=await persistTaskContentNotifications({db:tx,taskId:params.id,actorId:user!.id,actorName:user!.name?.trim()||"Участник",visibility,event:"comment",eventId:message.id,...(parsed.mentionUserIds.length?{excludedRecipientIds:parsed.mentionUserIds}:{})});
      const realtimeMessage = {
        id: message.id, clientId: message.clientId, taskId: message.taskId, authorId: message.authorId,
        author: { id: message.author.id, email: message.author.email, name: message.author.name, avatarUrl: message.author.avatarUrl },
        contentText: message.contentText, attachments: message.attachments,
        reactions: message.reactions, mentions: message.mentions, createdAt: message.createdAt,
        version: message.version, editedAt: message.editedAt, deletedAt: message.deletedAt,
        visibility, isInternal: visibility === "INTERNAL",
      };
      if (parsed.operationId) {
        // Activity deliberately contains no text, file metadata or visibility.
        await logActivityWithClient(tx, { taskId: params.id, userId: user!.id, action: "comment_added" });
        const ack = { messageId: message.id, taskId: params.id,
          createdAt: message.createdAt.toISOString(), replayed: false as const };
        await tx.taskMoveOperation.create({ data: {
          operationId: parsed.operationId, taskId: params.id, projectId: task.projectId,
          requestHash: requestHash!, response: ack as Prisma.InputJsonValue,
        } });
        return { replayed: false, data: ack, message: realtimeMessage, mentionNotifications, contentNotifications, contentEffect };
      }
      return { replayed: false, data: { ...message, isInternal: visibility === "INTERNAL" }, message: realtimeMessage, mentionNotifications, contentNotifications, contentEffect };
    });
    if (!result) return apiForbidden("Внутреннее обсуждение недоступно");
    if (result.replayed) return apiSuccess(result.data);

    try{if(result.contentNotifications?.length)await deliverNotifications(result.contentNotifications);}catch{/* Committed comment stands. */}
    if(result.contentEffect?.queueRecipientIds)await emitRequestQueueInvalidation({taskId:params.id,projectId:task.projectId,previousRecipientIds:result.contentEffect.queueRecipientIds});
    if (result.mentionNotifications?.length) deliverNotifications(result.mentionNotifications);
    if(result.contentEffect?.claimed){try{const updated=await loadTaskWithRelations(params.id);if(updated)await emitTaskUpdated(task.projectId,updated);}catch{/* The committed comment and claim remain authoritative. */}}

    // The insert and optional internal marker/receipt are committed before
    // publishing. The bridge rechecks every current recipient's permissions.
    try {
      await emitTaskMessageCreated(task.projectId, result.message);
    } catch {
      try { apiLogger.error({ event: "task.messages.realtime.failed", taskId: params.id }); }
      catch { /* A failed effect cannot undo the committed comment. */ }
    }

    return apiSuccess(result.data, undefined, 201);
  } catch (error) {
    if (error instanceof TaskMentionError) return apiError(error.code, error.message, undefined, 422);
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound("Задача не найдена");
    if (error instanceof MessageAttachmentError) {
      return apiError(
        error.code,
        error.code === "TOO_MANY_ATTACHMENTS"
          ? "Слишком много вложений в сообщении"
          : "Вложение не принадлежит этой задаче",
        undefined,
        422,
      );
    }
    if (error instanceof TaskCommandError) return apiError(error.code, "Task message rejected; refresh before a new action", undefined, 409);
    if (error instanceof TaskLifecycleError) {
      const status = error.code === "FORBIDDEN_ROLE" ? 403
        : error.code === "NOT_A_REQUEST" ? 404
          : error.code === "INVALID_COMMAND" ? 400 : 409;
      return apiError(error.code, "Task message rejected; refresh before a new action", undefined, status);
    }

    // An idempotent retry of the same clientId returns the already committed
    // message (no duplicate row, no duplicate notifications).
    if (!parsed.operationId && isUniqueClientIdViolation(error) && user && parsed.clientId) {
      const existing = await prisma.chatMessage.findUnique({
        where: { clientId: parsed.clientId },
        include: { author: { select: { id: true, email: true, name: true, avatarUrl: true } } },
      });
      if (existing && existing.taskId === params.id && existing.authorId === user.id) {
        if (!sameMentionIds(existing.mentions, parsed.mentionUserIds)) return apiError("CONFLICT", "Message with this clientId already exists", undefined, 409);
        try {
          const actor = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, globalRole: true, isBlocked: true, blockedAt: true } });
          const currentTask = actor && actor.isBlocked === false && actor.blockedAt === null ? await findAccessibleTask(params.id, actor) : null;
          if (!actor || !currentTask) return apiNotFound("Сообщение недоступно. Обновите переписку.");
          const ids = await loadInternalMessageIds(prisma, params.id);
          const isInternal = existing.isInternal || ids?.has(existing.id) === true;
          if (isInternal) {
            if (!(await canActorReadInternal(prisma, actor, await loadProjectDiscussionFacts(prisma, currentTask.projectId)))) {
              return apiForbidden("Внутреннее обсуждение недоступно");
            }
          }
          return apiSuccess({ ...projectChatMessage(existing), isInternal }, undefined, 200);
        } catch {
          return apiInternalError("Не удалось проверить видимость сообщения");
        }
      }
      return apiError("CONFLICT", "Message with this clientId already exists", undefined, 409);
    }

    return apiInternalError("Не удалось создать сообщение");
  }
}
