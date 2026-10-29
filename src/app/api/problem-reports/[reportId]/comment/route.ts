import { apiError, apiSuccess, apiUnauthorized } from "@/lib/api-response";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { withApiLogging } from "@/middleware/api-logger";
import { parseProblemReportComment, problemReportId } from "@/lib/problem-report-comment-contract";
import { ProblemReportCommentError, saveProblemReportComment } from "@/lib/problem-report-comment-store";
import { requireTelemetryConfiguration, requireTelemetryOrigin, readTelemetryJson, telemetryFailure, telemetryNoStore } from "@/lib/telemetry/http";
import { consumeTelemetryRateLimits, telemetryActorKey } from "@/lib/telemetry/store";

export async function POST(request: Request, { params }: { params: Promise<{ reportId: string }> }): Promise<Response> {
  return withApiLogging(request, async (request, context) => {
    try {
      requireTelemetryConfiguration();
      requireTelemetryOrigin(request);
      const actor = await requireApiUser(request);
      context.actorId = actor.id;
      const actorKey = telemetryActorKey(actor.id);
      if (!actorKey) throw new ProblemReportCommentError(503, "PROBLEM_REPORT_COMMENT_UNAVAILABLE");
      await consumeTelemetryRateLimits(actorKey);
      const id = problemReportId((await params).reportId);
      const body = parseProblemReportComment(await readTelemetryJson(request, { maxBytes: 12 * 1024 }));
      if (!id || !body) throw new ProblemReportCommentError(400, "PROBLEM_REPORT_COMMENT_INVALID");
      return telemetryNoStore(apiSuccess(await saveProblemReportComment(actorKey, id, body.comment)));
    } catch (error) {
      if (error instanceof UnauthorizedError) return telemetryNoStore(apiUnauthorized());
      if (error instanceof ProblemReportCommentError) return telemetryNoStore(apiError(error.code, "Не удалось сохранить комментарий к сообщению", undefined, error.status));
      return telemetryNoStore(telemetryFailure(error));
    }
  }, { route: "/api/problem-reports/:reportId/comment" });
}
