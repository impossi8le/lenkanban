import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireApiUser } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiNotFound,
  apiBadRequest,
  apiValidationError,
  apiInternalError,
  apiForbidden,
} from "@/lib/api-response";
import { logActivityWithClient } from "@/lib/activity-logger";
import { processAutomationRules } from "@/lib/automation-processor";
import { emitTaskUpdated } from "@/socket/board-events";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { prepareLegacyTaskScalarBatch, TaskCommandError } from "@/lib/task-command";
import { BadRequestError, NotFoundError, ForbiddenError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { readVisibleTaskAttachments } from "@/lib/attachments/task-port";

const updateTaskTagsSchema = z.object({
  tagIds: z.array(z.string().cuid()),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const parsed = updateTaskTagsSchema.parse(body);

    // Find task and check access
    const task = await prisma.task.findUnique({
      where: { id },
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
        tags: {
          include: {
            tag: true,
          },
        },
      },
    });

    if (!task) {
      return apiNotFound("Задача не найдена");
    }

    // Check project access
    if (user.globalRole !== "ADMIN") {
      const hasAccess =
        task.project.ownerId === user.id || task.project.members.length > 0;
      if (!hasAccess) {
        return apiUnauthorized();
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const [lockedTask] = await prepareLegacyTaskScalarBatch({
        tx, actorId: user.id, expectedTasks: [{ id, projectId: task.projectId }],
      });
      if (!lockedTask) throw new NotFoundError();
      // Preserve duplicate-ID rejection and project ownership validation, using
      // the same transaction as the guarded child mutation.
      if (parsed.tagIds.length > 0) {
        const tags = await tx.tag.findMany({
          where: {
            id: { in: parsed.tagIds },
            projectId: lockedTask.projectId,
          },
        });
        if (tags.length !== parsed.tagIds.length) throw new BadRequestError();
      }

      const currentTags = await tx.taskTag.findMany({
        where: { taskId: id }, include: { tag: true },
      });
      const oldTagIds = new Set(currentTags.map(t => t.tag.id));
      const newTagIds = new Set(parsed.tagIds);
      const addedTagIds = parsed.tagIds.filter(id => !oldTagIds.has(id));
      const removedTags = currentTags.filter(t => !newTagIds.has(t.tag.id));

      // Remove all existing tags
      await tx.taskTag.deleteMany({
        where: { taskId: id },
      });

      // Add new tags
      if (parsed.tagIds.length > 0) {
        await tx.taskTag.createMany({
          data: parsed.tagIds.map(tagId => ({
            taskId: id,
            tagId,
          })),
        });
      }

      // Log activities for added tags
      for (const tagId of addedTagIds) {
        const tag = await tx.tag.findUnique({
          where: { id: tagId },
          select: { name: true },
        });

        await logActivityWithClient(tx, {
          taskId: id,
          userId: user.id,
          action: 'tag_added',
          oldValue: null,
          newValue: { tagId, tagName: tag?.name },
        });
      }

      // Log activities for removed tags
      for (const taskTag of removedTags) {
        await logActivityWithClient(tx, {
          taskId: id,
          userId: user.id,
          action: 'tag_removed',
          oldValue: { tagId: taskTag.tag.id, tagName: taskTag.tag.name },
          newValue: null,
        });
      }

      // The response snapshot belongs to this transaction as well.
      const updatedTask = await tx.task.findUnique({
      where: { id },
      include: {
        assignees: {
          include: {
            user: {
              select: { id: true, email: true, name: true, avatarUrl: true },
            },
          },
        },
        tags: {
          include: {
            tag: true,
          },
        },
        checklistItems: {
          orderBy: { position: 'asc' },
        },
        project: {
          select: { id: true },
        },
      },
      });
      if (!updatedTask) throw new NotFoundError();
      return { updatedTask, addedTagIds, projectId: lockedTask.projectId };
    });

    // Process automation rules for tag added
    if (result.addedTagIds.length > 0) {
      try {
        void processAutomationRules({
          trigger: "tag_added",
          taskId: id,
          projectId: result.projectId,
          userId: user.id,
          task: structuredClone(result.updatedTask),
        }).catch(error => reportDeliveryFailure("tags.automation.failed", error));
      } catch (error) { reportDeliveryFailure("tags.automation.failed", error); }
    }

    // Emit real-time update with full relations
    try {
      const fullTask = await loadTaskWithRelations(id);
      if (fullTask?.project.id === result.projectId) await emitTaskUpdated(result.projectId, fullTask);
    } catch (error) { reportDeliveryFailure("tags.realtime.failed", error); }

    const attachments = await readVisibleTaskAttachments(prisma, user, result.projectId, result.updatedTask.attachments);
    return apiSuccess(attachments === undefined ? result.updatedTask : { ...result.updatedTask, attachments });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound("Задача не найдена");
    if (error instanceof BadRequestError) return apiBadRequest("Некоторые теги не принадлежат этому проекту");
    if (error instanceof TaskCommandError) return apiError(error.code, "Task tag mutation rejected; refresh before a new action", undefined, 409);
    return apiInternalError("Не удалось обновить теги задачи");
  }
}

function reportDeliveryFailure(event: "tags.automation.failed" | "tags.realtime.failed", error: unknown) {
  try { apiLogger.warn({ event, route: "/api/tasks/:id/tags", err: error }); }
  catch { /* A diagnostic sink cannot change a committed result. */ }
}
