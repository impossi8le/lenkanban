import { prisma } from "@/lib/prisma";
import { changeOwnMessage, editOwnMessageSchema, deleteOwnMessageSchema, MessageDeletedError } from "@/lib/chat-message-command";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { TaskCommandError } from "@/lib/task-command";
import { TaskLifecycleError } from "@/features/kanban/server/task-lifecycle-service";
import { withApiLogging } from "@/middleware/api-logger";
import { requireTrustedMutationOrigin } from "@/lib/mutation-origin";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { apiSuccess, apiError, apiUnauthorized, apiNotFound, apiForbidden, apiInvalidJson, apiValidationError, apiInternalError } from "@/lib/api-response";
import { emitTaskMessageUpdated } from "@/socket/board-events";
import { apiLogger } from "@/lib/logger";

type Context = { params: Promise<{ id: string; messageId: string }> };
function mutate(request: Request, context: Context, action: "edit" | "delete") {
  return withApiLogging(request, async (logged, logContext) => {
    const response = (value: Response) => { value.headers.set("Cache-Control", "no-store"); return value; };
    try {
      const actor = await requireApiUser(logged); logContext.actorId = actor.id;
      requireTrustedMutationOrigin(logged);
      try { await rateLimitOrThrowKey("tasks:update", actor.id); } catch (error) { return response(rateLimitErrorResponse(error)); }
      let body: unknown; try { body = await logged.json(); } catch { return response(apiInvalidJson()); }
      const parsed = (action === "edit" ? editOwnMessageSchema : deleteOwnMessageSchema).safeParse(body);
      if (!parsed.success) return response(apiValidationError(parsed.error));
      const { id, messageId } = await context.params;
      const result = await changeOwnMessage(prisma, { ...parsed.data, actorId: actor.id, taskId: id, messageId, action });
      if (!result.ack.replayed && result.ack.changed && result.message) {
        try { await emitTaskMessageUpdated(result.projectId, result.message); }
        catch { try { apiLogger.warn({ event: "task.messages.realtime.failed", route: "/api/tasks/:id/messages/:messageId" }); } catch { /* Commit remains authoritative. */ } }
      }
      return response(apiSuccess(result.ack));
    } catch (error) {
      if (error instanceof UnauthorizedError) return response(apiUnauthorized());
      if (error instanceof ForbiddenError) return response(apiForbidden());
      if (error instanceof NotFoundError) return response(apiNotFound("Сообщение недоступно. Обновите переписку."));
      if (error instanceof MessageDeletedError) return response(apiError(error.code, error.message, undefined, 409));
      if (error instanceof TaskCommandError || error instanceof TaskLifecycleError) return response(apiError(error.code, "Не удалось изменить сообщение. Обновите переписку и повторите действие.", undefined, error.code === "INVALID_COMMAND" ? 400 : error.code === "FORBIDDEN_ROLE" ? 403 : 409));
      return response(apiInternalError("Сервер не подтвердил сохранение. Повторите ту же операцию."));
    }
  }, { route: "/api/tasks/:id/messages/:messageId" });
}
export function PATCH(request: Request, context: Context) { return mutate(request, context, "edit"); }
export function DELETE(request: Request, context: Context) { return mutate(request, context, "delete"); }
