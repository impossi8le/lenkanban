import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bearer, CanonicalAdapter, tokenKey } from "./adapter";
import type { CallContext, CanonicalPort } from "./adapter";
import { failure, McpError, RpcError, safeError, statuses } from "./errors";
import { inputs, jsonSchema, outputs } from "./schemas";
import type { Arguments, ToolName } from "./schemas";

export const protocolVersions = ["2025-06-18"] as const;
function validProtocolOffer(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
export const serverInfo = { name: "lenkanban-mcp", version: "0.1.0" };
export const templates = [
  ["board", "kanban://board/{projectId}"], ["task", "kanban://task/{taskId}"],
  ["messages", "kanban://task/{taskId}/messages"], ["history", "kanban://task/{taskId}/history"],
].map(([name, uriTemplate]) => ({ name, uriTemplate, mimeType: "application/json" }));
const rpc = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(128), z.number().int()]).optional(),
  method: z.string().max(128), params: z.record(z.string(), z.unknown()).optional() }).strict();
// Protocol metadata is validated but never becomes canonical command arguments.
// Progress notifications are optional; this server deliberately does not emit them.
const requestMetadata = z.object({
  progressToken: z.union([z.string(), z.number().int()]).optional(),
}).passthrough();
type Diagnostic = Readonly<{ requestId: string; actionId: string; errorCode: string; statusCode: number; route: string; method: string }>;
export interface ServerOptions {
  port: CanonicalPort;
  allowedOrigins?: readonly string[];
  diagnose?: (event: Diagnostic) => void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
async function diagnostics(event: Diagnostic): Promise<void> {
  try { (await import("@/lib/logger")).apiLogger.warn({ ...event, event: "api.request.failed" }); } catch { /* no raw fallback */ }
  if (event.statusCode >= 500) {
    try { (await import("@/lib/sentry")).captureException(new Error("MCP operation failed"), { ...event }); } catch { /* no raw fallback */ }
  }
}
function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { throw new McpError("INVALID_ARGUMENT"); }
}
async function boundedBody(request: Request): Promise<unknown> {
  if (!request.body) throw new RpcError(-32600);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 66 * 1024) { void reader.cancel().catch(() => undefined); throw new McpError("PAYLOAD_TOO_LARGE"); }
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RpcError(-32700); }
  } finally { reader.releaseLock(); }
}
async function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpError("DEPENDENCY_UNAVAILABLE")), ms);
  })]); } finally { clearTimeout(timer); }
}

