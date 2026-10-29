import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiInvalidJson,
  apiValidationError,
  apiInternalError,
  apiBadRequest,
  apiConflict,
  apiForbidden,
} from "@/lib/api-response";
import { z } from "zod";
import { emitTaskUpdated } from "@/socket/board-events";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { deleteChecklistItem, updateChecklistItem } from "@/lib/checklist-toggle";
import { BadRequestError, ConflictError, NotFoundError, ForbiddenError } from "@/lib/errors";
import { validCorrelationId } from "@/lib/telemetry-sanitize";
import { withApiLogging } from "@/middleware/api-logger";
import { apiLogger } from "@/lib/logger";
import { projectChecklistTelemetry } from "@/lib/telemetry/store";

const updateItemSchema = z.object({
  text: z.string().min(1).optional(),
  completed: z.boolean().optional(),
  position: z.number().optional(),
});

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> }
) {
  return withApiLogging(request, async (scopedRequest, logContext) => {
  const operationHeader = scopedRequest.headers.get("X-Operation-Id");
  if (operationHeader !== null && !validCorrelationId(operationHeader)) {
    return apiBadRequest("Invalid operation ID");
  }
  let json: unknown;
  try {
    json = await scopedRequest.json();
  } catch {
    return apiInvalidJson();
  }

  const parsed = (operationHeader === null ? updateItemSchema : z.object({ completed: z.boolean() }).strict()).safeParse(json);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  try {
    const user = await requireApiUser(scopedRequest);
    logContext.actorId = user.id;
    const params = await context.params;

    const result = await updateChecklistItem({
      database: prisma, actorId: user.id, taskId: params.id, itemId: params.itemId,
      update: parsed.data, operationId: operationHeader ?? undefined, context: logContext,
    });
    // Every durable receipt, including a replay, may repair an earlier lost
    // projection. Projection never participates in the business transaction.
    if (result.receiptId) {
      try {
        void projectChecklistTelemetry(result.receiptId).catch(() => {});
      } catch { /* A telemetry failure cannot change the committed result. */ }
    }
    if (!result.replayed && (result.changed || operationHeader === null)) {
      try {
        const fullTask = await loadTaskWithRelations(params.id);
        if (fullTask) await emitTaskUpdated(fullTask.project.id, fullTask);
      } catch (error) {
        try { apiLogger.warn({ ...logContext, event: "checklist.realtime.failed", err: error }); }
        catch { /* A diagnostic sink failure cannot change the committed result. */ }
      }
    }
    return apiSuccess(result.item);
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound();
    if (error instanceof ConflictError) return apiConflict("Operation ID belongs to another command");
    if (error instanceof BadRequestError) return apiBadRequest("Invalid checklist operation");
    try { apiLogger.error({ ...logContext, event: "checklist.update.failed", err: error }); }
    catch { /* No raw fallback. */ }
    return apiInternalError("Failed to update checklist item");
  }
  }, { route: "/api/tasks/:id/checklist/:itemId" });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const params = await context.params;

    const result = await deleteChecklistItem({
      database: prisma, actorId: user.id, taskId: params.id, itemId: params.itemId,
    });
    try {
      const fullTask = await loadTaskWithRelations(params.id);
      if (fullTask?.project.id === result.projectId) await emitTaskUpdated(result.projectId, fullTask);
    } catch (error) {
      try {
        apiLogger.warn({ event: "checklist.realtime.failed", route: "/api/tasks/:id/checklist/:itemId", err: error });
      } catch { /* A diagnostic sink cannot change a committed response. */ }
    }

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound();
    if (error instanceof ConflictError) return apiConflict("Checklist mutation rejected; refresh before a new action");
    return apiInternalError("Failed to delete checklist item");
  }
}
