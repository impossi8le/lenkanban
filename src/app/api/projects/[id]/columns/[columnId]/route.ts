import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireApiUser } from "@/lib/require-api-user";
import { emitColumnUpdated, emitColumnDeleted } from "@/socket/board-events";
import {
  ColumnDeletionError,
  createColumnDeletionPort,
  deleteProjectColumn,
} from "@/features/kanban/server/column-deletion";
import {
  apiError,
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiBadRequest,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const updateColumnSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9A-F]{6}$/i, "Неверный hex-цвет").optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; columnId: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id: projectId, columnId } = await params;
    const body = await request.json();
    const parsed = updateColumnSchema.parse(body);

    // Find column and check it belongs to the project
    const column = await prisma.projectColumn.findFirst({
      where: { id: columnId, projectId },
      include: {
        project: {
          select: {
            id: true,
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { role: true },
            },
          },
        },
      },
    });

    if (!column) {
      return apiNotFound();
    }

    // Check permissions - only owner or PROJECT_ADMIN can update columns
    if (user.globalRole !== "ADMIN") {
      const isOwner = column.project.ownerId === user.id;
      const isProjectAdmin = column.project.members.some((m) => m.role === "PROJECT_ADMIN");

      if (!isOwner && !isProjectAdmin) {
        return apiUnauthorized();
      }
    }

    const updatedColumn = await prisma.projectColumn.update({
      where: { id: columnId },
      data: parsed,
    });

    emitColumnUpdated(projectId, updatedColumn, user.id);

    return apiSuccess(updatedColumn);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось обновить колонку");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; columnId: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id: projectId, columnId } = await params;

    // Find column and check it belongs to the project
    const column = await prisma.projectColumn.findFirst({
      where: { id: columnId, projectId },
      include: {
        project: {
          select: {
            id: true,
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { role: true },
            },
          },
        },
      },
    });

    if (!column) {
      return apiNotFound();
    }

    // Check permissions - only owner or PROJECT_ADMIN can delete columns
    if (user.globalRole !== "ADMIN") {
      const isOwner = column.project.ownerId === user.id;
      const isProjectAdmin = column.project.members.some((m) => m.role === "PROJECT_ADMIN");

      if (!isOwner && !isProjectAdmin) {
        return apiUnauthorized();
      }
    }

    await prisma.$transaction(async (tx) => {
      await deleteProjectColumn({
        projectId,
        columnId,
        port: createColumnDeletionPort(tx),
      });
    });

    emitColumnDeleted(projectId, columnId, user.id);

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    if (error instanceof ColumnDeletionError) {
      if (error.code === "COLUMN_NOT_FOUND") {
        return apiNotFound();
      }
      if (error.code === "LAST_COLUMN") {
        return apiBadRequest("Нельзя удалить последнюю колонку");
      }
      if (error.code === "LIFECYCLE_COLUMN") return apiError("LIFECYCLE_COLUMN", "Колонка используется маршрутом заявок", undefined, 409);
      return apiError(
        "COLUMN_NOT_EMPTY",
        "Нельзя удалить колонку с задачами",
        undefined,
        409,
      );
    }
    return apiInternalError("Не удалось удалить колонку");
  }
}
