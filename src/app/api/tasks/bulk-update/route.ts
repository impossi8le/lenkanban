import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth";
import { nextAuthOptions } from "@/lib/nextauth";
import { prisma } from "@/lib/prisma";
import { ownTaskProjectIds } from "@/lib/access-policy";
import { z } from "zod";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import {
  apiError,
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiForbidden,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";
import {
  emitTaskMoved,
  emitTaskUpdated,
} from "@/socket/board-events";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import {
  createCanonicalTaskRelocationPort,
  relocateTaskToColumn,
  TaskRelocationError,
  validateColumnDerivedStatusUpdate,
} from "@/features/kanban/server/task-relocation";
import { taskPrioritySchema } from "@/lib/validators";
import { prepareLegacyTaskScalarBatch, TaskCommandError } from "@/lib/task-command";
import { NotFoundError } from "@/lib/errors";
import { requireTaskDeadlineExecutor } from "@/lib/task-field-policy";
import { apiLogger } from "@/lib/logger";
import { publicTaskAttachmentDTOs, readVisibleTaskAttachments } from "@/lib/attachments/task-port";
import { processBulkMoveAutomation } from "@/lib/automation-processor";

const bulkUpdateSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(200, "Не более 200 задач за один запрос"),
  updates: z
    .object({
      status: z.string().optional(),
      priority: taskPrioritySchema.optional(),
      columnId: z.string().min(1).optional(),
      deadline: z.string().datetime().nullable().optional(),
    })
    // An empty batch used to answer 200 with "updatedCount" although nothing
    // was written; refuse it the same way the sibling bulk PATCH does.
    .refine(
      updates =>
        updates.priority !== undefined ||
        updates.columnId !== undefined ||
        updates.deadline !== undefined ||
        updates.status !== undefined,
      "Необходимо обновить хотя бы одно поле",
    ),
});

