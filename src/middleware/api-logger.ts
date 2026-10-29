import { apiLogger } from "@/lib/logger";
import type { RequestLogContext } from "@/lib/request-context";
import { apiHandlerErrorId, beginApiHandler, endApiHandler } from "@/lib/api-observation";
import { TELEMETRY_SERVER_ROUTES } from "@/lib/telemetry/catalog";
import type { ServerRequestTelemetry } from "@/lib/telemetry/report-contract";
import { validTraceId } from "@/lib/telemetry/breadcrumbs";

function reportRequest(context: RequestLogContext, details: Omit<ServerRequestTelemetry, "actorId" | "requestId" | "route">): void {
  if (process.env.TELEMETRY_ENABLED !== "true" || !context.actorId || !context.route || !TELEMETRY_SERVER_ROUTES.has(context.route)) return;
  const input = { ...context, ...details, durationKind: "handler", actorId: context.actorId, route: context.route };
  // Diagnostics have no authority over the response or original exception.
  void import("@/lib/telemetry/store").then(store => store.recordServerRequestTelemetry(input)).catch(() => undefined);
}
export async function withApiLogging<T extends Request>(request: T, handler: (request: T, context: RequestLogContext) => Promise<Response>, context: Pick<RequestLogContext, "route" | "actorId"> = {}): Promise<Response> {
  const started = performance.now();
  const { observation, owner } = beginApiHandler(request, context);
  const requestContext = observation.context;
  // Correlation only: the actor still comes exclusively from the route's
  // verified session. No URL, body or arbitrary client trace is collected.
  const candidateTrace = requestContext.actionId?.replace(/-/g, "").toLowerCase();
  const trace = validTraceId(candidateTrace) ? { traceId: candidateTrace } : {};
  try {
    const response = await handler(request, requestContext);
    const statusCode = response.status;
    const errorId = statusCode >= 400 ? apiHandlerErrorId(observation) : undefined;
    const durationMs = performance.now() - started;
    if (owner) reportRequest(requestContext, { ...trace, event: "api.request.completed", method: request.method, statusCode, durationMs, errorId });
    endApiHandler(request, observation, owner, durationMs, errorId);
    const fields = {
      schemaVersion: 1,
      event: "api.request.completed",
      source: "server",
      durationKind: "handler",
      ...requestContext,
      ...trace,
      ...(errorId ? { errorId } : {}),
      method: request.method,
      statusCode,
      durationMs,
      outcome: statusCode >= 500 ? "failure" : statusCode === 409 ? "conflict" : statusCode >= 400 ? "rejected" : "success"
    };
    try {
      if (owner && !observation.native) apiLogger[statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info"](fields);
    }
    catch { /* Preserve business result. */
    }
    const headers = new Headers(response.headers);
    headers.set("X-Request-Id", requestContext.requestId);
    if (errorId) headers.set("X-Error-Id", errorId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  catch (err) {
    const errorId = apiHandlerErrorId(observation);
    const durationMs = performance.now() - started;
    if (owner) reportRequest(requestContext, { ...trace, event: "api.request.failed", method: request.method, statusCode: 500, durationMs, errorId, err });
    endApiHandler(request, observation, owner, durationMs, errorId);
    try {
      if (owner && !observation.native) apiLogger.error({
        schemaVersion: 1,
        event: "api.request.failed",
        source: "server",
        durationKind: "handler",
        ...requestContext,
        ...trace,
        errorId,
        method: request.method,
        statusCode: 500,
        outcome: "failure",
        durationMs,
        err
      });
    }
    catch { /* Preserve original exception. */
    }
    throw err;
  }
}
