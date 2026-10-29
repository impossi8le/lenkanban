import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiUser } from "@/lib/require-api-user";
import {
  apiError,
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiBadRequest,
  apiInvalidJson,
  apiValidationError,
  apiInternalError,
  apiForbidden,
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
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { readVisibleTaskAttachments } from "@/lib/attachments/task-port";
import { processBulkMoveAutomation } from "@/lib/automation-processor";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";

const bulkUpdateSchema = z.object({
  taskIds: z.array(z.string().cuid()).min(1, "Требуется хотя бы один ID задачи")
    .max(200, "Не более 200 задач за один запрос"),
  updates: z.object({
    status: z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]).optional(),
    priority: taskPrioritySchema.optional(),
    columnId: z.string().min(1).optional(),
  }).refine(
    (data) =>
      data.status !== undefined ||
      data.priority !== undefined ||
      data.columnId !== undefined,
    "Необходимо обновить хотя бы одно поле"
  ),
});

export async function PATCH(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  const parsed = bulkUpdateSchema.safeParse(json);
  if (!parsed.success) return apiValidationError(parsed.error);
  const data = parsed.data;
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

  try {
    const user = await requireApiUser(request);
    // One admission per batch, shared with POST /api/tasks/bulk-update.
    try {
      await rateLimitOrThrowKey("tasks:bulk", user.id);
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 429) return rateLimitErrorResponse(error);
      return apiInternalError("Не удалось обновить задачи");
    }

    // Find all tasks and check access
    const tasks = await prisma.task.findMany({
      where: await getTaskReadWhere(user, { id: { in: data.taskIds } }),
      include: {
        project: {
          select: {
            id: true,
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { id: true },
            },
          },
        },
      },
    });

    if (tasks.length === 0) {
      return apiNotFound();
    }

    if (tasks.length !== new Set(data.taskIds).size) {
      return apiNotFound();
    }

    // Check project access for all tasks
    if (user.globalRole !== "ADMIN") {
      for (const task of tasks) {
        const hasAccess =
          task.project.ownerId === user.id || task.project.members.length > 0;
        if (!hasAccess) {
          return apiUnauthorized();
        }
      }
    }

    // Workflow status before the canonical relocation. The relocation re-checks
    // identity and version inside its transaction, so a stale row cannot commit.
    const previousStatusById = new Map(tasks.map(task => [task.id, task.status]));

    // Perform bulk update in transaction
    const result = await prisma.$transaction(async (tx) => {
      const ranks = createBase36RankService();
      const relocationPort = createCanonicalTaskRelocationPort(
        tx,
        ranks,
        user.id,
      );
      const moves: Array<{
        projectId: string;
        move: NonNullable<
          Awaited<ReturnType<typeof relocateTaskToColumn>>
        >;
      }> = [];

      const mutationTasks = data.updates.columnId === undefined
        ? await prepareLegacyTaskScalarBatch({ tx, actorId: user.id, expectedTasks: tasks })
        : tasks.map(({ id, projectId, priority, version }) => ({ id, projectId, priority, version }));
      if (data.updates.columnId !== undefined) {
        for (const task of mutationTasks) {
          const canonicalMove = await relocateTaskToColumn({
            taskId: task.id,
            expectedProjectId: task.projectId,
            toColumnId: data.updates.columnId,
            expectedVersion: task.version,
            operationId: randomUUID(),
            port: relocationPort,
            ranks,
          });
          if (canonicalMove) {
            moves.push({ projectId: task.projectId, move: canonicalMove });
          }
        }
      }

      let priorityTasks: readonly { id: string; projectId: string; priority: string }[] = mutationTasks;
      if (data.updates.columnId !== undefined && data.updates.priority !== undefined) {
        const expectedProjects = new Map(mutationTasks.map(task => [task.id, task.projectId]));
        const freshRows: unknown = await tx.task.findMany({
          where: { id: { in: [...expectedProjects.keys()] } },
          select: { id: true, projectId: true, priority: true },
        });
        if (!Array.isArray(freshRows)) throw new Error("Invalid task priority snapshot");
        const freshTasks = new Map<string, { id: string; projectId: string; priority: string }>();
        for (const row of freshRows) {
          if (!row || typeof row !== "object" || Array.isArray(row)
            || Reflect.ownKeys(row).length !== 3) throw new Error("Invalid task priority snapshot");
          const id = Object.getOwnPropertyDescriptor(row, "id");
          const projectId = Object.getOwnPropertyDescriptor(row, "projectId");
          const priority = Object.getOwnPropertyDescriptor(row, "priority");
          if (!id || !("value" in id) || typeof id.value !== "string"
            || !projectId || !("value" in projectId) || typeof projectId.value !== "string"
            || !priority || !("value" in priority) || typeof priority.value !== "string"
            || !expectedProjects.has(id.value) || freshTasks.has(id.value)) {
            throw new Error("Invalid task priority snapshot");
          }
          if (projectId.value !== expectedProjects.get(id.value)) {
            throw new TaskCommandError("IDENTITY_CHANGED");
          }
          freshTasks.set(id.value, { id: id.value, projectId: projectId.value, priority: priority.value });
        }
        priorityTasks = mutationTasks.map(task => {
          const fresh = freshTasks.get(task.id);
          if (!fresh) throw new NotFoundError();
          return fresh;
        });
      }

      for (const task of priorityTasks) {
        const priorityChanged =
          data.updates.priority &&
          data.updates.priority !== task.priority;

        if (priorityChanged) {
          await tx.task.update({
            where: { id: task.id },
            data: {
              priority: data.updates.priority,
            },
          });
          await tx.activity.create({
            data: {
              taskId: task.id,
              userId: user.id,
              action: "priority_changed",
              oldValue: { priority: task.priority },
              newValue: { priority: data.updates.priority },
            },
          });
        }
      }
      const updatedTasks = await tx.task.findMany({
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
            orderBy: { position: "asc" },
          },
          project: {
            select: { id: true },
          },
          _count: {
            select: { messages: true },
          },
        },
      });
      return { moves, tasks: updatedTasks };
    });

    // Emit real-time updates for all updated tasks
    for (const { projectId, move } of result.moves) {
      const task = result.tasks.find(task => task.id === move.task.id);
      if (!task || task.projectId !== projectId || task.project.id !== projectId) continue;
      try {
        await emitTaskMoved(projectId, structuredClone(move));
      } catch {
        try {
          await apiLogger.warn({ event: "task.bulk.move.realtime.failed", route: "/api/tasks/bulk" });
        } catch { /* Diagnostics cannot replace committed success. */ }
      }
    }
    for (const task of result.tasks) {
      if (task.projectId !== task.project.id) continue;
      try {
        await emitTaskUpdated(task.projectId, structuredClone(task));
      } catch {
        try {
          await apiLogger.warn({ event: "task.bulk.update.realtime.failed", route: "/api/tasks/bulk" });
        } catch { /* Diagnostics cannot replace committed success. */ }
      }
    }

    // Post-commit automation: one `status_changed` event per row whose derived
    // workflow status actually changed. Same-column moves and unchanged
    // statuses are dropped by the shared builder, and one task never repeats.
    if (result.moves.length > 0) {
      try {
        await processBulkMoveAutomation(result.moves.map(({ projectId, move }) => ({
          taskId: move.task.id,
          projectId,
          userId: user.id,
          previousStatus: previousStatusById.get(move.task.id) ?? move.task.status,
          result: move,
        })));
      } catch (error) {
        try { apiLogger.error({ event: "task.bulk.automation.failed", route: "/api/tasks/bulk", err: error }); }
        catch { /* A committed batch survives automation and diagnostic failures. */ }
      }
    }

    const projectedTasks = await Promise.all(result.tasks.map(async task => {
      const attachments = await readVisibleTaskAttachments(prisma, user, task.projectId, task.attachments);
      return attachments === undefined ? task : { ...task, attachments };
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
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
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
      return apiBadRequest("Колонка не принадлежит проекту задачи");
    }
    return apiInternalError("Не удалось обновить задачи");
  }
}
