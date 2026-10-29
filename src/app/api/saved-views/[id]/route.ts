import { NextRequest } from "next/server";
import { requireDbUser } from "@/lib/require-user";
import { requireProjectRead } from "@/lib/project-access";
import { UnauthorizedError, NotFoundError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiForbidden,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const updateSavedViewSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  viewType: z.enum(["board", "table", "calendar"]).optional(),
  filters: z.object({
    search: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    priority: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
  }).optional(),
  sortBy: z.string().optional(),
  isDefault: z.boolean().optional(),
});

// GET /api/saved-views/[id] - Get a specific saved view
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireDbUser(req);

    const { id } = await params;
    const savedView = await prisma.savedView.findUnique({
      where: { id },
    });

    if (!savedView) {
      return apiNotFound("Сохраненное представление не найдено");
    }

    // Check if user owns this saved view
    if (savedView.createdById !== user.id) {
      return apiForbidden("Нет доступа к этому представлению");
    }

    await requireProjectRead(user, savedView.projectId);

    return apiSuccess(savedView);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    if (error instanceof NotFoundError) return apiNotFound();
    apiLogger.error({ event: "api.request.failed", route: "/api/saved-views/:id", method: "GET", statusCode: 500 }, "Saved view request failed");
    return apiInternalError("Не удалось загрузить сохраненное представление");
  }
}

// PATCH /api/saved-views/[id] - Update a saved view
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireDbUser(req);

    const { id } = await params;
    const savedView = await prisma.savedView.findUnique({
      where: { id },
    });

    if (!savedView) {
      return apiNotFound("Сохраненное представление не найдено");
    }

    // Check if user owns this saved view
    if (savedView.createdById !== user.id) {
      return apiForbidden("Нет доступа к этому представлению");
    }

    await requireProjectRead(user, savedView.projectId);

    const body = await req.json();
    const data = updateSavedViewSchema.parse(body);

    // If setting as default, unset other defaults for this user/project
    if (data.isDefault) {
      await prisma.savedView.updateMany({
        where: {
          projectId: savedView.projectId,
          createdById: user.id,
          isDefault: true,
          id: { not: id },
        },
        data: {
          isDefault: false,
        },
      });
    }

    // Update the saved view
    const updated = await prisma.savedView.update({
      where: { id },
      data,
    });

    return apiSuccess(updated);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    if (error instanceof NotFoundError) return apiNotFound();
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }

    apiLogger.error({ event: "api.request.failed", route: "/api/saved-views/:id", method: "PATCH", statusCode: 500 }, "Saved view request failed");
    return apiInternalError("Не удалось обновить сохраненное представление");
  }
}

// DELETE /api/saved-views/[id] - Delete a saved view
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireDbUser(req);

    const { id } = await params;
    const savedView = await prisma.savedView.findUnique({
      where: { id },
    });

    if (!savedView) {
      return apiNotFound("Сохраненное представление не найдено");
    }

    // Check if user owns this saved view
    if (savedView.createdById !== user.id) {
      return apiForbidden("Нет доступа к этому представлению");
    }

    await requireProjectRead(user, savedView.projectId);

    await prisma.savedView.delete({
      where: { id },
    });

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    if (error instanceof NotFoundError) return apiNotFound();
    apiLogger.error({ event: "api.request.failed", route: "/api/saved-views/:id", method: "DELETE", statusCode: 500 }, "Saved view request failed");
    return apiInternalError("Не удалось удалить сохраненное представление");
  }
}
