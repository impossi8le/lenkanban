import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./server";
import { McpError } from "./errors";
import type { CanonicalPort } from "./adapter";

const token = `kb2_123456789abc_${"a".repeat(43)}`;
const otherToken = `kb2_123456789abd_${"b".repeat(43)}`;
const operationId = "3f0d7ee9-ef46-46da-9b20-014163e30660";
const date = "2026-10-21T12:00:00.000Z";
const task = { id: "task", projectId: "board", columnId: "column", title: "synthetic-title", description: "synthetic-description",
  status: "TODO", priority: "MEDIUM", deadline: null, version: 1, position: 1024, createdAt: date, updatedAt: date,
  attachments: [{ url: "https://files.invalid/private", name: "private-file", size: 1, mime: "text/plain" }],
  assignees: [{ id: "assignment", userId: "alice", user: { id: "alice", name: "Alice", email: "private@example.invalid", avatarUrl: null } }],
  tags: [{ id: "task-tag", tag: { id: "tag", name: "Tag", color: "#112233" } }], checklistItems: [] };
const boardRow = (id: string, name = `Board ${id}`, tasks = 1) => ({ id, name, description: null,
  createdAt: date, updatedAt: date, owner: { email: "private@example.invalid" }, _count: { tasks } });
type BoardRow = ReturnType<typeof boardRow>;
type TaskRow = typeof task;
const byId = (left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
function fixture() {
  let revoked = false;
  let boards: BoardRow[] = [boardRow("board", "Board")];
  let tasks: TaskRow[] = [task];
  const authenticate = vi.fn(async (authorization: string) => {
    if (revoked) throw new McpError("UNAUTHENTICATED");
    return { id: authorization.endsWith("b".repeat(43)) ? "bob" : "alice", globalRole: "USER" as const };
  });
  const projectAccess = vi.fn<CanonicalPort["projectAccess"]>(async () => ({ canRead: true }));
  const request = vi.fn<CanonicalPort["request"]>(async (path, _context, body) => {
    if (body) return { taskId: "task", projectId: "board", version: 2, changed: true, replayed: false };
    if (path.includes("/messages?")) return { items: [{ id: "message", authorId: "alice", contentText: "private-comment", attachments: [], createdAt: date }], nextCursor: null };
    if (path.startsWith("/api/activities")) return [];
    if (path === "/api/projects" || path.startsWith("/api/projects?")) {
      const url = new URL(path, "http://localhost");
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit === null) return boards;
      const limit = Number(rawLimit);
      const search = url.searchParams.get("search")?.toLowerCase();
      const cursor = url.searchParams.get("cursor");
      const visible = boards.filter(board => !search || board.name.toLowerCase().includes(search)).sort(byId);
      const after = cursor ? visible.filter(board => board.id > cursor) : visible;
      const items = after.slice(0, limit);
      return { items, nextCursor: after.length > limit ? items[items.length - 1].id : null,
        hasMore: after.length > limit };
    }
    if (path.startsWith("/api/tasks?")) {
      const url = new URL(path, "http://localhost");
      const projectId = url.searchParams.get("projectId");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const page = Number(url.searchParams.get("page") ?? "1");
      const visible = tasks.filter(item => !projectId || item.projectId === projectId);
      return { items: visible.slice((page - 1) * limit, page * limit), page, limit,
        hasMore: visible.length > page * limit };
    }
    if (path.includes("view=details")) return task;
    if (path.endsWith("/columns")) return [{ id: "column", name: "Todo", color: "#112233", position: 0, workflowKey: "TODO", status: "TODO" }];
    return { id: "board", name: "Board", description: null, createdAt: date, updatedAt: date, owner: { email: "private@example.invalid" }, _count: { tasks: 1, members: 1 } };
  });
  const diagnose = vi.fn();
  const port: CanonicalPort = { authenticate, projectAccess, request };
  const server = createMcpServer({ port, diagnose, sleep: async () => undefined });
  return { server, port, request, authenticate, projectAccess, diagnose, revoke: () => { revoked = true; },
    setBoards: (value: BoardRow[]) => { boards = value; }, setTasks: (value: TaskRow[]) => { tasks = value; } };
}
type Server = ReturnType<typeof createMcpServer>;
function req(method: string, params: unknown = {}, authorization = `Bearer ${token}`, extra: Record<string, string> = {}) {
  return new Request("http://localhost/mcp", { method: "POST", headers: { authorization,
    "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}
async function call(server: Server, name: string, args: unknown = {}, authorization?: string) {
  const response = await server.handle(req("tools/call", { name, arguments: args }, authorization));
  return response.json();
}
function errorCode(value: Awaited<ReturnType<typeof call>>) { return value.result?.structuredContent?.error?.code ?? value.error?.data?.error?.code; }
const update = { taskId: "task", operationId, expectedVersion: 1, changes: { title: "New title" } };

describe("MCP negative contract (mock canonical ports, never PostgreSQL)", () => {
  it("N1 rejects absent/malformed tokens before the canonical authenticator; cookies never authenticate", async () => {
    const f = fixture();
    for (const authorization of ["", "Basic x", "Bearer invalid", `Bearer ${token} extra`]) {
      const response = await f.server.handle(req("tools/list", {}, authorization, { cookie: "session=private" }));
      expect(response.status).toBe(401);
      expect(errorCode(await response.json())).toBe("UNAUTHENTICATED");
    }
    expect(f.authenticate).not.toHaveBeenCalled();
  });
  it("N2 derives actor from the token and rejects impersonation fields", async () => {
    const f = fixture();
    expect(errorCode(await call(f.server, "get_task", { taskId: "task", actorId: "alice" }, `Bearer ${otherToken}`))).toBe("INVALID_ARGUMENT");
    await call(f.server, "get_task", { taskId: "task" }, `Bearer ${otherToken}`);
    expect(f.request.mock.calls[0][1].actor.id).toBe("bob");
  });
  it.each(["get_board", "list_tasks"])("N3 hides denied board in %s", async name => {
    const f = fixture(); f.projectAccess.mockResolvedValue({ canRead: false });
    const result = await call(f.server, name, { projectId: "board" });
    expect(errorCode(result)).toBe("NOT_FOUND"); expect(f.request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("Board");
  });
  it.each(["get_task", "list_task_messages", "get_task_history"])("N4 hides inaccessible task in %s", async name => {
    const f = fixture(); f.request.mockRejectedValue(new McpError("NOT_FOUND"));
    const result = await call(f.server, name, { taskId: "task" });
    expect(errorCode(result)).toBe("NOT_FOUND"); expect(JSON.stringify(result)).not.toContain("synthetic-title");
  });
  it("N5 permits member reading and exposes no managing tools", async () => {
    const f = fixture();
    expect((await call(f.server, "get_board", { projectId: "board" })).result.isError).toBe(false);
    const catalog = await (await f.server.handle(req("tools/list"))).json();
    expect(catalog.result.tools).toHaveLength(10);
    expect(catalog.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("manage_members");
  });
  it("N6 rejects direct set_status with protocol -32602", async () => {
    const f = fixture(); expect((await call(f.server, "set_status", { status: "DONE" })).error.code).toBe(-32602);
    expect(errorCode(await call(f.server, "update_task", { ...update, changes: { status: "DONE" } }))).toBe("INVALID_ARGUMENT");
  });
  it.each(["INVALID_DESTINATION_COLUMN", "INVALID_MOVE_NEIGHBORS"] as const)("N7/N8 delegates move rejection %s to canonical command without retry", async code => {
    const f = fixture();
    f.request.mockImplementation(async (_path, _context, body) => { if (body) throw new McpError(code); return task; });
    expect(errorCode(await call(f.server, "move_task", { taskId: "task", toColumnId: "foreign", beforeTaskId: "foreign-neighbor", operationId, expectedVersion: 1 }))).toBe(code);
    expect(f.request.mock.calls.filter(([, , body]) => body)).toHaveLength(1);
  });
  it("N9 propagates stale-version rejection without retry or rebase", async () => {
    const f = fixture(); f.request.mockImplementation(async (_path, _context, body) => { if (body) throw new McpError("STALE_VERSION"); return task; });
    expect(errorCode(await call(f.server, "update_task", update))).toBe("STALE_VERSION");
    expect(f.request.mock.calls.filter(([, , body]) => body)).toHaveLength(1);
  });
  it("N10 forwards exact retry to common receipt owner and preserves replay ACK", async () => {
    const f = fixture(); let writes = 0;
    f.request.mockImplementation(async (_path, _context, body) => body ? { taskId: "task", projectId: "board", version: 2, changed: true, replayed: writes++ > 0 } : task);
    const first = await call(f.server, "update_task", update), replay = await call(f.server, "update_task", update);
    expect(first.result.structuredContent).toEqual({ schemaVersion: 1, taskId: "task", projectId: "board", version: 2, changed: true, replayed: false });
    expect(replay.result.structuredContent).toEqual({ ...first.result.structuredContent, replayed: true });
    expect(f.request.mock.calls.filter(([, , body]) => body).map(([, , body]) => body)).toEqual([
      { operationId, expectedVersion: 1, changes: { title: "New title" } }, { operationId, expectedVersion: 1, changes: { title: "New title" } }]);
  });
  it("N11 preserves operation conflict from canonical command", async () => {
    const f = fixture(); f.request.mockImplementation(async (_path, _context, body) => { if (body) throw new McpError("OPERATION_ID_REUSED"); return task; });
    expect(errorCode(await call(f.server, "update_task", update))).toBe("OPERATION_ID_REUSED");
  });
  it.each(["N12", "N13"])("%s forwards identical create/comment retries and preserves receipt ACK", async id => {
    const f = fixture(); const name = id === "N12" ? "create_task" : "add_task_comment";
    const input = id === "N12" ? { projectId: "board", title: "Title", operationId }
      : { taskId: "task", contentText: "Comment", operationId, expectedVersion: 1 };
    const ack = id === "N12" ? { taskId: "created", projectId: "board", version: 0 }
      : { messageId: "message", taskId: "task", createdAt: date };
    let writes = 0;
    f.request.mockImplementation(async (_path, _context, body) => body ? { ...ack, replayed: writes++ > 0 } : task);
    const first = await call(f.server, name, input), replay = await call(f.server, name, input);
    expect(first.result.structuredContent).toEqual({ schemaVersion: 1, ...ack, replayed: false });
    expect(replay.result.structuredContent).toEqual({ schemaVersion: 1, ...ack, replayed: true });
    const commands = f.request.mock.calls.filter(([, , body]) => body);
    expect(commands).toHaveLength(2);
    expect(commands[0][0]).toBe(commands[1][0]);
    expect(commands[0][2]).toEqual(commands[1][2]);
    expect(commands[0][1].requestId).not.toBe(commands[1][1].requestId);
    expect(commands[0][0]).toBe(id === "N12" ? "/api/tasks" : "/api/tasks/task/messages");
    expect(commands[0][2]).toEqual(id === "N12" ? input : { operationId, expectedVersion: 1, contentText: "Comment" });
    expect(commands[0][1]).toMatchObject({ authorization: `Bearer ${token}`, actor: { id: "alice" } });
  });
  it("N14 empty comment and attachments rejected before any command", async () => {
    const f = fixture();
    for (const contentText of ["", "   ", undefined]) expect(errorCode(await call(f.server, "add_task_comment", { taskId: "task", operationId, expectedVersion: 1, contentText }))).toBe("INVALID_ARGUMENT");
    expect(errorCode(await call(f.server, "add_task_comment", { taskId: "task", operationId, expectedVersion: 1, contentText: "x", attachments: [] }))).toBe("INVALID_ARGUMENT");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("D11 rejects comment visibility/internal inputs before invoking the shared HTTP path", async () => {
    const f = fixture();
    const comment = { taskId: "task", operationId, expectedVersion: 1, contentText: "Comment" };
    for (const extra of [{ visibility: "PUBLIC" }, { visibility: "INTERNAL" }, { internal: true }, { isInternal: true }]) {
      expect(errorCode(await call(f.server, "add_task_comment", { ...comment, ...extra }))).toBe("INVALID_ARGUMENT");
    }
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["create_task", "add_task_comment", "move_task"] as const)("preserves shared HTTP write permission denial for %s", async name => {
    const f = fixture();
    f.request.mockImplementation(async (_path, _context, body) => { if (body) throw new McpError("FORBIDDEN"); return task; });
    const args = name === "create_task" ? { projectId: "board", title: "Title", operationId }
      : name === "add_task_comment" ? { taskId: "task", contentText: "Comment", operationId, expectedVersion: 1 }
      : { taskId: "task", toColumnId: "column", operationId, expectedVersion: 1 };
    expect(errorCode(await call(f.server, name, args))).toBe("FORBIDDEN");
    expect(f.request.mock.calls.filter(([, , body]) => body)).toHaveLength(1);
  });
  it("N15 enforces token rate window and resets it", async () => {
    const f = fixture(); let clock = 0;
    const server = createMcpServer({ port: f.port, diagnose: f.diagnose, now: () => clock });
    for (let i = 0; i < 120; i++) expect((await server.handle(req("ping"))).status).toBe(200);
    const response = await server.handle(req("ping")); expect(response.status).toBe(429);
    const result = await response.json(); expect(result.error.data.error.retryAfterSec).toBe(60);
    clock = 60000; expect((await server.handle(req("ping"))).status).toBe(200);
  });
  it("N16 rejects oversized inputs and outputs, and malformed output DTO", async () => {
    const f = fixture();
    expect(errorCode(await call(f.server, "update_task", { ...update, changes: { description: "я".repeat(40000) } }))).toBe("PAYLOAD_TOO_LARGE");
    f.request.mockResolvedValue({ ...task, description: "x".repeat(256 * 1024) });
    expect(errorCode(await call(f.server, "get_task", { taskId: "task" }))).toBe("PAYLOAD_TOO_LARGE");
    f.request.mockResolvedValue({ ...task, version: "bad" });
    expect(errorCode(await call(f.server, "get_task", { taskId: "task" }))).toBe("DEPENDENCY_UNAVAILABLE");
  });
  it("N17 reauthenticates discovery/resources after token revocation", async () => {
    const f = fixture(); expect((await f.server.handle(req("tools/list"))).status).toBe(200); f.revoke();
    for (const method of ["initialize", "tools/list", "resources/list", "resources/templates/list", "resources/read", "tools/call"]) {
      const response = await f.server.handle(req(method)); expect(response.status).toBe(401);
    }
    expect(f.authenticate).toHaveBeenCalledTimes(7);
  });
  it("N18 obeys canonical command denial after successful read preflight", async () => {
    const f = fixture(); f.request.mockImplementation(async (_path, _context, body) => { if (body) throw new McpError("NOT_FOUND"); return task; });
    expect(errorCode(await call(f.server, "update_task", update))).toBe("NOT_FOUND");
    expect(f.projectAccess).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([, , body]) => body)).toHaveLength(1);
  });
  it.each(["REQUEST_LIFECYCLE_NOT_ENABLED", "INVALID_REQUEST_MARKER"] as const)("N19 preserves canonical marker denial %s", async code => {
    const f = fixture(); f.authenticate.mockResolvedValue({ id: "admin", globalRole: "ADMIN" } as never);
    f.request.mockImplementation(async (_path, _context, body) => { if (body) throw new McpError(code); return task; });
    expect(errorCode(await call(f.server, "update_task", update))).toBe(code);
  });
  it("N20 returns only canonical visible messages, without advertising new internal grants", async () => {
    const f = fixture(); const value = await call(f.server, "list_task_messages", { taskId: "task" });
    expect(value.result.structuredContent.items.map((message: { id: string }) => message.id)).toEqual(["message"]);
    expect(JSON.stringify(value)).not.toContain("canReadInternal");
    expect(errorCode(await call(f.server, "list_task_messages", { taskId: "task", internal: true }))).toBe("INVALID_ARGUMENT");
  });
  it("N20 keeps the shared internal filter authoritative and never republishes its marker (D11)", async () => {
    const f = fixture();
    f.request.mockImplementation(async path => path.includes("/messages?")
      ? { items: [{ id: "public", authorId: "alice", contentText: "public-text", attachments: [], createdAt: date, isInternal: false }],
        nextCursor: null, canReadInternal: true, visibility: "INTERNAL" }
      : task);
    const value = await call(f.server, "list_task_messages", { taskId: "task" });
    expect(value.result.structuredContent.items).toEqual([{ id: "public", authorId: "alice",
      contentText: "public-text", attachments: [], createdAt: date }]);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("isInternal");
    expect(serialized).not.toContain("canReadInternal");
    expect(serialized).not.toContain("visibility");
  });
  it("N21 files stay metadata and email/service fields are projected out", async () => {
    const f = fixture(); const value = await call(f.server, "get_task", { taskId: "task" });
    expect(value.result.structuredContent.attachments).toEqual([{ ...task.attachments[0], width: null, height: null }]);
    expect(JSON.stringify(value)).not.toContain("private@example.invalid");
    expect(f.request.mock.calls.map(([path]) => path)).toEqual(["/api/tasks/task?view=details"]);
    expect((await call(f.server, "download_file", {})).error.code).toBe(-32602);
  });
  it("N22 never sends arbitrary thrown data to diagnostics or raw fallback", async () => {
    const f = fixture(); const secret = "synthetic-private@example.invalid";
    const log = vi.spyOn(console, "log"), error = vi.spyOn(console, "error");
    const cycle: Record<string, unknown> = { Token: token, body: secret, cause: new Error(secret) }; cycle.self = cycle;
    f.request.mockRejectedValue(cycle); f.diagnose.mockImplementation(() => { throw cycle; });
    const response = await call(f.server, "get_task", { taskId: "task" });
    expect(errorCode(response)).toBe("INTERNAL_ERROR");
    expect(JSON.stringify([response, f.diagnose.mock.calls])).not.toContain(secret);
    expect(JSON.stringify(f.diagnose.mock.calls)).not.toContain(token);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it("N23 rejects invalid cursors, limits, unknown fields, deep pages and empty changes", async () => {
    const f = fixture();
    expect(errorCode(await call(f.server, "list_task_messages", { taskId: "task", cursor: "foreign" }))).toBe("INVALID_CURSOR");
    for (const limit of [0, 101]) expect(errorCode(await call(f.server, "list_tasks", { projectId: "board", limit }))).toBe("INVALID_ARGUMENT");
    expect(errorCode(await call(f.server, "list_tasks", { projectId: "board", page: 1001 }))).toBe("PAGINATION_LIMIT");
    expect(errorCode(await call(f.server, "list_tasks", { projectId: "board", assigneeId: "bob" }))).toBe("INVALID_ARGUMENT");
    expect(errorCode(await call(f.server, "update_task", { ...update, changes: {} }))).toBe("INVALID_ARGUMENT");
  });
  it("N24 list_boards returns only the caller's bounded inventory", async () => {
    const f = fixture();
    f.request.mockImplementation(async (path, context) => path.startsWith("/api/projects?")
      ? { items: [boardRow(context.actor.id === "bob" ? "bob-board" : "alice-board", undefined, 0)],
        nextCursor: null, hasMore: false }
      : task);
    const alice = await call(f.server, "list_boards", {}, `Bearer ${token}`);
    const bob = await call(f.server, "list_boards", {}, `Bearer ${otherToken}`);
    expect(alice.result.structuredContent.items.map((item: { id: string }) => item.id)).toEqual(["alice-board"]);
    expect(bob.result.structuredContent.items.map((item: { id: string }) => item.id)).toEqual(["bob-board"]);
    expect(JSON.stringify([alice, bob])).not.toContain("private@example.invalid");
  });
  it("N25/N26 service unavailable gets at most two read retries; no SQL/stack in response", async () => {
    const f = fixture(); f.request.mockRejectedValue(new McpError("DEPENDENCY_UNAVAILABLE"));
    const value = await call(f.server, "get_task", { taskId: "task" });
    expect(errorCode(value)).toBe("DEPENDENCY_UNAVAILABLE"); expect(f.request).toHaveBeenCalledTimes(3);
    expect(value.result.structuredContent.error).toEqual({ code: "DEPENDENCY_UNAVAILABLE", message: "Запрос отклонён сервером Ленканбана.",
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), retryable: true, retryAfterSec: null });
  });
  it("N27 admin/org endpoints and tools cannot be reached", async () => {
    const f = fixture();
    for (const name of ["admin", "create_board", "assign_task", "/api/admin/users", "bulk_update"]) expect((await call(f.server, name)).error.code).toBe(-32602);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("N28 preserves canonical task denial without querying board grants or task contents", async () => {
    const f = fixture(); f.projectAccess.mockResolvedValue({ canRead: false });
    f.request.mockRejectedValue(new McpError("NOT_FOUND"));
    const result = await call(f.server, "get_task", { taskId: "task" });
    expect(errorCode(result)).toBe("NOT_FOUND");
    expect(f.projectAccess).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledExactlyOnceWith("/api/tasks/task?view=details",
      expect.objectContaining({ authorization: `Bearer ${token}`, actor: { id: "alice", globalRole: "USER" }, requestId: expect.any(String) }));
    expect(JSON.stringify(result)).not.toContain("synthetic-description");
  });
  it("N28 returns a common-reader-authorized task even when its board is not readable", async () => {
    const f = fixture(); f.projectAccess.mockResolvedValue({ canRead: false });
    const result = await call(f.server, "get_task", { taskId: "task" });
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent).toMatchObject({ id: "task", projectId: "board", description: "synthetic-description" });
    expect(f.projectAccess).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledExactlyOnceWith("/api/tasks/task?view=details",
      expect.objectContaining({ authorization: `Bearer ${token}`, actor: { id: "alice", globalRole: "USER" }, requestId: expect.any(String) }));
  });
});

describe("MCP transport/resources/pagination", () => {
  it.each(["kanban://board/board", "kanban://task/task", "kanban://task/task/messages", "kanban://task/task/history"])(
    "N3/N4/N28 rechecks shared access for resource %s and never returns its content", async uri => {
      const f = fixture();
      f.projectAccess.mockResolvedValue({ canRead: false });
      if (uri.startsWith("kanban://task/")) f.request.mockRejectedValue(new McpError("NOT_FOUND"));
      const response = await f.server.handle(req("resources/read", { uri }));
      expect(response.status).toBe(404);
      const value = await response.json();
      expect(errorCode(value)).toBe("NOT_FOUND");
      expect(JSON.stringify(value)).not.toContain("synthetic-title");
      expect(JSON.stringify(value)).not.toContain("private-comment");
      if (uri.startsWith("kanban://board/")) {
        expect(f.projectAccess).toHaveBeenCalledExactlyOnceWith({ id: "alice", globalRole: "USER" }, "board",
          expect.objectContaining({ authorization: `Bearer ${token}`, actor: { id: "alice", globalRole: "USER" }, requestId: expect.any(String) }));
      } else {
        expect(f.projectAccess).not.toHaveBeenCalled();
        expect(f.request).toHaveBeenCalledExactlyOnceWith("/api/tasks/task?view=details",
          expect.objectContaining({ authorization: `Bearer ${token}`, actor: { id: "alice", globalRole: "USER" }, requestId: expect.any(String) }));
      }
      expect(f.request.mock.calls.some(([path]) => path.includes("/messages") || path.includes("/activities"))).toBe(false);
    });

  it("discovers accessible boards and their readable tasks, including an empty inventory", async () => {
    const f = fixture();
    const value = await (await f.server.handle(req("resources/list"))).json();
    expect(value.result.resources).toEqual([
      { uri: "kanban://board/board", name: "Board", mimeType: "application/json" },
      { uri: "kanban://task/task", name: "synthetic-title", mimeType: "application/json" },
    ]);
    expect(JSON.stringify(value)).not.toContain("private@example.invalid");
    f.setBoards([]); f.setTasks([]);
    expect((await (await f.server.handle(req("resources/list"))).json()).result.resources).toEqual([]);
  });

  it("N15 holds four active canonical calls and rejects a fifth until they settle", async () => {
    const f = fixture();
    const resolvers: Array<(value: unknown) => void> = [];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.request.mockImplementation(() => new Promise(resolve => {
      resolvers.push(resolve);
      if (resolvers.length === 4) started();
    }));
    const calls = Array.from({ length: 4 }, () => call(f.server, "get_task", { taskId: "task" }));
    await ready;
    const response = await f.server.handle(req("ping"));
    expect(response.status).toBe(429);
    expect(errorCode(await response.json())).toBe("RATE_LIMITED");
    expect(f.request).toHaveBeenCalledTimes(4);
    for (const resolve of resolvers) resolve(task);
    expect((await Promise.all(calls)).every(value => value.result.isError === false)).toBe(true);
    expect((await f.server.handle(req("ping"))).status).toBe(200);
  });
  it("keeps timed-out mutation slots occupied until canonical work settles; never auto-retries", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const resolvers: Array<(value: unknown) => void> = [];
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      f.request.mockImplementation(async (_path, _context, body) => {
        if (!body) return task;
        return new Promise(resolve => { resolvers.push(resolve); if (resolvers.length === 4) started(); });
      });
      const calls = Array.from({ length: 4 }, () => call(f.server, "update_task", update));
      await ready;
      await vi.advanceTimersByTimeAsync(15001);
      const results = await Promise.all(calls);
      for (const value of results) expect(errorCode(value)).toBe("DEPENDENCY_UNAVAILABLE");
      expect(f.request.mock.calls.filter(([, , body]) => body)).toHaveLength(4);
      expect((await f.server.handle(req("ping"))).status).toBe(429);
      for (const resolve of resolvers) resolve({ taskId: "task", projectId: "board", version: 2, changed: true, replayed: false });
      await vi.advanceTimersByTimeAsync(0);
      expect((await f.server.handle(req("ping"))).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
  it("supports initialize, authenticated templates, all resource paths, health and stateless GET 405", async () => {
    const f = fixture();
    const init = await (await f.server.handle(req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }))).json();
    expect(init.result.protocolVersion).toBe("2025-06-18"); expect(init.result.serverInfo.name).toBe("lenkanban-mcp");
    expect((await (await f.server.handle(req("resources/templates/list"))).json()).result.resourceTemplates).toHaveLength(4);
    for (const uri of ["kanban://board/board", "kanban://task/task", "kanban://task/task/messages", "kanban://task/task/history"]) {
      const result = await (await f.server.handle(req("resources/read", { uri }))).json();
      expect(result.result.contents[0].uri).toBe(uri);
      expect(JSON.parse(result.result.contents[0].text).schemaVersion).toBe(1);
    }
    const health = await (await f.server.handle(new Request("http://localhost/health"))).json();
    expect(health).toEqual({ status: "degraded", version: "0.1.0", protocolVersions: ["2025-06-18"] });
    expect((await f.server.handle(new Request("http://localhost/mcp", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(405);
    expect((await f.server.handle(req("initialize", { protocolVersion: "unknown" }))).status).toBe(400);
    expect((await f.server.handle(req("ping", {}, undefined, { origin: "https://evil.invalid" }))).status).toBe(403);
  });
  it("preserves canonical message sentinel and binds opaque cursor to actor and task", async () => {
    const f = fixture(); f.request.mockImplementation(async path => path.includes("/messages?") ? { items: [], nextCursor: "message" } : task);
    const first = await call(f.server, "list_task_messages", { taskId: "task", limit: 1 });
    const cursor = first.result.structuredContent.nextCursor;
    expect(cursor).not.toBe("message");
    await call(f.server, "list_task_messages", { taskId: "task", cursor });
    expect(f.request.mock.calls.at(-1)?.[0]).toContain("cursor=message");
    expect(errorCode(await call(f.server, "list_task_messages", { taskId: "task", cursor }, `Bearer ${otherToken}`))).toBe("INVALID_CURSOR");
    expect(errorCode(await call(f.server, "list_task_messages", { taskId: "other", cursor }))).toBe("INVALID_CURSOR");
    expect(errorCode(await call(f.server, "list_task_messages", { taskId: "task", cursor: cursor + "x" }))).toBe("INVALID_CURSOR");
  });
  it("computes the exact task sentinel from limit+1 and minimizes board projection", async () => {
    const f = fixture();
    const list = await call(f.server, "list_tasks", { projectId: "board", limit: 1 });
    expect(list.result.structuredContent).toMatchObject({ page: 1, limit: 1, hasMore: false });
    expect(list.result.structuredContent.items[0].assigneeIds).toEqual(["alice"]);
    expect(f.request.mock.calls[0][0]).toContain("limit=1");
    f.setTasks([task, { ...task, id: "task-2" }]);
    const more = await call(f.server, "list_tasks", { projectId: "board", limit: 1 });
    expect(more.result.structuredContent.hasMore).toBe(true);
    expect(more.result.structuredContent.items.map((item: { id: string }) => item.id)).toEqual(["task"]);
    const board = await call(f.server, "get_board", { projectId: "board" });
    expect(board.result.structuredContent.board).not.toHaveProperty("owner");
    expect(board.result.structuredContent.board.taskCount).toBe(1);
  });
});

describe("bounded discovery of boards and resources", () => {
  const ids = (value: { items: { id: string }[] }) => value.items.map(item => item.id);

  it("paginates boards by stable id with a real sentinel and an idempotent cursor", async () => {
    const f = fixture();
    f.setBoards([boardRow("c"), boardRow("a"), boardRow("b")]);
    const first = await call(f.server, "list_boards", { limit: 2 });
    expect(ids(first.result.structuredContent)).toEqual(["a", "b"]);
    expect(first.result.structuredContent.hasMore).toBe(true);
    const cursor = first.result.structuredContent.nextCursor;
    expect(typeof cursor).toBe("string");
    const second = await call(f.server, "list_boards", { limit: 2, cursor });
    const repeat = await call(f.server, "list_boards", { limit: 2, cursor });
    expect(ids(second.result.structuredContent)).toEqual(["c"]);
    expect(second.result.structuredContent).toMatchObject({ hasMore: false, nextCursor: null });
    expect(repeat.result.structuredContent).toEqual(second.result.structuredContent);
    expect(f.request.mock.calls.filter(([path]) => path.startsWith("/api/projects?"))).toHaveLength(3);
    const [firstPath, secondPath] = f.request.mock.calls.map(([path]) => new URL(path, "http://localhost"));
    expect(firstPath.searchParams.get("limit")).toBe("2");
    expect(firstPath.searchParams.get("cursor")).toBeNull();
    expect(secondPath.searchParams.get("cursor")).toBe("b");
  });

  it("never confuses a null sentinel with a real board id", async () => {
    const f = fixture();
    f.setBoards([boardRow("a"), boardRow("null")]);
    const first = await call(f.server, "list_boards", { limit: 1 });
    expect(ids(first.result.structuredContent)).toEqual(["a"]);
    const second = await call(f.server, "list_boards", { limit: 1, cursor: first.result.structuredContent.nextCursor });
    expect(ids(second.result.structuredContent)).toEqual(["null"]);
    expect(second.result.structuredContent).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("returns an empty page with a null sentinel", async () => {
    const f = fixture();
    f.setBoards([]);
    expect((await call(f.server, "list_boards", {})).result.structuredContent)
      .toEqual({ schemaVersion: 1, items: [], nextCursor: null, hasMore: false });
    expect((await call(f.server, "list_boards", { limit: 1, cursor: undefined })).result.isError).toBe(false);
  });

  it("rejects a board cursor from another query, actor or signature", async () => {
    const f = fixture();
    f.setBoards([boardRow("a"), boardRow("b")]);
    const cursor = (await call(f.server, "list_boards", { limit: 1, query: "Bo" })).result.structuredContent.nextCursor;
    expect(errorCode(await call(f.server, "list_boards", { limit: 1, query: "Other", cursor }))).toBe("INVALID_CURSOR");
    expect(errorCode(await call(f.server, "list_boards", { limit: 1, query: "Bo", cursor }, `Bearer ${otherToken}`))).toBe("INVALID_CURSOR");
    expect(errorCode(await call(f.server, "list_boards", { limit: 1, cursor: "forged" }))).toBe("INVALID_CURSOR");
    expect((await call(f.server, "list_boards", { limit: 1, query: "Bo", cursor })).result.isError).toBe(false);
  });

  it("paginates boards without an inventory cap but fails explicitly when resources overflow", async () => {
    const f = fixture();
    f.setBoards(Array.from({ length: 501 }, (_, index) => boardRow(`board-${index}`, undefined, 0)));
    const paged = await call(f.server, "list_boards", { limit: 100 });
    expect(paged.result.isError).toBe(false);
    expect(paged.result.structuredContent.items).toHaveLength(100);
    expect(paged.result.structuredContent.hasMore).toBe(true);
    const response = await f.server.handle(req("resources/list"));
    expect(response.status).toBe(400);
    expect(errorCode(await response.json())).toBe("PAGINATION_LIMIT");
    f.setBoards(Array.from({ length: 101 }, (_, index) => boardRow(`board-${index}`, undefined, 0)));
    expect((await call(f.server, "list_boards", { limit: 100 })).result.isError).toBe(false);
    expect((await f.server.handle(req("resources/list"))).status).toBe(200);
  });

  it("does not reveal boards absent from the shared filtered inventory", async () => {
    const f = fixture();
    f.setBoards([boardRow("visible")]);
    f.projectAccess.mockImplementation(async (_actor, projectId) => ({ canRead: projectId === "visible" }));
    const value = await call(f.server, "list_boards", {});
    expect(ids(value.result.structuredContent)).toEqual(["visible"]);
    expect(JSON.stringify(value)).not.toContain("foreign");
    expect(errorCode(await call(f.server, "get_board", { projectId: "foreign" }))).toBe("NOT_FOUND");
  });

  it("discovers task resources only inside the accessible board inventory", async () => {
    const f = fixture();
    f.setBoards([boardRow("visible", "Visible", 1)]);
    f.setTasks([{ ...task, id: "visible-task", projectId: "visible" },
      { ...task, id: "foreign-task", projectId: "foreign" }]);
    const value = await (await f.server.handle(req("resources/list"))).json();
    expect(value.result.resources.map((resource: { uri: string }) => resource.uri))
      .toEqual(["kanban://board/visible", "kanban://task/visible-task"]);
    expect(JSON.stringify(value)).not.toContain("foreign-task");
  });

  it("refuses resource discovery when the task reader cannot prove completeness", async () => {
    const f = fixture();
    f.setBoards([boardRow("visible", "Visible", 2)]);
    f.setTasks([{ ...task, projectId: "visible" }]);
    expect(errorCode(await (await f.server.handle(req("resources/list"))).json())).toBe("PAGINATION_LIMIT");
  });

  it("advertises enabled Phase B mutations with mandatory version and operation inputs", async () => {
    const f = fixture();
    const catalog = await (await f.server.handle(req("tools/list"))).json();
    for (const name of ["create_task", "add_task_comment", "move_task"]) {
      const tool = catalog.result.tools.find((entry: { name: string }) => entry.name === name);
      expect(tool.description).toBe(`Ленканбан: ${name}`);
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
      expect(tool.inputSchema.required).toContain("operationId");
      if (name !== "create_task") expect(tool.inputSchema.required).toContain("expectedVersion");
    }
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("MCP version negotiation (actual handler, mocked canonical authentication)", () => {
  it("selects its supported revision for the observed newer client offer then completes initialization", async () => {
    const f = fixture();
    const request = req("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    request.headers.delete("mcp-protocol-version");
    const initialized = await f.server.handle(request);
    expect(initialized.status).toBe(200);
    expect((await initialized.json()).result).toMatchObject({
      protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} },
    });
    const notification = req("notifications/initialized");
    const acknowledged = await f.server.handle(new Request(notification.url, {
      method: "POST", headers: notification.headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }));
    expect(acknowledged.status).toBe(202);
    expect(await acknowledged.text()).toBe("");
    const tools = await f.server.handle(req("tools/list"));
    expect(tools.status).toBe(200);
    expect((await tools.json()).result.tools).toHaveLength(10);
    const unsupported = await f.server.handle(req("tools/list", {}, undefined, {
      "mcp-protocol-version": "2025-11-25",
    }));
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error.code).toBe(-32602);
    expect(f.authenticate).toHaveBeenCalledTimes(4);
    f.revoke();
    expect((await f.server.handle(req("tools/list"))).status).toBe(401);
    expect(f.authenticate).toHaveBeenCalledTimes(5);
    expect(f.request).not.toHaveBeenCalled();
    expect((await (await f.server.handle(new Request("http://localhost/health"))).json()).protocolVersions)
      .toEqual(["2025-06-18"]);
  });

  it.each(["2024-11-05", "2025-06-18", "2025-11-25", "2028-02-29"])(
    "returns only the supported version for valid bounded date offer %s", async protocolVersion => {
      const f = fixture();
      const response = await f.server.handle(req("initialize", { protocolVersion }));
      expect(response.status).toBe(200);
      expect((await response.json()).result.protocolVersion).toBe("2025-06-18");
    },
  );

  it.each([undefined, null, 20251125, {}, "", "unknown", "2025-13-01", "2025-02-29", "2025-11-31", "2025-11-25\n", "x".repeat(1000)])(
    "rejects malformed or unbounded version offers without canonical operations (%j)", async protocolVersion => {
      const f = fixture();
      const response = await f.server.handle(req("initialize", { protocolVersion }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(-32602);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});

describe("MCP request metadata (ignored protocol envelope, never canonical intent)", () => {
  it.each([{}, { progressToken: "progress" }, { progressToken: 0 }, { progressToken: -1 }, { progressToken: "" }])(
    "accepts standard optional metadata on tools/call and resources/read (%j)", async _meta => {
      const f = fixture();
      const tool = await f.server.handle(req("tools/call", { name: "get_task", arguments: { taskId: "task" }, _meta }));
      expect(tool.status).toBe(200);
      expect((await tool.json()).result).toMatchObject({ isError: false, structuredContent: { id: "task" } });
      const resource = await f.server.handle(req("resources/read", { uri: "kanban://task/task", _meta }));
      expect(resource.status).toBe(200);
      expect((await resource.json()).result.contents).toHaveLength(1);
      expect(f.request.mock.calls.map(([path]) => path)).toEqual([
        "/api/tasks/task?view=details", "/api/tasks/task?view=details",
      ]);
    },
  );

  it("ignores extension metadata without changing actor, command body or replay intent", async () => {
    const f = fixture();
    const secret = "synthetic-private-request-metadata";
    const log = vi.spyOn(console, "log"), error = vi.spyOn(console, "error"), warn = vi.spyOn(console, "warn");
    const metadata = { progressToken: "progress", actorId: "bob", scopes: ["admin"],
      operationId: "other", expectedVersion: 999, nested: { secret } };
    for (const _meta of [metadata, { progressToken: 7 }]) {
      const response = await f.server.handle(req("tools/call", { name: "update_task", arguments: update, _meta }));
      expect(response.status).toBe(200);
      expect((await response.json()).result.isError).toBe(false);
    }
    const commands = f.request.mock.calls.filter(([, , body]) => body);
    expect(commands).toHaveLength(2);
    for (const [, context, body] of commands) {
      expect(context).toMatchObject({ actor: { id: "alice", globalRole: "USER" }, authorization: `Bearer ${token}` });
      expect(body).toEqual({ operationId, expectedVersion: 1, changes: { title: "New title" } });
      expect(JSON.stringify([context, body])).not.toContain(secret);
    }
    expect(commands[0][2]).toEqual(commands[1][2]);
    expect(JSON.stringify(f.diagnose.mock.calls)).not.toContain(secret);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });

  it.each([null, [], 1, "metadata", { progressToken: null }, { progressToken: 1.5 }, { progressToken: [] }, { progressToken: {} }])(
    "rejects invalid metadata or progress token before canonical reads (%j)", async _meta => {
      const f = fixture();
      for (const [method, params] of [
        ["tools/call", { name: "get_task", arguments: { taskId: "task" }, _meta }],
        ["resources/read", { uri: "kanban://task/task", _meta }],
      ] as const) {
        const response = await f.server.handle(req(method, params));
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe(-32602);
      }
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("keeps unknown outer parameters and impersonation arguments strict", async () => {
    const f = fixture();
    const outer = await f.server.handle(req("tools/call", {
      name: "get_task", arguments: { taskId: "task" }, _meta: {}, actorId: "bob",
    }));
    expect(outer.status).toBe(400);
    const argument = await f.server.handle(req("tools/call", {
      name: "get_task", arguments: { taskId: "task", actorId: "bob" }, _meta: {},
    }));
    expect(errorCode(await argument.json())).toBe("INVALID_ARGUMENT");
    const resource = await f.server.handle(req("resources/read", { uri: "kanban://task/task", _meta: {}, actorId: "bob" }));
    expect(resource.status).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("retains the global body limit for metadata and never reflects its contents", async () => {
    const f = fixture();
    const secret = "synthetic-private-progress-token";
    const response = await f.server.handle(req("tools/call", {
      name: "get_task", arguments: { taskId: "task" }, _meta: { progressToken: secret.repeat(3000) },
    }));
    expect(response.status).toBe(413);
    expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(JSON.stringify(f.diagnose.mock.calls)).not.toContain(secret);
    expect(f.request).not.toHaveBeenCalled();
  });
});
