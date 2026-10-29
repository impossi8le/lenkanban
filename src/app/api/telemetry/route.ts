import { apiSuccess, apiUnauthorized } from "@/lib/api-response";
import { withApiLogging } from "@/middleware/api-logger";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { parseClientTelemetryBatch, parseTelemetrySessionStart } from "@/lib/telemetry/contract";
import {
  readTelemetryJson,
  requireTelemetryConfiguration,
  requireTelemetryOrigin,
  TelemetryHttpError,
  telemetryFailure,
  telemetryNoStore,
} from "@/lib/telemetry/http";
import {
  consumeTelemetryRateLimits,
  ingestTelemetryBatch,
  startTelemetrySession,
  telemetryActorKey,
} from "@/lib/telemetry/store";

export async function POST(request: Request): Promise<Response> {
  return withApiLogging(request, async (request, logContext) => {
    try {
      requireTelemetryConfiguration();
      requireTelemetryOrigin(request);
      const actor = await requireApiUser(request);
      logContext.actorId = actor.id;
      const actorKey = telemetryActorKey(actor.id);
      if (!actorKey) throw new TelemetryHttpError(503, "TELEMETRY_UNAVAILABLE");
      await consumeTelemetryRateLimits(actorKey);
      const body = await readTelemetryJson(request);
      const init = parseTelemetrySessionStart(body);
      if (init) {
        return telemetryNoStore(apiSuccess(await startTelemetrySession(actorKey, init.sessionId)));
      }
      const batch = parseClientTelemetryBatch(body);
      if (!batch) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_BATCH");
      const accepted = await ingestTelemetryBatch(actorKey, batch);
      return telemetryNoStore(apiSuccess({ accepted }));
    } catch (error) {
      if (error instanceof UnauthorizedError) return telemetryNoStore(apiUnauthorized());
      return telemetryNoStore(telemetryFailure(error));
    }
  }, { route: "/api/telemetry" });
}