// POST /api/tasks/bulk-update - Update multiple tasks at once
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(nextAuthOptions);
    const userId = (
      session?.user as { id?: string } | undefined
    )?.id;
    if (!userId) {
      return apiUnauthorized();
    }

    // Validate bounded collections before quota or business work. Authentication
    // remains first; the patched validator rejects over200 without visiting IDs.
    const body = await req.json();
    const data = bulkUpdateSchema.parse(body);

    // Rate limiting
    try {
      await rateLimitOrThrowKey("tasks:bulk", userId);
    } catch (e) {
      return rateLimitErrorResponse(e);
    }

    try {
      validateColumnDerivedStatusUpdate(data.updates);
    } catch (error) {
      if (!(error instanceof TaskRelocationError)) {
        throw error;
      }
      return apiError(
        "STATUS_REQUIRES_COLUMN",
        "status can only be changed by selecting a column",
        undefined,
        422,
      );
    }

    // Fetch all tasks to verify access
    const ownBoards = ownTaskProjectIds(process.env.LENKANBAN_OWN_TASK_PROJECT_IDS);
    const tasks = await prisma.task.findMany({
      where: {
        id: { in: data.taskIds },
        ...(ownBoards.length > 0 ? { projectId: { notIn: ownBoards } } : {}),
      },
      include: {
        project: {
          include: {
            members: {
              where: { userId },
            },
          },
        },
      },
    });

    if (tasks.length === 0) {
      return apiNotFound("Задачи не найдены");
    }
    if (tasks.length !== new Set(data.taskIds).size) {
      return apiNotFound("Задачи не найдены");
    }

    // Verify user has access to all tasks
    for (const task of tasks) {
      const isOwner = task.project.ownerId === userId;
      const isMember = task.project.members.length > 0;

      if (!isOwner && !isMember) {
        return apiForbidden("Нет доступа к одной или нескольким задачам");
      }
    }

    // Workflow status before the canonical relocation. The relocation re-checks
    // identity and version inside its transaction, so a stale row cannot commit.
    const previousStatusById = new Map(tasks.map(task => [task.id, task.status]));

    // Derive compatibility status and append ordering for every column move in
    // the same transaction as the task updates.
    const canonicalMoves = await prisma.$transaction(async (tx) => {
      const ranks = createBase36RankService();
      const relocationPort = createCanonicalTaskRelocationPort(
        tx,
        ranks,
        userId,
      );
      const moves: Array<{
        projectId: string;
        move: NonNullable<
          Awaited<ReturnType<typeof relocateTaskToColumn>>
        >;
      }> = [];

      const mutationTasks = data.updates.columnId === undefined
        ? await prepareLegacyTaskScalarBatch({ tx, actorId: userId, expectedTasks: tasks, requireOwnerOrMember: true })
        : tasks;
      for (const task of mutationTasks) {
        const canonicalMove =
          data.updates.columnId === undefined
            ? null
            : await relocateTaskToColumn({
                taskId: task.id,
                expectedProjectId: task.projectId,
                toColumnId: data.updates.columnId,
                expectedVersion: task.version,
                operationId: randomUUID(),
                port: relocationPort,
                ranks,
              });
        // Both admission paths above hold this Task lock. Assignment writers
        // use the same lock; deadline set and removal require its sole executor,
        // including ADMIN. A refusal rolls the entire batch/move back.
        if (data.updates.deadline !== undefined) {
          await requireTaskDeadlineExecutor(tx, userId, task.id);
        }
        if (canonicalMove) {
          moves.push({ projectId: task.projectId, move: canonicalMove });
        }
        const scalarData = {
          ...(data.updates.priority !== undefined &&
            data.updates.priority !== task.priority && {
              priority: data.updates.priority,
            }),
          ...(data.updates.deadline !== undefined && {
            deadline: data.updates.deadline
              ? new Date(data.updates.deadline)
              : null,
          }),
        };
        if (Object.keys(scalarData).length > 0) {
          await tx.task.update({
            where: { id: task.id },
            data: scalarData,
          });
        }
      }
      return moves;
    });

    // Fetch updated tasks to return
    const updatedTasks = await prisma.task.findMany({
      where: {
        id: { in: data.taskIds },
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
          orderBy: {
            position: "asc",
          },
        },
        project: {
          select: { id: true },
        },
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });

    // Emit real-time updates for each task. The batch is already committed, so a
    // transport failure must not turn a successful mutation into a 500 that
    // makes the client retry and duplicate the action.
    for (const { projectId, move } of canonicalMoves) {
      try {
        await emitTaskMoved(projectId, structuredClone(move));
      } catch {
        try { apiLogger.warn({ event: "task.bulk.move.realtime.failed", route: "/api/tasks/bulk-update" }); }
        catch { /* Diagnostics cannot replace committed success. */ }
      }
    }
    for (const task of updatedTasks) {
      try {
        emitTaskUpdated(task.project.id, task);
      } catch {
        try { apiLogger.warn({ event: "task.bulk.update.realtime.failed", route: "/api/tasks/bulk-update" }); }
        catch { /* Diagnostics cannot replace committed success. */ }
      }
    }

    // Post-commit automation: one `status_changed` event per row whose derived
    // workflow status actually changed. Same-column moves and unchanged
    // statuses are dropped by the shared builder, and one task never repeats.
    if (canonicalMoves.length > 0) {
      try {
        await processBulkMoveAutomation(canonicalMoves.map(({ projectId, move }) => ({
          taskId: move.task.id,
          projectId,
          userId,
          previousStatus: previousStatusById.get(move.task.id) ?? move.task.status,
          result: move,
        })));
      } catch (error) {
        try { apiLogger.error({ event: "task.bulk.automation.failed", route: "/api/tasks/bulk-update", err: error }); }
        catch { /* A committed batch survives automation and diagnostic failures. */ }
      }
    }

    const hasAttachmentMetadata = updatedTasks.some(task =>
      task.attachments !== undefined && task.attachments !== null);
    const actor = hasAttachmentMetadata
      ? await prisma.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true } })
      : null;
    const projectedTasks = await Promise.all(updatedTasks.map(async task => {
      if (task.attachments === undefined || task.attachments === null) return task;
      const attachments = actor
        ? await readVisibleTaskAttachments(prisma, actor, task.project.id, task.attachments)
        : publicTaskAttachmentDTOs(task.attachments);
      return { ...task, attachments };
    }));
    return apiSuccess({
      success: true,
      updatedCount: projectedTasks.length,
      tasks: projectedTasks,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof NotFoundError) return apiNotFound();
    if (error instanceof TaskCommandError) {
      return apiError(error.code, "Task batch rejected; refresh before a new action", undefined, 409);
    }
    if (error instanceof TaskRelocationError) {
      if (error.code === "REQUEST_LIFECYCLE_NOT_ENABLED" || error.code === "INVALID_REQUEST_MARKER") {
        return apiError(error.code, "Перемещение задачи недоступно", undefined, 409);
      }
      if (error.code === "INVALID_MOVE_ROUTE") {
        return apiError(error.code, "Недопустимый маршрут перемещения задачи", undefined, 422);
      }
      if (error.code === "TASK_NOT_FOUND") {
        return apiNotFound("Задача не найдена");
      }
      if (error.code === "STALE_TASK_VERSION") {
        return apiError(
          error.code,
          "Задача была изменена. Обновите доску и повторите попытку",
          undefined,
          409,
        );
      }
      return apiError(
        "INVALID_TARGET_COLUMN",
        "Колонка не принадлежит проекту задачи",
        undefined,
        400,
      );
    }

    try {
      apiLogger.error({ event: "task.bulk.failed", route: "/api/tasks/bulk-update", err: error });
    } catch { /* No raw fallback; diagnostics cannot replace the safe response. */ }
    return apiInternalError("Не удалось массово обновить задачи");
  }
}
