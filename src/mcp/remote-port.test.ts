import { describe, expect, it, vi } from "vitest";
import { createRemotePort, upstreamOrigin } from "./remote-port";
import { runtimeConfig } from "./config";
import { createMcpServer } from "./server";
import type { CallContext } from "./adapter";

const token = `kb2_123456789abc_${"x".repeat(43)}`;
const authorization = `Bearer ${token}`;
const actor = { id: "alice", globalRole: "USER" as const };
const context: CallContext = { actor, authorization, requestId: "3f0d7ee9-ef46-46da-9b20-014163e30660",
  actionId: "3f0d7ee9-ef46-46da-9b20-014163e30661" };
const json = (data: unknown) => Response.json({ data });
const make = () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(json(actor));
  return { transport, port: createRemotePort("https://app.internal.example", transport) };
};

describe("isolated canonical HTTP port", () => {
  it("links authentication, readers, command and exact retry without changing the operation", async () => {
    const operationId = "917ece49-003b-4f57-acb3-3ea285f4d0a9";
    const command = { taskId: "task", operationId, expectedVersion: 1, changes: { title: "private" } };
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/admin/me")) return json(actor);
      if (init?.method === "PATCH") return json({ taskId: "task", projectId: "board", version: 2, changed: true, replayed: true });
      return json({ projectId: "board" });
    });
    const server = createMcpServer({ port: createRemotePort("https://app.internal.example", transport), diagnose: vi.fn() });
    const request = () => new Request("http://localhost/mcp", { method: "POST", headers: { authorization,
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18", "x-action-id": context.actionId! },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_task", arguments: command } }) });
    const first = await server.handle(request());
    const second = await server.handle(request());
    expect((await first.json()).result.structuredContent).toMatchObject({ replayed: true, version: 2 });
    expect((await second.json()).result.structuredContent).toMatchObject({ replayed: true, version: 2 });
    expect(first.headers.get("x-request-id")).not.toBe(second.headers.get("x-request-id"));
    expect(transport).toHaveBeenCalledTimes(6);
    expect(transport.mock.calls.map(([url, init]) => [new URL(String(url)).pathname + new URL(String(url)).search, init?.method])).toEqual([
      ["/api/admin/me", "GET"], ["/api/tasks/task?view=details", "GET"], ["/api/tasks/task", "PATCH"],
      ["/api/admin/me", "GET"], ["/api/tasks/task?view=details", "GET"], ["/api/tasks/task", "PATCH"],
    ]);
    for (const [index, [, init]] of transport.mock.calls.entries()) {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-request-id")).toBe((index < 3 ? first : second).headers.get("x-request-id"));
      expect(headers.get("x-action-id")).toBe(context.actionId);
    }
    const writes = transport.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
      { operationId, expectedVersion: 1, changes: command.changes },
      { operationId, expectedVersion: 1, changes: command.changes },
    ]);
  });

  it.each(["notifications/initialized", "ping", "denied"])("preserves authentication correlation for %s", async method => {
    const { port, transport } = make();
    if (method === "denied") transport.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const diagnose = vi.fn();
    const response = await createMcpServer({ port, diagnose }).handle(new Request("http://localhost/mcp", {
      method: "POST", headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18", "x-action-id": "synthetic-invalid-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", ...(method === "notifications/initialized" ? {} : { id: 1 }), method }),
    }));
    expect(response.status).toBe(method === "denied" ? 401 : method === "ping" ? 200 : 202);
    const headers = new Headers(transport.mock.calls[0][1]?.headers);
    expect(headers.get("x-request-id")).toBe(response.headers.get("x-request-id"));
    expect(headers.get("x-action-id")).toBe(response.headers.get("x-request-id"));
    expect(response.headers.get("x-action-id")).toBe(headers.get("x-action-id"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain("synthetic-invalid-secret");
  });

  it("authenticates each discovery and observes revocation without cached identity", async () => {
    const { port, transport } = make();
    const server = createMcpServer({ port, diagnose: vi.fn() });
    const request = () => new Request("http://localhost/mcp", { method: "POST", headers: { authorization,
      cookie: "synthetic-cookie", "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await server.handle(request())).status).toBe(200);
    transport.mockResolvedValueOnce(Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }));
    expect((await server.handle(request())).status).toBe(401);
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [url, init] of transport.mock.calls) {
      expect(String(url)).toBe("https://app.internal.example/api/admin/me");
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(authorization);
      expect(headers.has("cookie")).toBe(false);
    }
  });

  it("delegates access to the board HTTP reader with the current token and correlation", async () => {
    const { port, transport } = make();
    await expect(port.projectAccess(actor, "board", context)).resolves.toEqual({ canRead: true });
    expect(String(transport.mock.calls[0][0])).toBe("https://app.internal.example/api/projects/board");
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("x-action-id")).toBe(context.actionId);
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("x-request-id")).toBe(context.requestId);
    transport.mockResolvedValueOnce(new Response("synthetic-private-upstream-body", { status: 404 }));
    await expect(port.projectAccess(actor, "board", context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(port.projectAccess(actor, "board")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(port.projectAccess({ ...actor, id: "bob" }, "board", context)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("preserves task pagination metadata and sends update exactly once with its original body", async () => {
    const { port, transport } = make();
    transport.mockResolvedValueOnce(Response.json({ data: [], meta: { page: 2, limit: 50, hasMore: false } }));
    await expect(port.request("/api/tasks?projectId=board&page=2&limit=50", context))
      .resolves.toEqual({ items: [], page: 2, limit: 50, hasMore: false });
    const command = { operationId: context.actionId, expectedVersion: 1, changes: { title: "synthetic-private-title" } };
    transport.mockResolvedValueOnce(json({ version: 2, replayed: false }));
    await expect(port.request("/api/tasks/task", context, command)).resolves.toEqual({ version: 2, replayed: false });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][1]).toMatchObject({ method: "PATCH", body: JSON.stringify(command) });
  });

  it.each([
    [401, "UNAUTHENTICATED"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [429, "RATE_LIMITED"], [503, "DEPENDENCY_UNAVAILABLE"],
  ])("maps non-JSON HTTP %s without exposing upstream contents", async (status, code) => {
    const { port, transport } = make();
    transport.mockResolvedValueOnce(new Response("synthetic-private-upstream-body", { status, headers: { "retry-after": "7" } }));
    await expect(port.request("/api/tasks/task?view=details", context))
      .rejects.toMatchObject({ code, message: code, retryAfterSec: status === 429 ? 7 : null });
  });

  it("preserves stale version and hides malformed ACKs, identity and pagination", async () => {
    const { port, transport } = make();
    transport.mockResolvedValueOnce(Response.json({ error: { code: "STALE_TASK_VERSION" } }, { status: 409 }));
    await expect(port.request("/api/tasks/task", context, {})).rejects.toMatchObject({ code: "STALE_VERSION" });
    transport.mockResolvedValueOnce(json({ id: "alice", globalRole: "OWNER" }));
    await expect(port.authenticate(authorization)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    transport.mockResolvedValueOnce(json([]));
    await expect(port.request("/api/tasks?page=1", context)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    transport.mockResolvedValueOnce(Response.json({ unexpected: "synthetic-private-title" }));
    await expect(port.request("/api/tasks/task", context)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("refuses redirects and network errors without returning their details", async () => {
    const { port, transport } = make();
    transport.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.invalid" } }));
    await expect(port.authenticate(authorization)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    transport.mockRejectedValueOnce(new Error(`synthetic-private-title ${authorization}`));
    await expect(port.authenticate(authorization)).rejects.toMatchObject({ message: "DEPENDENCY_UNAVAILABLE" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("bounds upstream response size", async () => {
    const { port, transport } = make();
    transport.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(port.authenticate(authorization)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it.each(["https://foreign.invalid/api/tasks", "//foreign.invalid/api/tasks", "/api/tasks/bulk-update",
    "/api/projects/board/members", "/api/tasks/task/assignees", "/api/tasks/task%2fmove", "/api/tasks/task#secret"])(
    "blocks noncanonical target %s before sending credentials", async path => {
      const { port, transport } = make();
      // Only exact task item URLs accept PATCH, so bulk-update must also be refused below.
      await expect(port.request(path, context, {})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(transport).not.toHaveBeenCalled();
    });

  it.each(["create_task", "add_task_comment", "move_task"])("forwards %s as POST with original command, Bearer and correlation", async name => {
    const { port, transport } = make();
    const args = name === "create_task" ? { projectId: "board", title: "title", operationId: context.actionId }
      : name === "add_task_comment" ? { taskId: "task", contentText: "text", expectedVersion: 1, operationId: context.actionId }
      : { taskId: "task", toColumnId: "column", expectedVersion: 1, operationId: context.actionId };
    const ack = name === "create_task" ? { taskId: "created", projectId: "board", version: 0, replayed: true }
      : name === "add_task_comment" ? { messageId: "message", taskId: "task", createdAt: "2026-10-22T12:00:00Z", replayed: true }
      : { operationId: context.actionId, boardRevision: 2, task: { id: "task", columnId: "column", version: 2, status: "TODO" } };
    transport.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/admin/me")) return json(actor);
      if (init?.method === "POST") return json(ack);
      return json({ projectId: "board" });
    });
    const response = await createMcpServer({ port, diagnose: vi.fn() }).handle(new Request("http://localhost/mcp", { method: "POST", headers: { authorization,
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
      "x-action-id": context.actionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
    expect((await response.json()).result).toMatchObject({ isError: false, structuredContent: ack });
    const writes = transport.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    const [url, init] = writes[0];
    expect(String(url)).toBe(`https://app.internal.example/api/tasks${name === "create_task" ? "" : `/task/${name === "move_task" ? "move" : "messages"}`}`);
    const command = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "taskId"));
    expect(JSON.parse(init!.body as string)).toEqual(name === "move_task" ? { ...command, beforeTaskId: null, afterTaskId: null } : command);
    expect(new Headers(init?.headers).get("authorization")).toBe(authorization);
    expect(new Headers(init?.headers).get("x-action-id")).toBe(context.actionId);
    expect(new Headers(init?.headers).get("x-request-id")).toBe(response.headers.get("x-request-id"));
    expect(init).toMatchObject({ redirect: "manual", credentials: "omit" });
  });
});

describe("standalone configuration", () => {
  it.each(["http://app.invalid", "https://user:secret@app.invalid", "https://app.invalid/api", "https://app.invalid/?token=x"])(
    "rejects unsafe upstream %s", value => expect(() => upstreamOrigin(value)).toThrow("MCP_UPSTREAM_ORIGIN"));
  it("defaults to loopback and refuses DB credentials, invalid ports and origins", () => {
    const env = { MCP_UPSTREAM_ORIGIN: "https://app.internal.example" };
    expect(runtimeConfig(env)).toMatchObject({ port: 18765, host: "127.0.0.1", allowedOrigins: [] });
    expect(() => runtimeConfig({ ...env, DATABASE_URL: "synthetic-db-url" })).toThrow("Database credentials");
    expect(() => runtimeConfig({ ...env, MCP_PORT: "65536" })).toThrow("Invalid MCP port");
    expect(() => runtimeConfig({ ...env, MCP_HOST: "foreign.invalid" })).toThrow("Invalid MCP host");
    expect(() => runtimeConfig({ ...env, MCP_ALLOWED_ORIGINS: "https://client.invalid/path" })).toThrow();
    expect(runtimeConfig({ ...env, MCP_HOST: "0.0.0.0", MCP_ALLOWED_ORIGINS: " https://client.invalid " }))
      .toMatchObject({ host: "0.0.0.0", allowedOrigins: ["https://client.invalid"] });
  });
});
