import { validCorrelationId } from "./telemetry-sanitize";
import type { TelemetryRequestResult } from "./telemetry/client";

const BASE_PATH = "";

export interface ApiTelemetryContext {
  actionId: string;
  operationId?: string;
  onResult?: (result: TelemetryRequestResult) => void;
}

function sameOrigin(path: string): boolean {
  try {
    if (typeof window !== "undefined") return new URL(path, window.location.href).origin === window.location.origin;
    return path.startsWith("/") && !path.startsWith("//") && !/[\\\x00-\x20]/.test(path);
  } catch { return false; }
}

function timestamp(): number {
  try { return performance.now(); } catch { return Date.now(); }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
  telemetry?: ApiTelemetryContext,
): Promise<T> {
  const url = path.startsWith("/") ? `${BASE_PATH}${path}` : path;
  const instrumented = telemetry && validCorrelationId(telemetry.actionId) && sameOrigin(url);
  const started = timestamp();
  let init = options;
  if (instrumented) {
    const headers = new Headers(options?.headers);
    headers.set("X-Action-Id", telemetry.actionId);
    if (validCorrelationId(telemetry.operationId)) headers.set("X-Operation-Id", telemetry.operationId);
    init = { ...options, headers, redirect: "error" };
  }
  let statusCode: number | undefined;
  let requestId: string | undefined;
  let errorId: string | undefined;
  let reported = false;
  const report = (outcome: TelemetryRequestResult["outcome"]) => {
    if (!instrumented || reported) return;
    reported = true;
    try {
      telemetry.onResult?.({ outcome, durationMs: Math.max(0, Math.min(86400000, timestamp() - started)),
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(requestId ? { requestId } : {}), ...(errorId ? { errorId } : {}),
      });
    } catch { /* Telemetry cannot replace the request result. */ }
  };
  try {
  const res = await fetch(url, init);
  statusCode = res.status;
  if (instrumented) {
    const receivedRequestId = res.headers.get("X-Request-Id");
    const receivedErrorId = res.headers.get("X-Error-Id");
    if (validCorrelationId(receivedRequestId)) requestId = receivedRequestId.toLowerCase();
    if (validCorrelationId(receivedErrorId)) errorId = receivedErrorId.toLowerCase();
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const errorMessage = payload?.error?.message || payload?.message || "Request failed";
    report(res.status === 409 ? "conflict" : res.status >= 500 ? "failure" : "rejected");
    throw Object.assign(new Error(typeof errorMessage === "string" ? errorMessage : "Request failed"), {
      status: res.status,
      payload,
      ...(requestId ? { requestId } : {}), ...(errorId ? { errorId } : {}),
    });
  }
  const json = await res.json();
  report("success");
  // Handle standardized API response format { success: true, data: T }
  if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
    return json.data as T;
  }
  // Fallback for non-standardized responses
  return json as T;
  } catch (error) {
    let cancelled = false;
    try { cancelled = options?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError"); } catch { /* Unknown thrown value. */ }
    report(cancelled ? "cancelled" : "failure");
    throw error;
  }
}

export function apiPost<T>(path: string, data: unknown, telemetry?: ApiTelemetryContext): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, telemetry);
}

export function apiPatch<T>(path: string, data: unknown, telemetry?: ApiTelemetryContext): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, telemetry);
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, {
    method: "DELETE",
  });
}
