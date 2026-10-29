import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequestLogContext } from "./request-context";
import { apiRouteTemplate } from "./api-observation-routes";
import { API_OBSERVATION_CAPABILITY_HEADER, emitHttpApiObservation, registerNativeApiResolver, type NativeApiObservation } from "./api-observation";

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const installationKey = Symbol.for("lenkanban.api-observation.node.v1");
type Installation = { dispose: () => void; activeCount: () => number };
const globalInstallation = globalThis as typeof globalThis & { [installationKey]?: Installation };
type NativeState = NativeApiObservation & { method: string; started: number; capability: string; detach: () => void };
const safeMethod = (method: unknown) => typeof method === "string" && methods.has(method) ? method : "OTHER";

/** Opt-in installer. Root instrumentation must invoke this before the first request. */
export function installNodeApiObservation(): () => void {
  if (globalInstallation[installationKey]) return globalInstallation[installationKey]!.dispose;
  const secret = randomBytes(32);
  const active = new Map<string, NativeState>();
  const byRequest = new WeakMap<IncomingMessage, NativeState>();
  const signature = (id: string, nonce: string, method: string, route: string) => createHmac("sha256", secret).update(`${id}|${nonce}|${method}|${route}`).digest("hex");
  const unregister = registerNativeApiResolver(request => {
    const token = request.headers.get(API_OBSERVATION_CAPABILITY_HEADER);
    if (!token || token.length !== 134) return;
    const match = /^([0-9a-f-]{36})\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(token);
    if (!match) return;
    const route = apiRouteTemplate(new URL(request.url).pathname);
    if (!route) return;
    const method = safeMethod(request.method);
    const expected = signature(match[1], match[2], method, route);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]))) return;
    const current = active.get(token);
    if (current) return current;
    // A minted capability remains identifiable after map cleanup on abort.
    // It cannot create a second physical terminal event or trust a caller ID.
    return { context: { requestId: match[1], route }, finalized: true, handlerClaimed: false };
  });
  const finish = (request: IncomingMessage, response: ServerResponse, cancelled: boolean) => {
    const record = byRequest.get(request);
    if (!record || record.finalized) return;
    record.finalized = true;
    active.delete(record.capability);
    byRequest.delete(request);
    record.detach();
    const statusCode = response.headersSent && Number.isInteger(response.statusCode) ? response.statusCode : undefined;
    const outcome = cancelled ? "aborted" : statusCode === 408 || statusCode === 504 ? "timeout"
      : statusCode !== undefined && statusCode >= 500 ? "failure" : statusCode === 409 ? "conflict"
        : statusCode !== undefined && statusCode >= 400 ? "rejected" : "success";
    emitHttpApiObservation({ ...record.context, method: record.method, ...(statusCode !== undefined ? { statusCode } : {}),
      durationMs: Math.max(0, performance.now() - record.started), outcome,
      ...(record.handlerDurationMs !== undefined ? { handlerDurationMs: record.handlerDurationMs } : {}),
      ...(record.errorId ? { errorId: record.errorId } : {}),
    });
  };
  const onStart = (message: unknown) => {
    // diagnostics_channel subscriber exceptions can be fatal. Guard everything.
    try {
      const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
      if (!request || !response || byRequest.has(request)) return;
      const route = apiRouteTemplate(request.url);
      if (!route) return;
      const method = safeMethod(request.method);
      const context = createRequestLogContext({ get: key => typeof request.headers[key] === "string" ? request.headers[key] as string : null }, { route });
      const nonce = randomBytes(16).toString("hex");
      const capability = `${context.requestId}.${nonce}.${signature(context.requestId, nonce, method, route)}`;
      // Overwrite even a valid-looking client supplied private header.
      request.headers[API_OBSERVATION_CAPABILITY_HEADER] = capability;
      response.setHeader("X-Request-Id", context.requestId);
      const safeFinish = (cancelled: boolean) => { try { finish(request, response, cancelled); } catch { /* No fallback. */ } };
      const completed = () => safeFinish(false), closed = () => safeFinish(!response.writableFinished), aborted = () => safeFinish(true);
      const record: NativeState = { context, method, started: performance.now(), capability, finalized: false, handlerClaimed: false,
        detach: () => { response.off("finish", completed); response.off("close", closed); request.off("aborted", aborted); },
      };
      active.set(capability, record); byRequest.set(request, record);
      response.once("finish", completed); response.once("close", closed); request.once("aborted", aborted);
    } catch { /* Never affect HTTP, even on hostile inputs or sink failures. */ }
  };
  // The native finish channel also covers response finish races; one finalizer.
  const onFinish = (message: unknown) => { try { const { request, response } = message as { request: IncomingMessage; response: ServerResponse }; finish(request, response, false); } catch { /* No fallback. */ } };
  subscribe("http.server.request.start", onStart);
  subscribe("http.server.response.finish", onFinish);
  const dispose = () => {
    unsubscribe("http.server.request.start", onStart); unsubscribe("http.server.response.finish", onFinish); unregister();
    for (const record of active.values()) record.detach(); active.clear();
    if (globalInstallation[installationKey]?.dispose === dispose) delete globalInstallation[installationKey];
  };
  globalInstallation[installationKey] = { dispose, activeCount: () => active.size };
  return dispose;
}
export function nativeApiObservationActiveCount(): number { return globalInstallation[installationKey]?.activeCount() ?? 0; }
