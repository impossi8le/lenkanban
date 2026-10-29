import { createCanonicalPort } from "./local-port";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, apiSuccess } from "@/lib/api-response";
import { UnauthorizedError } from "@/lib/errors";
import { CanonicalAdapter, bearer, type CallContext, type CanonicalPort } from "./adapter";

import { McpError } from "./errors";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), access: vi.fn(), taskGet: vi.fn(), taskPatch: vi.fn(),
  messages: vi.fn(), commentPost: vi.fn(), taskPost: vi.fn(), movePost: vi.fn(), board: vi.fn(), columns: vi.fn(), projects: vi.fn(), tasks: vi.fn(), history: vi.fn(),
}));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.authenticate }));
vi.mock("@/lib/project-access", () => ({ getProjectAccess: mocks.access }));
vi.mock("@/app/api/tasks/[id]/route", () => ({ GET: mocks.taskGet, PATCH: mocks.taskPatch }));
vi.mock("@/app/api/tasks/[id]/messages/route", () => ({ GET: mocks.messages, POST: mocks.commentPost }));
vi.mock("@/app/api/projects/[id]/route", () => ({ GET: mocks.board }));
vi.mock("@/app/api/projects/[id]/columns/route", () => ({ GET: mocks.columns }));
vi.mock("@/app/api/projects/route", () => ({ GET: mocks.projects }));
vi.mock("@/app/api/tasks/route", () => ({ GET: mocks.tasks, POST: mocks.taskPost }));
vi.mock("@/app/api/tasks/[id]/move/route", () => ({ POST: mocks.movePost }));
vi.mock("@/app/api/activities/route", () => ({ GET: mocks.history }));

const authorization = `Bearer kb2_0123456789ab_${"a".repeat(43)}`;
const actor = { id: "actor", globalRole: "USER" as const };
const context: CallContext = { actor, authorization, requestId: "request", actionId: "action" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue(actor);
  mocks.access.mockResolvedValue({ canRead: true });
});

describe("canonical bridge authentication and policy", () => {
  it("authenticates every call through fresh canonical Bearer authentication without cookies", async () => {
    const port = createCanonicalPort();
    await expect(port.authenticate(authorization)).resolves.toEqual(actor);
    mocks.authenticate.mockRejectedValueOnce(new UnauthorizedError());
    await expect(port.authenticate(authorization)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.authenticate.mock.calls) {
      expect(request.headers.get("authorization")).toBe(authorization);
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("x-api-key")).toBeNull();
    }
  });

  it("rejects cookie-only and malformed authentication at the MCP boundary", () => {
    for (const headers of [new Headers({ cookie: "session=secret" }), new Headers({ authorization: "Bearer wrong" })]) {
      expect(() => bearer(headers)).toThrowError("UNAUTHENTICATED");
    }
    expect(bearer(new Headers({ authorization }))).toBe(authorization);
  });

  it("delegates the actual actor and board to getProjectAccess", async () => {
    await expect(createCanonicalPort().projectAccess(actor, "board")).resolves.toEqual({ canRead: true });
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith(actor, "board");
  });

  it("does not query board contents after canonical policy denies access", async () => {
    mocks.access.mockResolvedValue({ canRead: false });
    await expect(new CanonicalAdapter(createCanonicalPort()).run("get_board", { projectId: "foreign" }, context))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.board).not.toHaveBeenCalled();
    expect(mocks.columns).not.toHaveBeenCalled();
  });

  it("trusts the common task grant without a separate board grant and minimizes assignee fields", async () => {
    mocks.taskGet.mockResolvedValue(apiSuccess({ id: "task", projectId: "actual-board",
      assignees: [{ id: "assignment", user: { id: "person", name: "Name", avatarUrl: null, email: "private@example.test" } }],
      tags: [{ tag: { id: "tag", name: "Tag", color: "#123456" } }],
    }));
    mocks.access.mockResolvedValue({ canRead: false });
    const result = await new CanonicalAdapter(createCanonicalPort()).run("get_task", { taskId: "task" }, context);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(result).toMatchObject({ assignees: [{ id: "assignment", userId: "person", name: "Name", avatarUrl: null }],
      tags: [{ id: "tag", name: "Tag", color: "#123456" }] });
    expect(JSON.stringify(result)).not.toContain("private@example.test");
  });

  it("maps authentication dependency failures without retaining their secret message", async () => {
    mocks.authenticate.mockRejectedValue(new Error("database password synthetic-secret"));
    await expect(createCanonicalPort().authenticate(authorization)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE", message: "DEPENDENCY_UNAVAILABLE",
    });
  });
});

