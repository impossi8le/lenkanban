import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiConflict,
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
import { createChecklistItem } from "@/lib/checklist-toggle";
import { ConflictError, NotFoundError, ForbiddenError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";

const createItemSchema = z.object({
  text: z.string().min(1),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const params = await context.params;

    const task = await prisma.task.findFirst({
      where: await getTaskReadWhere(user, { id: params.id }),
      select: { id: true },
    });

    if (!task) {
      return apiNotFound();
    }

    const items = await prisma.taskChecklistItem.findMany({
      where: { taskId: params.id },
      orderBy: { position: "asc" },
    });

    return apiSuccess(items);
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Failed to fetch checklist items");
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  const parsed = createItemSchema.safeParse(json);
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    const user = await requireApiUser(request);
    const params = await context.params;

    const result = await createChecklistItem({
      database: prisma, actorId: user.id, taskId: params.id, text: parsed.data.text,
    });
    try {
      const fullTask = await loadTaskWithRelations(params.id);
      if (fullTask?.project.id === result.projectId) await emitTaskUpdated(result.projectId, fullTask);
    } catch (error) {
      try {
        apiLogger.warn({ event: "checklist.realtime.failed", route: "/api/tasks/:id/checklist", err: error });
      } catch { /* A diagnostic sink cannot change a committed response. */ }
    }
    return apiSuccess(result.item, undefined, 201);
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound();
    if (error instanceof ConflictError) return apiConflict("Checklist mutation rejected; refresh before a new action");
    return apiInternalError("Failed to create checklist item");
  }
}
