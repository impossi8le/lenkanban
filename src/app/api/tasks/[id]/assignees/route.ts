import { prisma } from "@/lib/prisma";
import { ownTaskProjectIds } from "@/lib/access-policy";
import { z } from "zod";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiBadRequest,
  apiNotFound,
  apiForbidden,
  apiInvalidJson,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";
import { notifyTaskAssigned } from "@/lib/notification-triggers";
import { processAutomationRules } from "@/lib/automation-processor";
import { emitTaskUpdated } from "@/socket/board-events";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { TaskCommandError } from "@/lib/task-command";
import { replaceTaskAssigneesWithClient } from "@/lib/task-assignees";
import { BadRequestError, NotFoundError, ForbiddenError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { readVisibleTaskAttachments } from "@/lib/attachments/task-port";

const updateAssigneesSchema = z.object({
  userIds: z.array(z.string()).transform(ids => [...new Set(ids)]),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    const params = await context.params;
    const parsed = updateAssigneesSchema.parse(json);

    // Get task and check access
    const task = await prisma.task.findUnique({
      where: { id: params.id },
      include: { project: true },
    });

    if (!task) {
      return apiNotFound("Задача не найдена");
    }

    // Legacy bulk assignment is not a lifecycle capability. Keep it closed on
    // opted-in boards until the single-executor command is integrated.
    if (ownTaskProjectIds(process.env.LENKANBAN_OWN_TASK_PROJECT_IDS).includes(task.projectId)) {
      if (user.globalRole !== "ADMIN") return apiNotFound("Задача не найдена");
      if (parsed.userIds.length > 1) return apiBadRequest("У заявки может быть только один исполнитель");
    }

    // Check if user has access to this project
    const hasAccess =
      user.globalRole === "ADMIN" ||
      task.project.ownerId === user.id ||
      (await prisma.projectMember.findFirst({
        where: {
          projectId: task.projectId,
          userId: user.id,
        },
      })) !== null;

    if (!hasAccess) {
      return apiForbidden("Доступ запрещен");
    }

    // Verify all users are members of the project
    if (parsed.userIds.length > 0) {
      const projectMembers = await prisma.projectMember.findMany({
        where: {
          projectId: task.projectId,
          userId: { in: parsed.userIds },
        },
      });

      const ownerCheck = await prisma.project.findFirst({
        where: {
          id: task.projectId,
          ownerId: { in: parsed.userIds },
        },
      });

      const validUserIds = new Set([
        ...projectMembers.map((m) => m.userId),
        ...(ownerCheck ? [ownerCheck.ownerId] : []),
      ]);

      const invalidUsers = parsed.userIds.filter((id) => !validUserIds.has(id));
      if (invalidUsers.length > 0) {
        return apiBadRequest("Некоторые пользователи не являются участниками проекта");
      }
    }

    const result = await prisma.$transaction(async tx => {
      return replaceTaskAssigneesWithClient({
        tx, actorId: user.id, taskId: params.id, projectId: task.projectId, userIds: parsed.userIds,
      });
    });

    // Send notifications to newly assigned users
    if (result.added.length > 0) {
      const assignerName = user.name || user.email;
      for (const assigneeId of result.added) {
        try {
          void notifyTaskAssigned({
            taskId: params.id,
            taskTitle: result.title,
            projectId: result.projectId,
            assigneeId,
            assignedById: user.id,
            assignedByName: assignerName,
          }).catch(error => reportDeliveryFailure("assignees.notification.failed", error));
        } catch (error) { reportDeliveryFailure("assignees.notification.failed", error); }
      }

      // Process automation rules for assignee added
      try {
        void processAutomationRules({
          trigger: "assignee_added",
          taskId: params.id,
          projectId: result.projectId,
          userId: user.id,
          task: structuredClone(result.updatedTask),
        }).catch(error => reportDeliveryFailure("assignees.automation.failed", error));
      } catch (error) { reportDeliveryFailure("assignees.automation.failed", error); }
    }

    // Emit real-time update with full relations including _count.messages
    try {
      const fullTask = await loadTaskWithRelations(params.id);
      if (fullTask?.project.id === result.projectId) await emitTaskUpdated(result.projectId, fullTask);
    } catch (error) { reportDeliveryFailure("assignees.realtime.failed", error); }

    const attachments = await readVisibleTaskAttachments(prisma, user, result.projectId, result.updatedTask.attachments);
    return apiSuccess(attachments === undefined ? result.updatedTask : { ...result.updatedTask, attachments });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound("Задача не найдена");
    if (error instanceof BadRequestError) return apiBadRequest("Некоторые пользователи не являются участниками проекта");
    if (error instanceof TaskCommandError) return apiError(error.code, "Task assignee mutation rejected; refresh before a new action", undefined, 409);
    return apiInternalError("Не удалось обновить исполнителей задачи");
  }
}

function reportDeliveryFailure(event: "assignees.notification.failed" | "assignees.automation.failed" | "assignees.realtime.failed", error: unknown) {
  try { apiLogger.warn({ event, route: "/api/tasks/:id/assignees", err: error }); }
  catch { /* Diagnostics cannot change a committed response or suppress other effects. */ }
}
