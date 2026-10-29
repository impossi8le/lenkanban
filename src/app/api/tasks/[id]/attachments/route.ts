import { detachTaskAttachment, detachAttachmentSchema, AttachmentInMessageError } from "@/lib/attachments/detach-command";
import { TaskLifecycleError } from "@/features/kanban/server/task-lifecycle-service";
import { withApiLogging } from "@/middleware/api-logger";
import { requireTrustedMutationOrigin } from "@/lib/mutation-origin";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiNotFound,
  apiInvalidJson,
  apiValidationError,
  apiInternalError,
  apiForbidden,
} from "@/lib/api-response";
import { z } from "zod";
import { emitTaskUpdated } from "@/socket/board-events";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { prepareLegacyTaskScalarBatch, TaskCommandError } from "@/lib/task-command";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { parseStoredAttachments, parseAttachmentFileUrl, readVisibleTaskAttachments } from "@/lib/attachments/task-port";
import { MAX_TASK_ATTACHMENTS } from "@/lib/attachments/append";

const attachmentSchema = z.object({
  url: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative().max(25 * 1024 * 1024),
  mime: z.string(),
  width: z.number().int().positive().safe().optional(),
  height: z.number().int().positive().safe().optional(),
}).strict();

const updateAttachmentsSchema = z.object({
  attachments: z.array(attachmentSchema).max(MAX_TASK_ATTACHMENTS, "Не более 100 вложений у задачи"),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const user = await requireApiUser(request);
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return apiInvalidJson();
    }
    const parsed = updateAttachmentsSchema.parse(json);

    const task = await prisma.task.findFirst({
      where:
        user.globalRole === "ADMIN"
          ? { id }
          : {
              id,
              project: {
                OR: [
                  { ownerId: user.id },
                  { members: { some: { userId: user.id } } },
                ],
              },
            },
      select: { id: true, projectId: true },
    });

    if (!task) {
      return apiNotFound("Задача не найдена");
    }

    const result = await prisma.$transaction(async tx => {
      const [lockedTask] = await prepareLegacyTaskScalarBatch({
        tx, actorId: user.id, expectedTasks: [{ id, projectId: task.projectId }],
      });
      if (!lockedTask) throw new NotFoundError();
      // Read after the shared task lock, so a concurrent upload cannot lose its reference.
      const current = await tx.task.findUnique({ where: { id }, select: { attachments: true } });
      if (!current) throw new NotFoundError();
      const stored = parseStoredAttachments(current.attachments);
      const protectedAttachments = stored.filter(attachment => parseAttachmentFileUrl(attachment.url, id));
      const serviceFields = ["url", "size", "mime", "width", "height"] as const;
      const invalid = protectedAttachments.some(attachment => {
        const matches = parsed.attachments.filter(next => next.url === attachment.url);
        return matches.length !== 1 || serviceFields.some(field => matches[0][field] !== attachment[field]);
      }) || parsed.attachments.some(attachment =>
        attachment.url.startsWith("/api/tasks/")
        && !protectedAttachments.some(previous => previous.url === attachment.url));
      if (invalid) {
        throw new z.ZodError([{
          code: z.ZodIssueCode.custom, path: ["attachments"],
          message: "Stored attachment references and service metadata cannot be changed through legacy PATCH",
        }]);
      }
      const updated = await tx.task.update({
        where: { id },
        data: {
          attachments: parsed.attachments,
        },
        include: {
          assignees: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  avatarUrl: true,
                },
              },
            },
          },
          tags: {
            include: {
              tag: true,
            },
          },
          checklistItems: {
            orderBy: { position: "asc" },
          },
          project: {
            select: { id: true },
          },
        },
      });
      return { updated, projectId: lockedTask.projectId };
    });

    // Emit real-time update with full relations
    try {
      const fullTask = await loadTaskWithRelations(id);
      if (fullTask?.project.id === result.projectId) await emitTaskUpdated(result.projectId, fullTask);
    } catch (error) {
      try { apiLogger.warn({ event: "attachments.realtime.failed", route: "/api/tasks/:id/attachments", err: error }); }
      catch { /* Diagnostics cannot replace committed success. */ }
    }

    const attachments = await readVisibleTaskAttachments(prisma, user, result.projectId, result.updated.attachments);
    return apiSuccess(attachments === undefined ? result.updated : { ...result.updated, attachments });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound("Задача не найдена");
    if (error instanceof TaskCommandError) return apiError(error.code, "Task attachment mutation rejected; refresh before a new action", undefined, 409);
    return apiInternalError("Не удалось обновить вложения");
  }
}


/** Versioned detach command. The legacy PATCH above remains protected. */
export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiLogging(request, async (logged, logContext) => {
    const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };
    try {
      const actor = await requireApiUser(logged); logContext.actorId = actor.id;
      requireTrustedMutationOrigin(logged);
      try { await rateLimitOrThrowKey("tasks:update", actor.id); } catch (error) { return noStore(rateLimitErrorResponse(error)); }
      let body: unknown; try { body = await logged.json(); } catch { return noStore(apiInvalidJson()); }
      const parsed = detachAttachmentSchema.safeParse(body); if (!parsed.success) return noStore(apiValidationError(parsed.error));
      const { id } = await context.params;
      const ack = await detachTaskAttachment(prisma, { ...parsed.data, actorId: actor.id, taskId: id });
      if (!ack.replayed && ack.changed) {
        try { const task = await loadTaskWithRelations(id); if (task?.project.id === ack.projectId) await emitTaskUpdated(ack.projectId, task); }
        catch { try { apiLogger.warn({ event: "attachments.realtime.failed", route: "/api/tasks/:id/attachments" }); } catch { /* Commit survives diagnostics. */ } }
      }
      return noStore(apiSuccess(ack));
    } catch (error) {
      if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
      if (error instanceof ForbiddenError) return noStore(apiForbidden());
      if (error instanceof NotFoundError) return noStore(apiNotFound("Вложение или обращение недоступно"));
      if (error instanceof AttachmentInMessageError) return noStore(apiError(error.code, error.message, undefined, 422));
      if (error instanceof TaskCommandError || error instanceof TaskLifecycleError) {
        const status = error.code === "FORBIDDEN_ROLE" ? 403 : error.code === "INVALID_COMMAND" ? 400 : 409;
        return noStore(apiError(error.code, "Не удалось убрать вложение. Обновите карточку и повторите действие.", undefined, status));
      }
      return noStore(apiInternalError("Сервер не подтвердил удаление ссылки. Повторите этот же запрос."));
    }
  }, { route: "/api/tasks/:id/attachments" });
}
