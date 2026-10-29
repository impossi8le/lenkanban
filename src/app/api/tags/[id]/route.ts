import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireApiUser } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiBadRequest,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const updateTagSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9A-F]{6}$/i, "Неверный hex-цвет").optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;
    const body = await request.json();
    const parsed = updateTagSchema.parse(body);

    // Find tag and check access
    const tag = await prisma.tag.findUnique({
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
      },
    });

    if (!tag) {
      return apiNotFound();
    }

    // Check project access
    if (user.globalRole !== "ADMIN") {
      const hasAccess =
        tag.project.ownerId === user.id || tag.project.members.length > 0;
      if (!hasAccess) {
        return apiUnauthorized();
      }
    }

    // Check for duplicate name if updating name
    if (parsed.name && parsed.name !== tag.name) {
      const existingTag = await prisma.tag.findFirst({
        where: {
          projectId: tag.projectId,
          name: parsed.name,
          id: { not: id },
        },
      });

      if (existingTag) {
        return apiBadRequest("Tag with this name already exists in project");
      }
    }

    const updatedTag = await prisma.tag.update({
      where: { id },
      data: parsed,
    });

    return apiSuccess(updatedTag);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось обновить тег");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    // Find tag and check access
    const tag = await prisma.tag.findUnique({
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
      },
    });

    if (!tag) {
      return apiNotFound();
    }

    // Check project access
    if (user.globalRole !== "ADMIN") {
      const hasAccess =
        tag.project.ownerId === user.id || tag.project.members.length > 0;
      if (!hasAccess) {
        return apiUnauthorized();
      }
    }

    await prisma.tag.delete({
      where: { id },
    });

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось удалить тег");
  }
}
