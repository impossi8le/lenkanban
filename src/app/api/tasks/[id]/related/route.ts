import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { changeRelatedRequests, readRelatedRequests, relatedRequestCommandSchema } from "@/lib/task-related-requests";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { TaskCommandError } from "@/lib/task-command";
import { apiSuccess, apiError, apiUnauthorized, apiForbidden, apiNotFound, apiInvalidJson, apiValidationError, apiInternalError } from "@/lib/api-response";
import { requireTrustedMutationOrigin } from "@/lib/mutation-origin";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { withApiLogging } from "@/middleware/api-logger";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { emitTaskUpdated } from "@/socket/board-events";
type Context = { params: Promise<{ id: string }> };
const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };
function failure(error: unknown) {
  if (error instanceof UnauthorizedError) return apiUnauthorized();
  if (error instanceof ForbiddenError) return apiForbidden("Менять связи могут автор, исполнитель и руководство с правом изменения.");
  if (error instanceof NotFoundError) return apiNotFound("Обращение недоступно. Выберите доступное обращение в поиске или проверьте ссылку.");
  if (error instanceof TaskCommandError) return apiError(error.code, error.code === "INVALID_COMMAND" ? "Выберите другое обращение. Связать обращение с самим собой нельзя."
    : "Обращение изменилось. Обновите карточку и повторите действие.", undefined, error.code === "INVALID_COMMAND" ? 400 : 409);
  return apiInternalError("Сервер не подтвердил изменение связей. Повторите этот же запрос.");
}
export function GET(request: Request, context: Context) {
  return withApiLogging(request, async (logged, trace) => {
    try { const actor = await requireApiUser(logged); trace.actorId = actor.id;
      return noStore(apiSuccess(await readRelatedRequests(prisma, actor.id, (await context.params).id)));
    } catch (error) { return noStore(failure(error)); }
  }, { route: "/api/tasks/:id/related" });
}
function mutate(request: Request, context: Context, action: "add" | "remove") {
  return withApiLogging(request, async (logged, trace) => {
    try {
      const actor = await requireApiUser(logged); trace.actorId = actor.id; requireTrustedMutationOrigin(logged);
      try { await rateLimitOrThrowKey("tasks:update", actor.id); } catch (error) { return noStore(rateLimitErrorResponse(error)); }
      let body: unknown; try { body = await logged.json(); } catch { return noStore(apiInvalidJson()); }
      const parsed = relatedRequestCommandSchema.safeParse(body); if (!parsed.success) return noStore(apiValidationError(parsed.error));
      const result = await changeRelatedRequests(prisma, { ...parsed.data, actorId: actor.id, taskId: (await context.params).id, action });
      for (const endpoint of result.affected) {
        try { const task = await loadTaskWithRelations(endpoint.id); if (task?.project.id === endpoint.projectId) emitTaskUpdated(endpoint.projectId, task); }
        catch { /* Committed command survives delivery failure; normal readers re-fetch. */ }
      }
      return noStore(apiSuccess(result.projection));
    } catch (error) { return noStore(failure(error)); }
  }, { route: "/api/tasks/:id/related" });
}
export function POST(request: Request, context: Context) { return mutate(request, context, "add"); }
export function DELETE(request: Request, context: Context) { return mutate(request, context, "remove"); }
