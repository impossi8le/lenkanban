import { prisma } from "@/lib/prisma";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiInternalError,
} from "@/lib/api-response";
import { apiLogger } from "@/lib/logger";
import { TaskRankMaintenanceError } from "@/features/kanban/server/append-task-rank";
import { emitTaskCreated } from "@/socket/board-events";
import {
  processRecurringOccurrence,
  RecurringProcessingError,
} from "@/lib/recurring-processor";
import { withApiLogging } from "@/middleware/api-logger";
import type { RequestLogContext } from "@/lib/request-context";
import { hasConfiguredServiceSecret, isServiceBearerAuthorized } from "@/lib/service-auth";

export function POST(request: Request) {
  return withApiLogging(request, processRecurringTasks, { route: "/api/recurring-tasks/process" });
}

async function processRecurringTasks(request: Request, context: RequestLogContext) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    if (!hasConfiguredServiceSecret(cronSecret)) {
      return apiError("SERVICE_UNAVAILABLE", "Recurring processor is not configured", undefined, 503);
    }
    if (!isServiceBearerAuthorized(authHeader, cronSecret)) {
      return apiUnauthorized();
    }

    const now = new Date();
    // The due list is an identity snapshot, never the source of template data.
    const candidates = await prisma.recurringTask.findMany({
      where: { active: true, nextRunAt: { lte: now } },
      select: { id: true, projectId: true, nextRunAt: true },
    });
    const results = [];

    for (const candidate of candidates) {
      try {
        const result = await processRecurringOccurrence({
          database: prisma,
          candidate: { id: candidate.id, projectId: candidate.projectId, scheduledAt: candidate.nextRunAt },
          now,
        });
        if (result.status === "created") {
          // The transaction has committed. Delivery cannot create or roll back
          // an occurrence and no retry can emit an already committed receipt.
          try {
            emitTaskCreated(result.projectId, result.task);
          } catch (error) {
            try {
              apiLogger.error({ ...context, recurringTaskId: candidate.id, event: "recurring.emit.failed", err: error });
            } catch { /* Neither delivery nor diagnostics can undo a commit. */ }
          }
          results.push({ recurringTaskId: candidate.id, taskId: result.task.id, success: true });
        } else if (result.status === "already_processed") {
          results.push({
            recurringTaskId: candidate.id,
            taskId: result.taskId,
            success: true,
            status: "already_processed",
          });
        } else if (result.status === "skipped" && result.reason === "missing_column") {
          apiLogger.error({
            ...context,
            projectId: candidate.projectId,
            recurringTaskId: candidate.id,
            event: "recurring.column.missing",
          });
        }
      } catch (error) {
        apiLogger.error({
          ...context,
          recurringTaskId: candidate.id,
          event: "job.failed",
          operation: "recurring.process",
          ...(error instanceof RecurringProcessingError || error instanceof TaskRankMaintenanceError
            ? { errorCode: error.code } : {}),
          err: error,
        });
        results.push({
          recurringTaskId: candidate.id,
          success: false,
          error: "Recurring occurrence failed",
        });
      }
    }

    return apiSuccess({ processed: results.length, results });
  } catch (error) {
    apiLogger.error({ ...context, event: "recurring.process.failed", err: error });
    return apiInternalError("Ошибка обработки повторяющихся задач");
  }
}
