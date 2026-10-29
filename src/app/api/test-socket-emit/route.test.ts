import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validCorrelationId } from "@/lib/telemetry-sanitize";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  requireDbUser: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  emitTaskUpdated: vi.fn(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/require-user", () => ({
  requireDbUser: mocks.requireDbUser,
  isGlobalAdmin: (user: { globalRole?: string }) => user.globalRole === "ADMIN",
}));
vi.mock("@/lib/prisma", () => ({ prisma: { task: {
  findUnique: mocks.findUnique, create: mocks.create, update: mocks.update, delete: mocks.delete,
} } }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: mocks.emitTaskUpdated }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));

import { GET } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

const actionId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
const task = { id: "task-1", projectId: "project-1", project: { id: "project-1" }, title: "synthetic task" };
const actor = { id: "admin-1", globalRole: "ADMIN" };
const request = (suffix = "?taskId=task-1") => new Request(`http://localhost/api/test-socket-emit${suffix}`, {
  headers: { "X-Action-Id": actionId, "X-Request-Id": actionId },
});

function assertNoDataAccessOrEffects() {
  expect(mocks.findUnique).not.toHaveBeenCalled();
  assertNoWrites();
  expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
}
function assertNoWrites() {
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.delete).not.toHaveBeenCalled();
}
function assertRequestContext(response: Response, actorId?: string) {
  const requestId = response.headers.get("X-Request-Id");
  expect(validCorrelationId(requestId)).toBe(true);
  expect(requestId).not.toBe(actionId);
  const records = [...mocks.info.mock.calls, ...mocks.warn.mock.calls, ...mocks.error.mock.calls].map(call => call[0]);
  const completed = records.filter(record => record.event === "api.request.completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({ requestId, actionId, route: "/api/test-socket-emit", method: "GET", statusCode: response.status });
  if (actorId) expect(completed[0]).toHaveProperty("actorId", actorId);
  else expect(completed[0]).not.toHaveProperty("actorId");
  expect(JSON.stringify(completed)).not.toContain("taskId=");
  return requestId;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("INTERNAL_EMIT_SECRET", "test-only-diagnostic-bridge");
  mocks.requireApiUser.mockResolvedValue(actor);
  mocks.findUnique.mockResolvedValue(task);
});
afterEach(() => vi.unstubAllEnvs());

describe("diagnostic socket emit API", () => {
  it.each(["production", "test", "staging", ""])("returns 404 in %j before authentication or database access", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(mocks.requireApiUser).not.toHaveBeenCalled();
    expect(mocks.requireDbUser).not.toHaveBeenCalled();
    assertNoDataAccessOrEffects(); assertRequestContext(response);
  });

  it("returns 401 to an anonymous development request without data access", async () => {
    mocks.requireApiUser.mockRejectedValue(new UnauthorizedError());
    const response = await GET(request());
    expect(response.status).toBe(401);
    assertNoDataAccessOrEffects(); assertRequestContext(response);
  });

  it.each(["USER", "DEPARTMENT_ADMIN"])("denies development role %s before data access", async (globalRole) => {
    mocks.requireApiUser.mockResolvedValue({ id: "user-1", globalRole });
    const response = await GET(request());
    expect(response.status).toBe(403);
    assertNoDataAccessOrEffects(); assertRequestContext(response, "user-1");
  });

  it.each([undefined, "", " ", "secret\n"])("fails closed when bridge secret is %j", async (secret) => {
    vi.stubEnv("INTERNAL_EMIT_SECRET", secret);
    const response = await GET(request());
    expect(response.status).toBe(503);
    assertNoDataAccessOrEffects(); assertRequestContext(response, actor.id);
  });

  it.each(["", "?taskId="])("rejects missing task ID %j before database access", async (suffix) => {
    const response = await GET(request(suffix));
    expect(response.status).toBe(400);
    assertNoDataAccessOrEffects(); assertRequestContext(response, actor.id);
  });

  it("returns 404 for an unknown task without emitting or writing", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(mocks.findUnique).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { id: "task-1" } }));
    expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
    assertNoWrites(); assertRequestContext(response, actor.id);
  });

  it("returns a safe correlated 500 when database lookup fails", async () => {
    mocks.findUnique.mockRejectedValue(Error("private-database-details"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-database-details");
    expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
    assertNoWrites(); const requestId = assertRequestContext(response, actor.id);
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ event: "diagnostic.emit.failed", requestId, actionId, actorId: actor.id }));
  });

  it("returns a safe correlated 500 on an unexpected authentication failure", async () => {
    mocks.requireApiUser.mockRejectedValue(Error("private-auth-details"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-auth-details");
    assertNoDataAccessOrEffects();
    const requestId = assertRequestContext(response);
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ event: "diagnostic.auth.failed", requestId, actionId }));
  });

  it("allows a development global admin to request an emit without claiming delivery", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.requireApiUser).toHaveBeenCalledOnce();
    expect(mocks.findUnique).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { id: task.id } }));
    expect(mocks.emitTaskUpdated).toHaveBeenCalledExactlyOnceWith(task.project.id, task);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, taskId: task.id, projectId: task.project.id });
    expect(body.message).toMatch(/emit requested/i);
    expect(body.message).toMatch(/best effort/i);
    expect(body.message).not.toMatch(/event emitted|delivered|delivery (?:succeeded|confirmed|guaranteed)/i);
    assertNoWrites(); assertRequestContext(response, actor.id);
  });

  it("isolates concurrent actors and assigns a fresh request ID to each attempt", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({ ...actor, id: "admin-one" }).mockResolvedValueOnce({ ...actor, id: "admin-two" });
    const responses = await Promise.all([GET(request()), GET(request())]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    const ids = responses.map(response => response.headers.get("X-Request-Id"));
    expect(ids[0]).not.toBe(ids[1]);
    const records = mocks.info.mock.calls.map(call => call[0]).filter(record => record.event === "api.request.completed");
    expect(records).toHaveLength(2);
    expect(records.map(record => record.actorId).sort()).toEqual(["admin-one", "admin-two"]);
    expect(records.map(record => record.requestId).sort()).toEqual([...ids].sort());
    expect(records.every(record => record.actionId === actionId)).toBe(true);
    assertNoWrites();
  });
});
