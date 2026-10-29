import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { markAllNotificationsRead } from "@/lib/notifications";
import { apiSuccess, apiUnauthorized, apiInternalError } from "@/lib/api-response";
import { apiLogger } from "@/lib/logger";

export async function PATCH(request: Request) {
  try {
    const user = await requireApiUser(request);
    await markAllNotificationsRead(user.id);
    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ event: "notifications.read_all.failed", err: error }, "Failed to mark all notifications as read");
    return apiInternalError("Не удалось отметить все уведомления как прочитанные");
  }
}
