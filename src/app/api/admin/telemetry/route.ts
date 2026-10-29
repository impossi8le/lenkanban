import { apiSuccess, apiUnauthorized, apiForbidden } from "@/lib/api-response";
import { withApiLogging } from "@/middleware/api-logger";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isGlobalAdmin } from "@/lib/require-user";
import { readAdminTelemetry } from "@/lib/telemetry/store";
import { auditTelemetryView, parseTelemetryReportFilters } from "@/lib/telemetry/reports";
import {
  requireTelemetryConfiguration,
  TelemetryHttpError,
  telemetryFailure,
  telemetryNoStore,
} from "@/lib/telemetry/http";

export async function GET(request: Request): Promise<Response> {
  return withApiLogging(request, async (request, logContext) => {
    try {
      const actor = await requireApiUser(request);
      logContext.actorId = actor.id;
      if (!isGlobalAdmin(actor)) return telemetryNoStore(apiForbidden());
      requireTelemetryConfiguration();
      const params = new URL(request.url).searchParams;
      const filters = parseTelemetryReportFilters(params, ["cursor", "limit", "category"]);
      const rawLimit = params.get("limit");
      if (rawLimit !== null && !/^[0-9]{1,3}$/.test(rawLimit)) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_LIMIT");
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (limit < 1 || limit > 100) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_LIMIT");
      const category = params.get("category");
      if (category !== null && category !== "usage" && category !== "diagnostic") {
        throw new TelemetryHttpError(400, "TELEMETRY_INVALID_CATEGORY");
      }
      const cursor = params.get("cursor");
      if (cursor !== null && !cursor) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_CURSOR");
      const page = await readAdminTelemetry({
        ...filters,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(category ? { category } : {}),
      });
      auditTelemetryView(actor.id, "events");
      return telemetryNoStore(apiSuccess(page));
    } catch (error) {
      if (error instanceof UnauthorizedError) return telemetryNoStore(apiUnauthorized());
      return telemetryNoStore(telemetryFailure(error));
    }
  }, { route: "/api/admin/telemetry" });
}
