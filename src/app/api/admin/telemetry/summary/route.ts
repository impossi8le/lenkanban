import { apiForbidden, apiSuccess, apiUnauthorized } from "@/lib/api-response";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isGlobalAdmin } from "@/lib/require-user";
import { telemetryFailure, telemetryNoStore } from "@/lib/telemetry/http";
import { auditTelemetryView, getTelemetrySummary, parseTelemetryReportFilters } from "@/lib/telemetry/reports";
import { withApiLogging } from "@/middleware/api-logger";

export async function GET(request: Request): Promise<Response> {
  return withApiLogging(request, async (request, context) => {
    try {
      const actor = await requireApiUser(request);
      context.actorId = actor.id;
      if (!isGlobalAdmin(actor)) return telemetryNoStore(apiForbidden());
      const filters = parseTelemetryReportFilters(new URL(request.url).searchParams);
      const summary = await getTelemetrySummary(filters);
      auditTelemetryView(actor.id, "summary");
      return telemetryNoStore(apiSuccess(summary));
    } catch (error) {
      if (error instanceof UnauthorizedError) return telemetryNoStore(apiUnauthorized());
      return telemetryNoStore(telemetryFailure(error));
    }
  }, { route: "/api/admin/telemetry/summary" });
}
