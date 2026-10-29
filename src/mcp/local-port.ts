import { z } from "zod";
import { McpError, statuses, type ErrorCode } from "./errors";
import type { CanonicalPort, CallContext } from "./adapter";

const record = (value: unknown) => canonicalValue(z.object({}).passthrough(), value);
function canonicalValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new McpError("DEPENDENCY_UNAVAILABLE");
  return result.data;
}

/** Internal adapter: authentication/readers/command and policy stay owned by Lenkanban. */
export function createCanonicalPort(): CanonicalPort {
  const request = (path: string, context?: CallContext, body?: unknown) => new Request(`http://lenkanban.internal${path}`, {
    method: body === undefined ? "GET" : /^\/api\/tasks\/[^/?]+(?:\?|$)/.test(path) ? "PATCH" : "POST",
    headers: { authorization: context?.authorization ?? "", "content-type": "application/json",
      ...(context ? { "x-request-id": context.requestId } : {}), ...(context?.actionId ? { "x-action-id": context.actionId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    async authenticate(authorization, context) {
      const { requireApiUser } = await import("@/lib/require-api-user");
      try { return await requireApiUser(new Request("http://lenkanban.internal/mcp", { headers: { authorization,
        ...(context ? { "x-request-id": context.requestId } : {}),
        ...(context?.actionId ? { "x-action-id": context.actionId } : {}) } })); }
      catch (error) {
        const { UnauthorizedError } = await import("@/lib/errors");
        if (error instanceof UnauthorizedError) throw new McpError("UNAUTHENTICATED");
        throw new McpError("DEPENDENCY_UNAVAILABLE");
      }
    },
    async projectAccess(actor, projectId) {
      const { getProjectAccess } = await import("@/lib/project-access");
      try { return await getProjectAccess(actor, projectId); }
      catch { throw new McpError("DEPENDENCY_UNAVAILABLE"); }
    },
    async request(path, context, body) {
      const url = new URL(path, "http://lenkanban.internal");
      const req = request(path, context, body);
      const match = /^\/api\/tasks\/([^/]+)(\/(?:messages|move))?$/.exec(url.pathname);
      const board = /^\/api\/projects\/([^/]+)(\/columns)?$/.exec(url.pathname);
      const routeTemplate = match ? (match[2] ? `/api/tasks/:id${match[2]}` : "/api/tasks/:id")
        : board ? (board[2] ? "/api/projects/:id/columns" : "/api/projects/:id")
        : url.pathname === "/api/tasks" ? "/api/tasks"
        : url.pathname === "/api/projects" ? "/api/projects"
        : url.pathname === "/api/activities" ? "/api/activities" : undefined;
      if (!routeTemplate) throw new McpError("INVALID_ARGUMENT");
      const { withApiLogging } = await import("@/middleware/api-logger");
      const response = await withApiLogging(req, async () => {
        let response: Response;
        if (match) {
          const params = { params: Promise.resolve({ id: decodeURIComponent(match[1]) }) };
          if (match[2] === "/messages") {
            const route = await import("@/app/api/tasks/[id]/messages/route");
            response = body === undefined ? await route.GET(req, params) : await route.POST(req, params);
          } else if (match[2] === "/move" && body !== undefined) {
            response = await (await import("@/app/api/tasks/[id]/move/route")).POST(req, params);
          }
          else if (!match[2]) {
            const route = await import("@/app/api/tasks/[id]/route");
            response = body === undefined ? await route.GET(req, params) : await route.PATCH(req, params);
          } else throw new McpError("INVALID_ARGUMENT");
        } else if (board && body === undefined) {
          const params = { params: Promise.resolve({ id: decodeURIComponent(board[1]) }) };
          response = board[2] ? await (await import("@/app/api/projects/[id]/columns/route")).GET(req, params)
            : await (await import("@/app/api/projects/[id]/route")).GET(req, params);
        } else if (url.pathname === "/api/projects" && body === undefined) response = await (await import("@/app/api/projects/route")).GET(req);
        else if (url.pathname === "/api/tasks") {
          const route = await import("@/app/api/tasks/route");
          response = body === undefined ? await route.GET(req) : await route.POST(req);
        }
        else if (url.pathname === "/api/activities" && body === undefined) response = await (await import("@/app/api/activities/route")).GET(req);
        else throw new McpError("INVALID_ARGUMENT");
        return response;
      }, { route: routeTemplate, actorId: context.actor.id });
      // A proxy/service may return HTML or an empty body, including for 503.
      // Preserve the status mapping and never retain parsing errors/raw bodies.
      const json: unknown = await response.json().catch(() => undefined);
      const envelope = z.object({ data: z.unknown().optional(), error: z.object({ code: z.string() }).passthrough().optional() }).passthrough().safeParse(json);
      if (!response.ok) {
        const code = envelope.success ? envelope.data.error?.code : undefined;
        const mapped = code === "STALE_TASK_VERSION" ? "STALE_VERSION" : code === "INVALID_RECEIPT" ? "INTERNAL_ERROR"
          : response.status === 401 ? "UNAUTHENTICATED" : response.status === 404 ? "NOT_FOUND"
          : response.status === 403 ? "FORBIDDEN" : response.status === 429 ? "RATE_LIMITED"
          : code && Object.hasOwn(statuses, code) ? code as ErrorCode
          : response.status >= 500 ? "DEPENDENCY_UNAVAILABLE" : "INVALID_ARGUMENT";
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
        throw new McpError(mapped, mapped === "RATE_LIMITED"
          ? Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 60
          : null);
      }
      if (!envelope.success || !Object.hasOwn(envelope.data, "data")) throw new McpError("DEPENDENCY_UNAVAILABLE");
      if (url.pathname === "/api/tasks" && body === undefined) {
        const meta = canonicalValue(z.object({ page: z.number().int().positive(),
          limit: z.number().int().positive(), hasMore: z.boolean() }), record(json).meta);
        return { items: envelope.data.data, ...meta };
      }
      return envelope.data.data;
    },
  };
}
