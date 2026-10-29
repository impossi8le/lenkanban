import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiForbidden,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const template = await prisma.taskTemplate.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        project: {
          select: {
            id: true,
            name: true,
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

    return apiSuccess(template);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    console.error("Error fetching template:", error);
    return apiInternalError("Failed to fetch template");
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
    const body = json as {
      name?: string;
      description?: string | null;
      templateTitle?: string;
      templateDescription?: string | null;
      priority?: string;
      tags?: string[];
      checklistItems?: Prisma.InputJsonValue;
      estimatedDuration?: number | null;
    };

    const template = await prisma.taskTemplate.findUnique({
      where: { id },
      include: {
        project: {
          select: {
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

    const updated = await prisma.taskTemplate.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        templateTitle: body.templateTitle,
        templateDescription: body.templateDescription,
        priority: body.priority,
        tags: body.tags,
        checklistItems: body.checklistItems,
        estimatedDuration: body.estimatedDuration,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return apiSuccess(updated);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    console.error("Error updating template:", error);
    return apiInternalError("Failed to update template");
  }
}

export async function DELETE(
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

    await prisma.taskTemplate.delete({
      where: { id },
    });

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    console.error("Error deleting template:", error);
    return apiInternalError("Failed to delete template");
  }
}
