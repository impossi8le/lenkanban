import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { getUnreadNotificationSummary } from "@/lib/notifications";
import { apiSuccess, apiUnauthorized, apiInternalError } from "@/lib/api-response";
import { apiLogger } from "@/lib/logger";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const summary = await getUnreadNotificationSummary(user.id);
    const response = apiSuccess(summary); response.headers.set("Cache-Control","private, no-store"); return response;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ event: "notifications.unread_count.failed", err: error }, "Failed to fetch unread count");
    return apiInternalError("Не удалось получить количество непрочитанных уведомлений");
  }
}
