import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bearer, type Actor, type CorrelationContext, type CanonicalPort } from "./adapter";
import { McpError, statuses, type ErrorCode } from "./errors";

const actorSchema = z.object({ id: z.string().min(1).max(128), globalRole: z.enum(["USER", "ADMIN"]) });
const envelopeSchema = z.object({ data: z.unknown().optional(), error: z.object({ code: z.string() }).optional() });
const pageSchema = z.object({ page: z.number().int().positive(), limit: z.number().int().positive(), hasMore: z.boolean() });
const maxResponseBytes = 2 * 1024 * 1024;

/** Fixed operator-owned HTTPS origin; no URL, cookie, role or grant comes from the client. */
export function upstreamOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw 0;
    return url.origin;
  } catch { throw new Error("MCP_UPSTREAM_ORIGIN must be an HTTPS origin without credentials or path"); }
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new McpError("DEPENDENCY_UNAVAILABLE");
      }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
  } finally { reader.releaseLock(); }
}

/** Only canonical HTTP routes. Authentication and access decisions remain in the application. */
export function createRemotePort(origin: string, transport: typeof fetch = fetch): CanonicalPort {
  const base = upstreamOrigin(origin);
  async function call(path: string, authorization: string, context?: CorrelationContext, body?: unknown) {
    // A second allowlist bounds egress even if a future tool accidentally passes an arbitrary URL.
    const url = new URL(path, base);
    const task = /^\/api\/tasks\/[^/]+$/.test(url.pathname)
      && !["/api/tasks/bulk", "/api/tasks/bulk-update"].includes(url.pathname);
    const allowed = url.pathname === "/api/admin/me" || url.pathname === "/api/projects"
      || url.pathname === "/api/tasks" || url.pathname === "/api/activities"
      || /^\/api\/projects\/[^/]+(?:\/columns)?$/.test(url.pathname)
      || task || /^\/api\/tasks\/[^/]+\/(?:messages|move)$/.test(url.pathname);
    if (!path.startsWith("/api/") || url.origin !== base || url.hash || !allowed
      || /%(?:2f|5c|2e)/i.test(url.pathname) || (body !== undefined && !(task || url.pathname === "/api/tasks" || /^\/api\/tasks\/[^/]+\/(?:messages|move)$/.test(url.pathname)))) throw new McpError("INVALID_ARGUMENT");
    const auth = bearer(new Headers({ authorization }));
    try {
      const response = await transport(url, {
        method: body === undefined ? "GET" : task ? "PATCH" : "POST", redirect: "manual", credentials: "omit",
        signal: AbortSignal.timeout(body === undefined ? 5000 : 15000),
        headers: { authorization: auth, accept: "application/json", "content-type": "application/json",
          "x-request-id": context?.requestId ?? randomUUID(),
          ...(context?.actionId ? { "x-action-id": context.actionId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Never follow an upstream redirect with a user's token, including same-origin redirects.
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new McpError("DEPENDENCY_UNAVAILABLE");
      }
      const json = await responseJson(response);
      const envelope = envelopeSchema.safeParse(json);
      if (!response.ok) {
        const code = envelope.success ? envelope.data.error?.code : undefined;
        const mapped: ErrorCode = code === "STALE_TASK_VERSION" ? "STALE_VERSION" : code === "INVALID_RECEIPT" ? "INTERNAL_ERROR"
          : response.status === 401 ? "UNAUTHENTICATED" : response.status === 404 ? "NOT_FOUND"
          : response.status === 403 ? "FORBIDDEN" : response.status === 429 ? "RATE_LIMITED"
          : code && Object.hasOwn(statuses, code) ? code as ErrorCode
          : response.status >= 500 ? "DEPENDENCY_UNAVAILABLE" : "INVALID_ARGUMENT";
        const rawRetry = response.headers.get("retry-after");
        const retry = rawRetry && /^\d+$/.test(rawRetry) ? Number(rawRetry) : NaN;
        throw new McpError(mapped, mapped === "RATE_LIMITED" ? Number.isSafeInteger(retry) && retry > 0 ? retry : 60 : null);
      }
      if (!envelope.success || !Object.hasOwn(envelope.data, "data")) throw new McpError("DEPENDENCY_UNAVAILABLE");
      if (url.pathname === "/api/tasks" && body === undefined) {
        const meta = pageSchema.safeParse((json as { meta?: unknown }).meta);
        if (!meta.success) throw new McpError("DEPENDENCY_UNAVAILABLE");
        return { items: envelope.data.data, ...meta.data };
      }
      return envelope.data.data;
    } catch (error) {
      // Fetch/URL/JSON failures can contain tokens, query text and response contents.
      throw error instanceof McpError ? error : new McpError("DEPENDENCY_UNAVAILABLE");
    }
  }
  return {
    async authenticate(authorization, context) {
      const result = actorSchema.safeParse(await call("/api/admin/me", authorization, context));
      if (!result.success) throw new McpError("DEPENDENCY_UNAVAILABLE");
      return result.data;
    },
    async projectAccess(actor: Actor, projectId, context) {
      if (!context || actor.id !== context.actor.id) throw new McpError("UNAUTHENTICATED");
      // GET already applies canonical server-side project filtering. No local role rules.
      await call(`/api/projects/${encodeURIComponent(projectId)}`, context.authorization, context);
      return { canRead: true };
    },
    request: (path, context, body) => call(path, context.authorization, context, body),
  };
}
