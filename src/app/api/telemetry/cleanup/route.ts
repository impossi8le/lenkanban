import { apiSuccess, apiUnauthorized } from "@/lib/api-response";
import { withApiLogging } from "@/middleware/api-logger";
import { hasConfiguredServiceSecret, isServiceBearerAuthorized } from "@/lib/service-auth";
import { cleanupTelemetry, projectPendingChecklistTelemetry } from "@/lib/telemetry/store";
import {
  requireTelemetryConfiguration,
  TelemetryHttpError,
  telemetryFailure,
  telemetryNoStore,
} from "@/lib/telemetry/http";

export async function POST(request: Request): Promise<Response> {
  return withApiLogging(request, async (request) => {
    try {
      requireTelemetryConfiguration();
      const secret = process.env.CRON_SECRET;
      if (!hasConfiguredServiceSecret(secret)) throw new TelemetryHttpError(503, "TELEMETRY_CLEANUP_UNAVAILABLE");
      if (!isServiceBearerAuthorized(request.headers.get("authorization"), secret)) {
        return telemetryNoStore(apiUnauthorized());
      }
      await projectPendingChecklistTelemetry(50);
      return telemetryNoStore(apiSuccess(await cleanupTelemetry(new Date(), 5000)));
    } catch (error) {
      return telemetryNoStore(telemetryFailure(error));
    }
  }, { route: "/api/telemetry/cleanup" });
}
