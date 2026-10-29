import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiError,
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiBadRequest,
  apiForbidden,
  apiInternalError
} from "@/lib/api-response";
import { emitTaskCreated } from "@/socket/board-events";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import {
  allocateAppendRank,
  createGuardedAppendTaskRankPort,
  TaskRankMaintenanceError,
} from "@/features/kanban/server/append-task-rank";
import { derivedTaskStatus } from "@/features/kanban/server/move-contract";
import { apiLogger } from "@/lib/logger";
import { ForbiddenError } from "@/lib/errors";
import { getProjectCreationPolicy } from "@/lib/project-creation-policy";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const template = await prisma.taskTemplate.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            id: true,
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!template) {
      return apiNotFound();
    }

    // Check access
    const hasAccess =
      user.globalRole === "ADMIN" ||
      template.project.ownerId === user.id ||
      template.project.members.length > 0;

    if (!hasAccess) {
      return apiForbidden("Access denied");
    }

    // Get the first column of the project for the new task
    const firstColumn = await prisma.projectColumn.findFirst({
      where: { projectId: template.projectId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });

    if (!firstColumn) {
      return apiBadRequest("Project has no columns");
    }

    const completeTask = await prisma.$transaction(async (tx) => {
      const creationPolicy = await getProjectCreationPolicy(user, template.projectId, tx);
      if (!creationPolicy.canCreate || creationPolicy.allowedColumnIds?.length === 0) throw new ForbiddenError();
      const column = creationPolicy.allowedColumnIds === null ? firstColumn : await tx.projectColumn.findFirst({
        where: { id: creationPolicy.allowedColumnIds[0], projectId: template.projectId },
      });
      if (!column) throw new ForbiddenError();
      const ranks = createBase36RankService();
      const rank = await allocateAppendRank({
        columnId: column.id,
        port: createGuardedAppendTaskRankPort(tx, ranks),
        ranks,
      });
      const lastTask = await tx.task.findFirst({
        where: { columnId: column.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      const task = await tx.task.create({
        data: {
          title: template.templateTitle,
          description: template.templateDescription,
          priority: template.priority,
          status: derivedTaskStatus(column.workflowKey),
          position: lastTask ? lastTask.position + 1 : 0,
          rank,
          projectId: template.projectId,
          columnId: column.id,
          createdById: user.id,
        },
      });
      if (!task || typeof task.id !== "string" || task.id.length === 0
        || task.projectId !== template.projectId || task.columnId !== column.id) {
        throw new Error("Invalid created task identity");
      }

      // Child records and the authoritative response belong to the same commit.
      const checklistItems = template.checklistItems as Array<{ text: string; completed: boolean }>;
      if (checklistItems && checklistItems.length > 0) {
        await tx.taskChecklistItem.createMany({
          data: checklistItems.map((item, index) => ({
            taskId: task.id,
            text: item.text,
            completed: false, // Always start uncompleted
            position: index,
          })),
        });
      }

      const tagNames = template.tags as string[];
      if (tagNames && tagNames.length > 0) {
        for (const tagName of tagNames) {
          let tag = await tx.tag.findFirst({
            where: {
              projectId: template.projectId,
              name: tagName,
            },
          });

          if (!tag) {
            // Preserve the existing random color palette for new tags.
            const colors = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981", "#06b6d4", "#3b82f6", "#0ea5e9", "#ec4899"];
            const randomColor = colors[Math.floor(Math.random() * colors.length)];

            tag = await tx.tag.create({
              data: {
                name: tagName,
                color: randomColor,
                projectId: template.projectId,
              },
            });
          }

          await tx.taskTag.create({
            data: {
              taskId: task.id,
              tagId: tag.id,
            },
          });
        }
      }

      const projection = await tx.task.findUnique({
        where: { id: task.id },
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
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });
      if (!projection || projection.id !== task.id || projection.projectId !== template.projectId
        || projection.columnId !== column.id) {
        throw new Error("Invalid task creation projection");
      }
      return projection;
    });

    const response = apiSuccess(completeTask, undefined, 201);
    void (async () => {
      try {
        await emitTaskCreated(completeTask.projectId, structuredClone(completeTask));
      } catch {
        try {
          await apiLogger.warn({ event: "template.use.realtime.failed", route: "/api/templates/:id/use" });
        } catch { /* Diagnostics cannot replace a committed response. */ }
      }
    })();
    return response;
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof TaskRankMaintenanceError) {
      return apiError(error.code, "Создание задачи недоступно", undefined, 409);
    }
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    try {
      await apiLogger.error({ event: "template.use.failed", route: "/api/templates/:id/use" });
    } catch { /* Diagnostics cannot replace the safe failure response. */ }
    return apiInternalError("Failed to create task from template");
  }
}
