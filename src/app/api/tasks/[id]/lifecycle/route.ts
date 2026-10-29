import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { NotFoundError } from "@/lib/errors";
import { apiError, apiInternalError, apiNotFound, apiSuccess, apiUnauthorized } from "@/lib/api-response";
import {
  createTaskLifecycleService,
  TaskLifecycleError,
} from "@/features/kanban/server/task-lifecycle-service";

export const dynamic = "force-dynamic";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function failure(error: unknown): Response {
  if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
  if (error instanceof NotFoundError) return noStore(apiNotFound("Заявка не найдена"));
  if (error instanceof TaskLifecycleError) {
    const status = error.code === "FORBIDDEN_ROLE" ? 403
      : error.code === "NOT_A_REQUEST" ? 404
        : error.code === "INVALID_COMMAND" ? 400 : 409;
    return noStore(apiError(error.code, "Состояние заявки недоступно", undefined, status));
  }
  return noStore(apiInternalError("Не удалось загрузить состояние заявки"));
}

/** GET /api/tasks/[id]/lifecycle — read-only lifecycle projection for the UI. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await context.params;
    const snapshot = await createTaskLifecycleService(prisma).snapshot({
      actorId: user.id,
      taskId: id,
    });
    return noStore(apiSuccess(snapshot));
  } catch (error) {
    return failure(error);
  }
}