describe("canonical route dispatch", () => {
  it.each([
    ["/api/tasks/task?view=details", "taskGet"],
    ["/api/tasks/task/messages?limit=2", "messages"],
    ["/api/projects", "projects"],
    ["/api/projects/board", "board"],
    ["/api/projects/board/columns", "columns"],
    ["/api/activities?taskId=task", "history"],
  ] as const)("dispatches %s to its existing reader", async (path, name) => {
    mocks[name].mockResolvedValue(apiSuccess({ canonical: name }));
    await expect(createCanonicalPort().request(path, context)).resolves.toEqual({ canonical: name });
    expect(mocks[name]).toHaveBeenCalledTimes(1);
    const request = mocks[name].mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe(path);
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe(authorization);
    expect(request.headers.get("cookie")).toBeNull();
  });

  it("passes only the canonical command to PATCH with correlation headers", async () => {
    const command = { operationId: "operation", expectedVersion: 2, changes: { title: "private title" } };
    mocks.taskPatch.mockResolvedValue(apiSuccess({ version: 3 }));
    await expect(createCanonicalPort().request("/api/tasks/task", context, command)).resolves.toEqual({ version: 3 });
    const [request, params] = mocks.taskPatch.mock.calls[0];
    expect(request.method).toBe("PATCH");
    expect(await request.json()).toEqual(command);
    expect(request.headers.get("x-request-id")).toBe("request");
    expect(request.headers.get("x-action-id")).toBe("action");
    expect(request.headers.get("cookie")).toBeNull();
    expect(await params.params).toEqual({ id: "task" });
    expect(mocks.taskGet).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/tasks", "taskPost"], ["/api/tasks/task/messages", "commentPost"], ["/api/tasks/task/move", "movePost"],
  ] as const)("dispatches mutation %s to the shared POST with Bearer and original command", async (path, name) => {
    const command = { operationId: "operation", expectedVersion: 2 };
    mocks[name].mockResolvedValue(apiSuccess({ canonical: name }));
    await expect(createCanonicalPort().request(path, context, command)).resolves.toEqual({ canonical: name });
    expect(mocks[name]).toHaveBeenCalledTimes(1);
    const [request, params] = mocks[name].mock.calls[0];
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual(command);
    expect(request.headers.get("authorization")).toBe(authorization);
    expect(request.headers.get("x-request-id")).toBe(context.requestId);
    expect(request.headers.get("x-action-id")).toBe(context.actionId);
    expect(request.headers.get("cookie")).toBeNull();
    if (path !== "/api/tasks") expect(await params.params).toEqual({ id: "task" });
    expect(mocks.taskPatch).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/admin/users", undefined], ["/api/tasks/task/move", undefined],
    ["/api/projects/board", {}],
  ])("rejects unexported path/method %s", async (path, body) => {
    await expect(createCanonicalPort().request(path as string, context, body)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(mocks.taskPatch).not.toHaveBeenCalled();
    expect(mocks.messages).not.toHaveBeenCalled();
    expect(mocks.board).not.toHaveBeenCalled();
  });
});

describe("actual API envelopes and safe error mapping", () => {
  it("N25 preserves a non-JSON dependency failure as 503 without exposing its body", async () => {
    mocks.taskGet.mockResolvedValue(new Response("SQL synthetic-secret", { status: 503 }));
    await expect(createCanonicalPort().request("/api/tasks/task?view=details", context))
      .rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", message: "DEPENDENCY_UNAVAILABLE" });
  });

  it("N25 rejects malformed canonical reader data as a dependency failure", async () => {
    mocks.taskGet.mockResolvedValue(apiSuccess(null));
    await expect(new CanonicalAdapter(createCanonicalPort()).run("get_task", { taskId: "task" }, context))
      .rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("N4 hides history access revoked after the canonical task preflight", async () => {
    mocks.taskGet.mockResolvedValue(apiSuccess({ id: "task", projectId: "board" }));
    mocks.history.mockResolvedValue(apiError("FORBIDDEN", "private history", undefined, 403));
    await expect(new CanonicalAdapter(createCanonicalPort()).run("get_task_history", { taskId: "task" }, context))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("N15 preserves the canonical Retry-After rather than inventing a new delay", async () => {
    const response = apiError("RATE_LIMITED", "safe", undefined, 429);
    response.headers.set("retry-after", "7");
    mocks.taskPatch.mockResolvedValue(response);
    await expect(createCanonicalPort().request("/api/tasks/task", context, {}))
      .rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 7 });
  });

  it.each([
    ["STALE_TASK_VERSION", 409, "STALE_VERSION"],
    ["OPERATION_ID_REUSED", 409, "OPERATION_ID_REUSED"],
    ["REQUEST_LIFECYCLE_NOT_ENABLED", 409, "REQUEST_LIFECYCLE_NOT_ENABLED"],
    ["INVALID_REQUEST_MARKER", 409, "INVALID_REQUEST_MARKER"],
    ["INVALID_RECEIPT", 409, "INTERNAL_ERROR"],
    ["UNAUTHORIZED", 401, "UNAUTHENTICATED"],
    ["NOT_FOUND", 404, "NOT_FOUND"],
    ["FORBIDDEN", 403, "FORBIDDEN"],
    ["RATE_LIMITED", 429, "RATE_LIMITED"],
    ["UNKNOWN_DATABASE_ERROR", 500, "DEPENDENCY_UNAVAILABLE"],
  ] as const)("maps %s from an actual error envelope without a data key", async (code, status, expected) => {
    mocks.taskPatch.mockResolvedValue(apiError(code, "SQL synthetic-secret", { content: "private title" }, status));
    await expect(createCanonicalPort().request("/api/tasks/task", context, {})).rejects.toMatchObject({
      code: expected, message: expected,
    });
  });

  it("rejects a successful upstream envelope missing data", async () => {
    mocks.taskGet.mockResolvedValue(Response.json({ success: true }));
    await expect(createCanonicalPort().request("/api/tasks/task?view=details", context))
      .rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
});

describe("bounded discovery readers", () => {
  const boardRow = (id: string, tasks = 0) => ({ id, name: `Board ${id}`, description: null,
    updatedAt: "2026-10-21T12:00:00.000Z", owner: { email: "private@example.test" }, _count: { tasks } });
  const taskRow = (id: string) => ({ id, title: "Title", status: "TODO", priority: "MEDIUM",
    columnId: "column", projectId: "board", deadline: null, version: 1,
    updatedAt: "2026-10-21T12:00:00.000Z", assignees: [] });
  const page = (items: unknown[], nextCursor: string | null, hasMore = nextCursor !== null) =>
    apiSuccess({ items, nextCursor, hasMore });

  it("reads the shared cursor page, projects safe fields and forwards the cursor", async () => {
    mocks.projects.mockResolvedValueOnce(page([boardRow("a", 1), boardRow("b", 2)], "b"));
    mocks.projects.mockResolvedValueOnce(page([boardRow("c", 3)], null));
    const adapter = new CanonicalAdapter(createCanonicalPort());
    const first = await adapter.listBoards({ limit: 2 }, context);
    expect(first.items.map(board => board.id)).toEqual(["a", "b"]);
    expect(first).toMatchObject({ hasMore: true, nextCursor: "b" });
    expect(first.items[0]).toEqual({ id: "a", name: "Board a", description: null,
      updatedAt: "2026-10-21T12:00:00.000Z", taskCount: 1, memberCount: null });
    expect(JSON.stringify(first)).not.toContain("private@example.test");
    const firstUrl = new URL((mocks.projects.mock.calls[0][0] as Request).url);
    expect(firstUrl.searchParams.get("limit")).toBe("2");
    expect(firstUrl.searchParams.get("cursor")).toBeNull();
    const second = await adapter.listBoards({ limit: 2, after: "b" }, context);
    expect(second.items.map(board => board.id)).toEqual(["c"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(second.items).toHaveLength(1);
    expect(new URL((mocks.projects.mock.calls[1][0] as Request).url).searchParams.get("cursor")).toBe("b");
  });

  it.each([
    ["a duplicate or reordered page", page([boardRow("b"), boardRow("a")], null)],
    ["more rows than the requested limit", page([boardRow("a"), boardRow("b"), boardRow("c")], null)],
    ["hasMore without a cursor", page([boardRow("a")], null, true)],
    ["a cursor that is not the last row", page([boardRow("a")], "z")],
  ])("rejects %s from the canonical reader", async (_name, response) => {
    mocks.projects.mockResolvedValue(response);
    await expect(new CanonicalAdapter(createCanonicalPort()).listBoards({ limit: 2 }, context))
      .rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("uses the shared search filter together with the server page", async () => {
    mocks.projects.mockResolvedValue(page([], null));
    const adapter = new CanonicalAdapter(createCanonicalPort());
    await adapter.listBoards({ query: "Bo", limit: 50 }, context);
    const url = new URL((mocks.projects.mock.calls[0][0] as Request).url);
    expect(url.searchParams.get("search")).toBe("Bo");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  it.each([1, 2, 50, 100])("preserves offsets and honest hasMore across pages at limit %i", async limit => {
    const adapter = new CanonicalAdapter(createCanonicalPort());
    const all = Array.from({ length: limit * 2 }, (_, index) => taskRow(`t${index}`));
    mocks.tasks.mockImplementation(async (request: Request) => {
      const query = new URL(request.url).searchParams;
      const requestedLimit = Number(query.get("limit")), page = Number(query.get("page"));
      const offset = (page - 1) * requestedLimit;
      return apiSuccess(all.slice(offset, offset + requestedLimit),
        { page, limit: requestedLimit, hasMore: offset + requestedLimit < all.length });
    });
    const first = await adapter.readTasks({ projectId: "board", page: 1, limit }, context);
    const second = await adapter.readTasks({ projectId: "board", page: 2, limit }, context);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect([...first.items, ...second.items].map(item => item.id)).toEqual(all.map(item => item.id));
    expect(mocks.tasks).toHaveBeenCalledTimes(2);
    expect(mocks.tasks.mock.calls.map(([request]) => new URL((request as Request).url).searchParams.get("limit")))
      .toEqual([String(limit), String(limit)]);
  });

  it("preserves search truncation and the reader's effective page size", async () => {
    mocks.tasks.mockResolvedValue(apiSuccess([taskRow("t")], { page: 1, limit: 10, hasMore: false }));
    const page = await new CanonicalAdapter(createCanonicalPort())
      .readTasks({ projectId: "board", page: 1, limit: 50, search: "Title" }, context);
    expect(page).toEqual({ items: [expect.objectContaining({ id: "t" })], page: 1, limit: 10, hasMore: false });
    mocks.tasks.mockResolvedValue(apiSuccess(Array.from({ length: 10 }, (_, i) => taskRow(`t${i}`)),
      { page: 1, limit: 10, hasMore: true }));
    expect((await new CanonicalAdapter(createCanonicalPort())
      .readTasks({ projectId: "board", page: 9, limit: 50, search: "Title" }, context)).hasMore).toBe(true);
  });

  it("does not pretend the page ceiling is the end of the inventory", async () => {
    mocks.tasks.mockResolvedValue(apiSuccess([taskRow("t")], { page: 1000, limit: 1, hasMore: true }));
    expect((await new CanonicalAdapter(createCanonicalPort())
      .readTasks({ projectId: "board", page: 1000, limit: 1 }, context)).hasMore).toBe(true);
  });

  it.each([undefined, { page: 1, limit: 1 }, { page: 2, limit: 1, hasMore: false },
    { page: 1, limit: 2, hasMore: false }])("rejects absent or inconsistent metadata %j", async meta => {
    mocks.tasks.mockResolvedValue(apiSuccess([taskRow("t")], meta));
    await expect(new CanonicalAdapter(createCanonicalPort())
      .readTasks({ projectId: "board", page: 1, limit: 1 }, context))
      .rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
});

const row = { id: "task", projectId: "board", assignees: [], tags: [], description: "Synthetic public" };
function taskGrantFixture(value: unknown = row) {
  const request = vi.fn<CanonicalPort["request"]>().mockResolvedValue(value);
  const projectAccess = vi.fn<CanonicalPort["projectAccess"]>().mockResolvedValue({ canRead: false });
  const port: CanonicalPort = { authenticate: vi.fn().mockResolvedValue(actor), request, projectAccess };
  return { request, projectAccess, adapter: new CanonicalAdapter(port) };
}

describe("common task-reader grant parity", () => {
  it("reads a canonically authorized watcher task without separate board membership", async () => {
    const f = taskGrantFixture();
    await expect(f.adapter.run("get_task", { taskId: "task" }, context)).resolves.toMatchObject({ id: "task", projectId: "board" });
    expect(f.request).toHaveBeenCalledExactlyOnceWith("/api/tasks/task?view=details", context);
    expect(f.projectAccess).not.toHaveBeenCalled();
  });

  it("uses only the common public message reader and its filtered result for the watcher", async () => {
    const f = taskGrantFixture();
    const publicRows = { items: [{ id: "public", contentText: "Synthetic public" }], nextCursor: null };
    f.request.mockResolvedValueOnce(row).mockResolvedValueOnce(publicRows);
    await expect(f.adapter.run("list_task_messages", { taskId: "task", limit: 10 }, context)).resolves.toEqual(publicRows);
    expect(f.request.mock.calls).toEqual([
      ["/api/tasks/task?view=details", context], ["/api/tasks/task/messages?limit=10", context],
    ]);
    expect(f.projectAccess).not.toHaveBeenCalled();
  });

  it.each(["foreign", "nonexistent", "revoked"])("preserves canonical denial for %s task without querying contents", async () => {
    const f = taskGrantFixture(); f.request.mockRejectedValueOnce(new McpError("NOT_FOUND"));
    await expect(f.adapter.run("list_task_messages", { taskId: "task", limit: 10 }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.projectAccess).not.toHaveBeenCalled();
  });

  it("rereads the canonical task after a grant is revoked instead of caching prior success", async () => {
    const f = taskGrantFixture(); f.request.mockResolvedValueOnce(row).mockRejectedValueOnce(new McpError("NOT_FOUND"));
    await f.adapter.run("get_task", { taskId: "task" }, context);
    await expect(f.adapter.run("get_task", { taskId: "task" }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, "", 12, {}, "x".repeat(129)])("fails closed on malformed project identity %#", async projectId => {
    const f = taskGrantFixture({ ...row, projectId });
    await expect(f.adapter.run("get_task", { taskId: "task" }, context)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.projectAccess).not.toHaveBeenCalled();
  });

  it.each(["get_board", "list_tasks", "create_task"] as const)("retains separate board preflight for %s", async name => {
    const f = taskGrantFixture();
    const args = name === "get_board" ? { projectId: "board" } : name === "list_tasks"
      ? { projectId: "board", page: 1, limit: 10 } : { projectId: "board", title: "Synthetic", operationId: "synthetic-operation" };
    await expect(f.adapter.run(name, args, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.projectAccess).toHaveBeenCalledExactlyOnceWith(actor, "board", context);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not convert successful common task read into permission to update", async () => {
    const f = taskGrantFixture(); f.request.mockResolvedValueOnce(row).mockRejectedValueOnce(new McpError("FORBIDDEN"));
    const command = { taskId: "task", operationId: "synthetic-operation", expectedVersion: 2, changes: { title: "Synthetic" } };
    await expect(f.adapter.run("update_task", command, context)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.request.mock.calls).toEqual([
      ["/api/tasks/task?view=details", context],
      ["/api/tasks/task", context, { operationId: command.operationId, expectedVersion: 2, changes: command.changes }],
    ]);
    expect(f.projectAccess).not.toHaveBeenCalled();
  });
});
