import { NextRequest } from "next/server";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { markNotificationRead } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiNotFound, apiForbidden, apiUnauthorized, apiInternalError } from "@/lib/api-response";
import { apiLogger } from "@/lib/logger";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id: notificationId } = await params;

    // Verify notification belongs to user
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      select: { userId: true },
    });

    if (!notification) {
      return apiNotFound("Уведомление не найдено");
    }

    if (notification.userId !== user.id) {
      return apiForbidden("Доступ к этому уведомлению запрещен");
    }

    const updated = await markNotificationRead(notificationId, user.id);
    if (!updated) return apiNotFound("Уведомление не найдено");
    return apiSuccess(updated);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ event: "notifications.read.failed", err: error }, "Failed to mark notification as read");
    return apiInternalError("Не удалось отметить уведомление как прочитанное");
  }
}
