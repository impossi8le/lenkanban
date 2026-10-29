import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { getProjectReadWhere } from "@/lib/project-access";
import { z } from "zod";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiInvalidJson,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const project = await prisma.project.findFirst({
      where: { AND: [{ id }, await getProjectReadWhere(user)] },
      include: {
        owner: {
          select: { id: true, email: true, name: true, avatarUrl: true },
        },
        _count: {
          select: { tasks: { where: await getTaskReadWhere(user, {}, prisma, { projectId: id }) }, members: true },
        },
      },
    });

    if (!project) {
      return apiNotFound("Проект не найден");
    }

    return apiSuccess(project);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить проект");
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    const { id } = await params;
    const parsed = updateProjectSchema.parse(json);

    // Rate limiting
    try {
      await rateLimitOrThrowKey("projects:update", user.id);
    } catch (e) {
      return rateLimitErrorResponse(e);
    }

    // Check if project exists and user has permission
    const project = await prisma.project.findFirst({
      where: user.globalRole === "ADMIN"
        ? { id }
        : {
            id,
            OR: [
              { ownerId: user.id },
              { members: { some: { userId: user.id, role: "PROJECT_ADMIN" } } },
            ],
          },
      select: { id: true },
    });

    if (!project) {
      return apiNotFound("Проект не найден");
    }

    const updated = await prisma.project.update({
      where: { id },
      data: parsed,
      include: {
        owner: {
          select: { id: true, email: true, name: true, avatarUrl: true },
        },
        _count: {
          select: { tasks: { where: await getTaskReadWhere(user) }, members: true },
        },
      },
    });

    return apiSuccess(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось обновить проект");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    // Rate limiting
    try {
      await rateLimitOrThrowKey("projects:delete", user.id);
    } catch (e) {
      return rateLimitErrorResponse(e);
    }

    // Only owner or admin can delete project
    const project = await prisma.project.findFirst({
      where: user.globalRole === "ADMIN"
        ? { id }
        : { id, ownerId: user.id },
      select: { id: true },
    });

    if (!project) {
      return apiNotFound("Проект не найден");
    }

    await prisma.project.delete({
      where: { id },
    });

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось удалить проект");
  }
}