export function createMcpServer(options: ServerOptions) {
  const adapter = new CanonicalAdapter(options.port);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const limits = new Map<string, { started: number; calls: number; active: number }>();
  const cursorSecret = randomBytes(32);
  const cursorPayload = z.object({ v: z.literal(1), type: z.enum(["messages", "boards"]),
    actorId: z.string().min(1).max(128), binding: z.string().max(200), position: z.string().min(1).max(128) }).strict();
  // `binding` keeps a cursor scoped to its selection: the task for messages, the
  // normalized query for boards. A cursor from another selection is INVALID_CURSOR.
  function encodeCursor(type: "messages" | "boards", position: string, context: CallContext, binding: string) {
    const payload = Buffer.from(JSON.stringify({ v: 1, type, actorId: context.actor.id, binding, position })).toString("base64url");
    return `${payload}.${createHmac("sha256", cursorSecret).update(payload).digest("base64url")}`;
  }
  function decodeCursor(type: "messages" | "boards", cursor: string, context: CallContext, binding: string): string {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw 0;
      const expected = createHmac("sha256", cursorSecret).update(parts[0]).digest();
      const actual = Buffer.from(parts[1], "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw 0;
      const value = cursorPayload.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
      if (value.actorId !== context.actor.id || value.type !== type || value.binding !== binding) throw 0;
      return value.position;
    } catch { throw new McpError("INVALID_CURSOR"); }
  }
  async function tool(name: ToolName, raw: unknown, context: CallContext, pending: Set<Promise<unknown>>) {
    if (byteLength(raw) > 64 * 1024) throw new McpError("PAYLOAD_TOO_LARGE");
    const parsed = inputs[name].safeParse(raw);
    if (!parsed.success) throw new McpError("INVALID_ARGUMENT");
    const args: Arguments[ToolName] = parsed.data;
    if (name === "list_tasks" && (args as Arguments["list_tasks"]).page > 1000) throw new McpError("PAGINATION_LIMIT");
    if (name === "list_task_messages") {
      const input = args as Arguments["list_task_messages"];
      if (input.cursor) input.cursor = decodeCursor("messages", input.cursor, context, input.taskId);
    }
    if (name === "list_boards") {
      const input = args as Arguments["list_boards"];
      if (input.cursor) input.cursor = decodeCursor("boards", input.cursor, context, input.query ?? "");
    }
    const write = ["create_task", "update_task", "add_task_comment", "move_task"].includes(name);
    const deadline = now() + (write ? 15000 : 5000);
    let rawOutput: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        const operation = adapter.run(name, args, context);
        pending.add(operation);
        void operation.then(() => pending.delete(operation), () => pending.delete(operation));
        rawOutput = await timed(operation, Math.max(1, deadline - now())); break;
      }
      catch (error) {
        if (write || !(error instanceof McpError) || error.code !== "DEPENDENCY_UNAVAILABLE" || attempt >= 2 || now() >= deadline) throw error;
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
    const checked = outputs[name].safeParse(rawOutput);
    if (!checked.success) throw new McpError("DEPENDENCY_UNAVAILABLE");
    let data = checked.data;
    if (name === "list_task_messages") {
      const messages = data as z.infer<typeof outputs.list_task_messages>;
      if (messages.nextCursor) messages.nextCursor = encodeCursor("messages", messages.nextCursor, context, (args as Arguments["list_task_messages"]).taskId);
    }
    if (name === "list_boards") {
      const boards = data as z.infer<typeof outputs.list_boards>;
      if (boards.nextCursor) boards.nextCursor = encodeCursor("boards", boards.nextCursor, context, (args as Arguments["list_boards"]).query ?? "");
    }
    data = { ...data };
    const result = { content: [{ type: "text", text: "Операция выполнена" }], structuredContent: { schemaVersion: 1, ...data }, isError: false };
    if (byteLength(result) > 256 * 1024) throw new McpError("PAYLOAD_TOO_LARGE");
    return result;
  }
  return {
    /** Stateless Streamable HTTP JSON responses; GET SSE intentionally unsupported. */
    async handle(request: Request): Promise<Response> {
      const requestId = randomUUID();
      const action = request.headers.get("x-action-id");
      // Share this identifier with HTTP wrappers, which mint their own requestId.
      const actionId = action && z.string().uuid().safeParse(action).success ? action : requestId;
      let id: string | number | null = null;
      let release: (() => void) | undefined;
      const pending = new Set<Promise<unknown>>();
      const response = (body: unknown, status = 200) => Response.json(body, { status,
        headers: { "x-request-id": requestId, "x-action-id": actionId, "cache-control": "no-store" } });
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") return response({ status: "degraded", version: serverInfo.version, protocolVersions });
        if (url.pathname !== "/mcp") return response(failure(new McpError("NOT_FOUND"), requestId), 404);
        const origin = request.headers.get("origin");
        if (origin && !(options.allowedOrigins ?? []).includes(origin)) throw new McpError("FORBIDDEN");
        if (url.search || url.hash || request.headers.has("x-api-key")) throw new McpError("UNAUTHENTICATED");
        const authorization = bearer(request.headers);
        const actor = await timed(adapter.port.authenticate(authorization, { requestId, actionId }), 5000);
        const key = tokenKey(authorization);
        for (const [storedKey, entry] of limits) if (!entry.active && now() - entry.started >= 60000) limits.delete(storedKey);
        const entry = limits.get(key) ?? { started: now(), calls: 0, active: 0 };
        if (now() - entry.started >= 60000) { entry.started = now(); entry.calls = 0; }
        if (entry.calls >= 120 || entry.active >= 4) throw new McpError("RATE_LIMITED", Math.max(1, Math.ceil((60000 - now() + entry.started) / 1000)));
        entry.calls++; entry.active++; limits.set(key, entry);
        release = () => { entry.active--; };
        if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "x-request-id": requestId, "x-action-id": actionId, "cache-control": "no-store" } });
        if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new RpcError(-32600);
        const accept = request.headers.get("accept") ?? "";
        if (!accept.includes("application/json") || !accept.includes("text/event-stream")) throw new RpcError(-32600);
        const message = rpc.safeParse(await timed(boundedBody(request), 5000));
        if (!message.success) throw new RpcError(-32600);
        id = message.data.id ?? null;
        const { method, params = {} } = message.data;
        const revision = request.headers.get("mcp-protocol-version");
        if ((revision && revision !== protocolVersions[0]) || (method !== "initialize" && revision !== protocolVersions[0])) throw new RpcError(-32602);
        const context: CallContext = { actor, authorization, requestId, actionId };
        if (id === null) {
          if (!["notifications/initialized", "notifications/cancelled"].includes(method)) throw new RpcError(-32600);
          return new Response(null, { status: 202, headers: { "x-request-id": requestId, "x-action-id": actionId, "cache-control": "no-store" } });
        }
        let result: unknown;
        if (method === "initialize") {
          // Negotiate a version we actually support when a valid client offer differs.
          if (!validProtocolOffer(params.protocolVersion)) throw new RpcError(-32602);
          result = { protocolVersion: protocolVersions[0], capabilities: { tools: {}, resources: {} }, serverInfo };
        } else if (method === "ping") result = {};
        else if (method === "tools/list") result = { tools: (Object.keys(inputs) as ToolName[]).map(name => ({ name,
          description: `Ленканбан: ${name}`,
          inputSchema: jsonSchema(inputs[name]), outputSchema: { type: "object",
            anyOf: [jsonSchema(outputs[name].extend({ schemaVersion: z.literal(1) }), "output"),
              { type: "object", required: ["schemaVersion", "error"], properties: { schemaVersion: { const: 1 }, error: { type: "object" } } }] },
          annotations: { readOnlyHint: !["create_task", "update_task", "add_task_comment", "move_task"].includes(name), destructiveHint: false, idempotentHint: true } })) };
        else if (method === "resources/templates/list") result = { resourceTemplates: templates };
        else if (method === "resources/list") {
          // Bounded discovery through the same shared readers as the tools: boards
          // come from the paginated `/api/projects` filter, tasks from the shared
          // task reader inside those boards. A truncated list would claim a
          // complete inventory, so overflow is an explicit error.
          result = { resources: await timed(adapter.listResources(context), 5000) };
        }
        else if (method === "tools/call") {
          const call = z.object({ name: z.string(), arguments: z.unknown().optional(), _meta: requestMetadata.optional() }).strict().safeParse(params);
          if (!call.success || !Object.hasOwn(inputs, call.data.name)) throw new RpcError(-32602);
          try { result = await tool(call.data.name as ToolName, call.data.arguments ?? {}, context, pending); }
          catch (error) { const safe = safeError(error); await report(safe); result = failure(safe, requestId); }
        } else if (method === "resources/read") {
          const input = z.object({ uri: z.string().max(512), _meta: requestMetadata.optional() }).strict().safeParse(params);
          if (!input.success) throw new RpcError(-32602);
          const match = /^kanban:\/\/(board|task)\/([A-Za-z0-9_-]{1,128})(?:\/(messages|history))?$/.exec(input.data.uri);
          if (!match || (match[1] === "board" && match[3])) throw new McpError("NOT_FOUND");
          const name: ToolName = match[1] === "board" ? "get_board" : match[3] === "messages" ? "list_task_messages" : match[3] === "history" ? "get_task_history" : "get_task";
          const value = await tool(name, match[1] === "board" ? { projectId: match[2] } : { taskId: match[2] }, context, pending);
          result = { contents: [{ uri: input.data.uri, mimeType: "application/json", text: JSON.stringify(value.structuredContent) }] };
          if (byteLength(result) > 256 * 1024) throw new McpError("PAYLOAD_TOO_LARGE");
        } else throw new RpcError(-32601);
        return response({ jsonrpc: "2.0", id, result });
      } catch (error) {
        if (error instanceof RpcError) return response({ jsonrpc: "2.0", id, error: { code: error.code,
          message: "Запрос протокола отклонён", ...(error.code === -32602 ? { data: { protocolVersions } } : {}) } }, 400);
        const safe = safeError(error);
        await report(safe);
        return response({ jsonrpc: "2.0", id, error: { code: -32603, message: "Запрос отклонён", data: failure(safe, requestId).structuredContent } }, statuses[safe.code]);
      } finally {
        // A timeout does not cancel a canonical transaction. Keep its concurrency slot
        // until it settles; never admit extra writes while its outcome is unknown.
        if (pending.size) void Promise.allSettled([...pending]).then(() => release?.());
        else release?.();
      }
      async function report(error: McpError) {
        try { await (options.diagnose ?? diagnostics)({ requestId, actionId, errorCode: error.code, statusCode: statuses[error.code], route: "/mcp", method: "POST" }); } catch { /* no raw fallback */ }
      }
    },
  };
}
