import { apiLogger } from "@/lib/logger";
import { createRequestLogContext, type RequestLogContext } from "./request-context";

export const API_OBSERVATION_CAPABILITY_HEADER = "x-lenkanban-api-observation";
export type NativeApiObservation = {
  context: RequestLogContext;
  finalized: boolean;
  handlerClaimed: boolean;
  handlerDurationMs?: number;
  errorId?: string;
};
type HandlerObservation = { context: RequestLogContext; native?: NativeApiObservation; errorId?: string };
type NativeResolver = (request: Request) => NativeApiObservation | undefined;
type State = { handlers: WeakMap<Request, HandlerObservation>; resolveNative?: NativeResolver };
const stateKey = Symbol.for("lenkanban.api-observation.context.v1");
const shared = globalThis as typeof globalThis & { [stateKey]?: State };
const state = shared[stateKey] ??= { handlers: new WeakMap() };

/** Node installer supplies a capability verifier, never an ID-header lookup. */
export function registerNativeApiResolver(resolver: NativeResolver): () => void {
  state.resolveNative = resolver;
  return () => { if (state.resolveNative === resolver) state.resolveNative = undefined; };
}

export function beginApiHandler(request: Request, initial: Pick<RequestLogContext, "route" | "actorId">) {
  const existing = state.handlers.get(request);
  if (existing) return { observation: existing, owner: false };
  let native: NativeApiObservation | undefined;
  try { native = state.resolveNative?.(request); } catch { /* No diagnostic exception enters business. */ }
  const context = native?.context ?? createRequestLogContext(request.headers, initial);
  if (native && initial.actorId) {
    const safe = createRequestLogContext({ get: () => null }, { actorId: initial.actorId });
    if (safe.actorId) context.actorId = safe.actorId;
  }
  const observation: HandlerObservation = { context, ...(native ? { native } : {}) };
  const owner = !native?.handlerClaimed;
  if (native) native.handlerClaimed = true;
  state.handlers.set(request, observation);
  return { observation, owner };
}

export function apiHandlerErrorId(observation: HandlerObservation): string {
  return observation.errorId ??= observation.native?.errorId ?? crypto.randomUUID();
}

export function endApiHandler(request: Request, observation: HandlerObservation, owner: boolean, durationMs: number, errorId?: string): void {
  if (!owner) return;
  state.handlers.delete(request);
  if (observation.native) {
    observation.native.handlerDurationMs = durationMs;
    if (errorId) observation.native.errorId = errorId;
  }
}

/** Existing Pino is the sole sink. Never spread a request, response or error. */
export function emitHttpApiObservation(input: RequestLogContext & {
  method: string; statusCode?: number; durationMs: number; handlerDurationMs?: number;
  outcome: "success" | "rejected" | "conflict" | "failure" | "aborted" | "timeout";
  errorId?: string;
}): void {
  try {
    const fields = {
      schemaVersion: 1, source: "server", durationKind: "http",
      event: input.outcome === "aborted" ? "api.request.failed" : "api.request.completed",
      requestId: input.requestId, ...(input.actionId ? { actionId: input.actionId } : {}),
      route: input.route, method: input.method,
      ...(input.actorId ? { actorId: input.actorId } : {}), ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
      ...(input.errorId ? { errorId: input.errorId } : {}),
      durationMs: input.durationMs,
      ...(input.handlerDurationMs !== undefined ? { handlerDurationMs: input.handlerDurationMs } : {}), outcome: input.outcome,
    };
    apiLogger[input.outcome === "failure" || input.outcome === "timeout" ? "error" : input.outcome === "success" ? "info" : "warn"](fields);
  } catch { /* Subscriber/fallback must never emit raw data or throw. */ }
}
