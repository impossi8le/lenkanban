import { prisma } from "@/lib/prisma";
import { apiLogger } from "@/lib/logger";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiForbidden,
  apiInternalError
} from "@/lib/api-response";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const template = await prisma.projectTemplate.findUnique({
      where: { id },
      select: { createdById: true },
    });

    if (!template) {
      return apiNotFound("Шаблон проекта не найден");
    }

    // Only creator or admin can delete
    if (template.createdById !== user.id && user.globalRole !== "ADMIN") {
      return apiForbidden("Нет доступа");
    }

    await prisma.projectTemplate.delete({
      where: { id },
    });

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    try {
      apiLogger.error({ event: "project.template.delete.failed", route: "/api/project-templates/:id" });
    } catch { /* Diagnostics must not replace the safe response. */ }
    return apiInternalError("Не удалось удалить шаблон проекта");
  }
}
