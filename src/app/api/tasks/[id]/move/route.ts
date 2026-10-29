import { createHash } from "node:crypto";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { z } from "zod";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import { MoveTaskRequestSchema } from "@/features/kanban/server/move-contract";
import { MoveTaskError } from "@/features/kanban/server/move-errors";
import { moveTask, type MoveTaskRepository } from "@/features/kanban/server/move-task-service";
import { PrismaMoveRepository } from "@/features/kanban/server/prisma-move-repository";
import {
  apiError,
  apiInternalError,
  apiSuccess,
  apiForbidden,
} from "@/lib/api-response";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireProjectWrite } from "@/lib/project-access";
import { processMoveAutomation } from "@/lib/automation-processor";
import { apiLogger } from "@/lib/logger";
import { emitTaskMoved } from "@/socket/board-events";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";

function actorBoundRepository(repository: MoveTaskRepository, actorId: string): MoveTaskRepository {
  const prefix = createHash("sha256").update(JSON.stringify(["move", actorId])).digest("hex") + ":";
  return {
    transact: operation => repository.transact(tx => operation({
      ...tx,
      async getOperation(operationId) {
        const receipt = await tx.getOperation(operationId);
        if (!receipt) return null;
        // Legacy unbound receipts cannot establish ownership, so fail closed.
        if (!receipt.requestHash.startsWith(prefix)) throw new MoveTaskError("OPERATION_ID_REUSED");
        return { ...receipt, requestHash: receipt.requestHash.slice(prefix.length) };
      },
      storeOperation: receipt => tx.storeOperation({ ...receipt, requestHash: prefix + receipt.requestHash }),
    })),
  };
}

function moveErrorResponse(error: MoveTaskError) {
  switch (error.code) {
    case "REQUEST_LIFECYCLE_NOT_ENABLED":
    case "INVALID_REQUEST_MARKER":
      return apiError(error.code, "Перемещение задачи недоступно", undefined, 409);
    case "TASK_NOT_FOUND":
      return apiError(error.code, "Задача не найдена", undefined, 404);
    case "STALE_TASK_VERSION":
      return apiError(
        error.code,
        "Задача была изменена. Обновите доску и повторите попытку",
        undefined,
        409,
      );
    case "OPERATION_ID_REUSED":
      return apiError(
        error.code,
        "Идентификатор операции уже использован для другого перемещения",
        undefined,
        409,
      );
    case "INVALID_DESTINATION_COLUMN":
      return apiError(
        error.code,
        "Колонка назначения не найдена в этом проекте",
        undefined,
        422,
      );
    case "INVALID_MOVE_ROUTE":
      return apiError(error.code, "Недопустимый маршрут перемещения задачи", undefined, 422);
    case "INVALID_MOVE_NEIGHBORS":
      return apiError(
        error.code,
        "Не удалось определить точное место в колонке. Обновите доску. Если ошибка повторяется, обратитесь к ответственному за доску",
        undefined,
        422,
      );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireApiUser>>;
  try {
    user = await requireApiUser(request);
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (!(error instanceof UnauthorizedError)) return apiInternalError("Не удалось переместить задачу");
    return apiError(
      "UNAUTHORIZED",
      "Требуется авторизация",
      undefined,
      401,
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiError(
      "INVALID_JSON",
      "Некорректный JSON в запросе",
      undefined,
      400,
    );
  }

  try {
    const { id: taskId } = await context.params;
    const parsed = MoveTaskRequestSchema.parse(json);
    // Share the scalar/lifecycle actor budget; replay admission also counts.
    try {
      await rateLimitOrThrowKey("tasks:update", user.id);
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 429) return rateLimitErrorResponse(error);
      return apiInternalError("Не удалось переместить задачу");
    }
    const taskIdentity = await prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, status: true, version: true },
    });
    if (!taskIdentity) {
      return apiError(
        "TASK_NOT_FOUND",
        "Задача не найдена",
        undefined,
        404,
      );
    }
    await requireProjectWrite(user, taskIdentity.projectId);

    const repository = new PrismaMoveRepository(prisma, {
        taskId,
        toColumnId: parsed.toColumnId,
        operationId: parsed.operationId,
        actorId: user.id,
    });
    const bearer = request.headers.get("authorization")?.toLowerCase().startsWith("bearer ");
    const result = await moveTask({
      taskId,
      request: parsed,
      repository: bearer ? actorBoundRepository(repository, user.id) : repository,
      ranks: createBase36RankService(),
    });

    // Post-commit effects: the move is already durable, so automation or
    // diagnostics failures never replace the committed response.
    try {
      await processMoveAutomation({
        taskId,
        projectId: taskIdentity.projectId,
        userId: user.id,
        previousStatus: taskIdentity.status,
        result,
        // A stored operationId replay returns the historical response without
        // writing, so its version never advances past the pre-move read. A
        // committed move always increments the version, including when another
        // writer moved the task between this read and the transaction.
        replayed: result.task.version <= taskIdentity.version,
      });
    } catch (error) {
      try { apiLogger.error({ event: "task.move.automation.failed", route: "/api/tasks/:id/move", err: error }); }
      catch { /* A committed move survives automation and diagnostic failures. */ }
    }

    await emitTaskMoved(taskIdentity.projectId, result);
    return apiSuccess(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiError(
        "VALIDATION_ERROR",
        "Некорректные параметры перемещения",
        undefined,
        422,
      );
    }
    if (error instanceof MoveTaskError) {
      return moveErrorResponse(error);
    }
    if (error instanceof NotFoundError) {
      return apiError(
        "TASK_NOT_FOUND",
        "Задача не найдена",
        undefined,
        404,
      );
    }
    return apiInternalError("Не удалось переместить задачу");
  }
}
