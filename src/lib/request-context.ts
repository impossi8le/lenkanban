import { sanitizeTelemetryContext, validCorrelationId } from "./telemetry-sanitize";
export interface RequestLogContext {
  requestId: string;
  actionId?: string;
  /** Closed route-owner/registry template, e.g. /api/tasks/:id; never raw URL. */
  route?: string;
  actorId?: string;
  /** Set by the route only after checking current project access. */
  projectId?: string;
}
export function createRequestLogContext(headers: Pick<Headers, "get">, context: Pick<RequestLogContext, "route" | "actorId"> = {}): RequestLogContext {
  const actionId = headers.get("x-action-id");
  const safe = sanitizeTelemetryContext({
    route: context.route,
    actorId: context.actorId
  });
  return {
    requestId: crypto.randomUUID(),
    ...(validCorrelationId(actionId) ? {
      actionId
    } : {}),
    ...(typeof safe.route === "string" ? {
      route: safe.route
    } : {}),
    ...(typeof safe.actorId === "string" ? {
      actorId: safe.actorId
    } : {})
  };
}
