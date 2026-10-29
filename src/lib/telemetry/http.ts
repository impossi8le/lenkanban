import { apiError, apiRateLimit } from "@/lib/api-response";
import { trustedMutationOrigin } from "@/lib/mutation-origin";

export const TELEMETRY_BODY_LIMIT = 16 * 1024;
export const TELEMETRY_BODY_TIMEOUT_MS = 5000;
export const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TELEMETRY_SESSION_MS = 24 * 60 * 60 * 1000;

export class TelemetryHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "TelemetryHttpError";
  }
}

export function telemetryConfiguration(): { hmacSecret: string } | null {
  const secret = process.env.TELEMETRY_HMAC_SECRET;
  if (process.env.TELEMETRY_ENABLED !== "true" || typeof secret !== "string"
    || !/^[\x21-\x7E]{32,}$/.test(secret)) {
    return null;
  }
  return { hmacSecret: secret };
}

/**
 * Boolean-only projection for server-rendered bootstrap. The secret itself must
 * never cross the server/client boundary.
 */
export function isTelemetryConfigured(): boolean {
  return telemetryConfiguration() !== null;
}

export function requireTelemetryConfiguration(): void {
  if (!telemetryConfiguration()) throw new TelemetryHttpError(503, "TELEMETRY_UNAVAILABLE");
}

export function requireTelemetryOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  try {
    if (!origin || new URL(origin).origin !== origin || origin !== trustedMutationOrigin(request)) {
      throw new TelemetryHttpError(403, "TELEMETRY_ORIGIN_REJECTED");
    }
  } catch {
    throw new TelemetryHttpError(403, "TELEMETRY_ORIGIN_REJECTED");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new TelemetryHttpError(403, "TELEMETRY_ORIGIN_REJECTED");
}

export async function readTelemetryJson(request: Request, options: { maxBytes?: number; requireJsonContentType?: boolean } = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? TELEMETRY_BODY_LIMIT;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) {
    throw new TelemetryHttpError(400, "TELEMETRY_INVALID_BODY_LIMIT");
  }
  const requireJsonContentType = options.requireJsonContentType ?? true;
  if (typeof requireJsonContentType !== "boolean") throw new TelemetryHttpError(400, "TELEMETRY_INVALID_BODY_OPTIONS");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (requireJsonContentType && contentType !== "application/json") throw new TelemetryHttpError(415, "TELEMETRY_JSON_REQUIRED");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new TelemetryHttpError(413, "TELEMETRY_BODY_TOO_LARGE");
  }
  if (!request.body) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_JSON");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch { /* Cancellation cannot delay the bounded response. */ }
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TelemetryHttpError(408, "TELEMETRY_BODY_TIMEOUT"));
      cancel();
    }, TELEMETRY_BODY_TIMEOUT_MS);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_JSON");
      if (chunk.value.byteLength === 0) continue;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        cancel();
        throw new TelemetryHttpError(413, "TELEMETRY_BODY_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof TelemetryHttpError) throw error;
    throw new TelemetryHttpError(400, "TELEMETRY_INVALID_JSON");
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch { /* A timed-out read may still own the reader until cancellation. */ }
  }
}

export function telemetryFailure(error: unknown): Response {
  if (error && typeof error === "object") {
    try {
      const status = Object.getOwnPropertyDescriptor(error, "status");
      const retry = Object.getOwnPropertyDescriptor(error, "retryAfterSec");
      if (status && "value" in status && status.value === 429) {
        const seconds: unknown = retry && "value" in retry ? retry.value : undefined;
        return apiRateLimit(typeof seconds === "number" && Number.isFinite(seconds)
          ? Math.max(1, Math.min(60, Math.ceil(seconds))) : 60);
      }
    } catch { /* Unknown error descriptors cannot break the safe response. */ }
  }
  try {
    if (error instanceof TelemetryHttpError) {
      return apiError(error.code, "Telemetry request rejected", undefined, error.status);
    }
  } catch { /* Even hostile exception prototype traps receive a fixed response. */ }
  return apiError("TELEMETRY_UNAVAILABLE", "Telemetry unavailable", undefined, 503);
}

export function telemetryNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
