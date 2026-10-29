import { NextRequest } from "next/server";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { getNotifications } from "@/lib/notifications";
import { apiSuccess, apiUnauthorized, apiInternalError } from "@/lib/api-response";
import { apiLogger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiUser(request);

    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");
    const unreadOnly = searchParams.get("unreadOnly") === "true";

    const notifications = await getNotifications(user.id, {
      limit,
      offset,
      unreadOnly,
    });

    return apiSuccess(notifications, {
      limit,
      offset,
      total: notifications.length,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ event: "notifications.list.failed", err: error }, "Failed to fetch notifications");
    return apiInternalError("Не удалось загрузить уведомления");
  }
}
