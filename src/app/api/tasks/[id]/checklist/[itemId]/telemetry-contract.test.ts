import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { validCorrelationId } from "@/lib/telemetry-sanitize";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(), updateChecklistItem: vi.fn(), projectChecklistTelemetry: vi.fn(),
  loadTaskWithRelations: vi.fn(), emitTaskUpdated: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.requireApiUser, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/checklist-toggle", () => ({ updateChecklistItem: mocks.updateChecklistItem }));
vi.mock("@/lib/telemetry/store", () => ({ projectChecklistTelemetry: mocks.projectChecklistTelemetry }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: mocks.loadTaskWithRelations }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: mocks.emitTaskUpdated }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error }, dbLogger: { error: vi.fn() } }));

import { PATCH } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

const operationId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
const actionId = "b6497269-c5f7-455e-b3bc-80af37b98037";
const item = { id: "item", taskId: "task", text: "Private business text", completed: true, position: 1 };
const fullTask = { id: "task", project: { id: "project" } };
const context = () => ({ params: Promise.resolve({ id: "task", itemId: "item" }) });
function request(body: unknown = { completed: true }, operation: string | null = operationId, action = actionId) {
  const headers = new Headers({ "Content-Type": "application/json", "X-Action-Id": action, "X-Request-Id": operationId });
  if (operation !== null) headers.set("X-Operation-Id", operation);
  return new Request("http://localhost/api/tasks/task/checklist/item?private=query", { method: "PATCH", headers, body: JSON.stringify(body) });
}
function assertNoPostCommitEffects() {
  expect(mocks.projectChecklistTelemetry).not.toHaveBeenCalled();
  expect(mocks.loadTaskWithRelations).not.toHaveBeenCalled();
  expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
}
function assertCorrelation(response: Response, actorId?: string) {
  const requestId = response.headers.get("X-Request-Id");
  expect(validCorrelationId(requestId)).toBe(true); expect(requestId).not.toBe(operationId);
  const records = [...mocks.info.mock.calls, ...mocks.warn.mock.calls, ...mocks.error.mock.calls].map(call => call[0]);
  const completed = records.filter(record => record.event === "api.request.completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({ requestId, route: "/api/tasks/:id/checklist/:itemId", method: "PATCH", statusCode: response.status });
  if (actorId) expect(completed[0]).toHaveProperty("actorId", actorId);
  else expect(completed[0]).not.toHaveProperty("actorId");
  if (response.status >= 400) {
    const errorId = response.headers.get("X-Error-Id");
    expect(validCorrelationId(errorId)).toBe(true); expect(completed[0]).toHaveProperty("errorId", errorId);
  } else expect(response.headers.get("X-Error-Id")).toBeNull();
  expect(records.every(record => !Object.hasOwn(record, "completed") && !Object.hasOwn(record, "text"))).toBe(true);
  expect(JSON.stringify(completed)).not.toContain("private=query");
  return { requestId, completed: completed[0] };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireApiUser.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.updateChecklistItem.mockResolvedValue({ item, projectId: "project", changed: true, replayed: false, receiptId: "receipt" });
  mocks.projectChecklistTelemetry.mockResolvedValue(undefined);
  mocks.loadTaskWithRelations.mockResolvedValue(fullTask);
});

describe("instrumented checklist PATCH boundary", () => {
  it.each(["", "invalid", operationId + "suffix"])("rejects invalid operation key %j before authentication or mutation", async (operation) => {
    const response = await PATCH(request({ completed: true }, operation), context());
    expect(response.status).toBe(400); expect(mocks.requireApiUser).not.toHaveBeenCalled();
    expect(mocks.updateChecklistItem).not.toHaveBeenCalled(); assertNoPostCommitEffects(); assertCorrelation(response);
  });
  it("rejects repeated operation headers", async () => {
    const req = request(); req.headers.append("X-Operation-Id", operationId);
    const response = await PATCH(req, context());
    expect(response.status).toBe(400); expect(mocks.updateChecklistItem).not.toHaveBeenCalled(); assertNoPostCommitEffects(); assertCorrelation(response);
  });
  it.each([{}, { completed: "true" }, { completed: true, text: "Private edit" }, { completed: false, position: 4 }, { completed: true, unknown: "field" }])("requires an instrumented completed-only boolean payload %#", async (body) => {
    const response = await PATCH(request(body), context());
    expect(response.status).toBe(422); expect(mocks.updateChecklistItem).not.toHaveBeenCalled(); assertNoPostCommitEffects(); assertCorrelation(response);
  });
  it("handles malformed JSON with safe correlated 400", async () => {
    const req = new Request("http://localhost/api/tasks/task/checklist/item", { method: "PATCH", headers: { "X-Operation-Id": operationId }, body: "{" });
    const response = await PATCH(req, context());
    expect(response.status).toBe(400); expect(mocks.updateChecklistItem).not.toHaveBeenCalled(); assertNoPostCommitEffects(); assertCorrelation(response);
  });
  it("rejects an anonymous request before resolving params or mutating", async () => {
    mocks.requireApiUser.mockRejectedValue(new UnauthorizedError());
    const response = await PATCH(request(), { params: new Promise(() => {}) });
    expect(response.status).toBe(401); expect(mocks.updateChecklistItem).not.toHaveBeenCalled(); assertNoPostCommitEffects(); assertCorrelation(response);
  });
  it.each([
    [new NotFoundError(), 404], [new ConflictError("private-command-fingerprint"), 409], [new BadRequestError(), 400],
  ] as const)("maps service rejection %# to a correlated safe response", async (error, status) => {
    mocks.updateChecklistItem.mockRejectedValue(error);
    const response = await PATCH(request(), context());
    expect(response.status).toBe(status); expect(await response.text()).not.toContain("private-command-fingerprint");
    assertNoPostCommitEffects(); assertCorrelation(response, "actor");
  });
  it.each(["Activity", "receipt"])("does not project or emit when the transaction rejects %s persistence", async (step) => {
    mocks.updateChecklistItem.mockRejectedValue(Error(`private-${step}-storage-details`));
    const response = await PATCH(request(), context());
    expect(response.status).toBe(500); expect(await response.text()).not.toContain(`private-${step}-storage-details`);
    assertNoPostCommitEffects(); assertCorrelation(response, "actor");
  });
  it("propagates scoped identifiers to the committed command and returns the original item DTO", async () => {
    const response = await PATCH(request(), context());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, data: item });
    const { requestId } = assertCorrelation(response, "actor");
    expect(mocks.updateChecklistItem).toHaveBeenCalledWith(expect.objectContaining({ actorId: "actor", taskId: "task", itemId: "item", update: { completed: true }, operationId,
      context: expect.objectContaining({ requestId, actionId, actorId: "actor" }) }));
    expect(mocks.projectChecklistTelemetry).toHaveBeenCalledExactlyOnceWith("receipt");
    expect(mocks.emitTaskUpdated).toHaveBeenCalledExactlyOnceWith("project", fullTask);
  });
  it("repairs projection on replay but returns current item without another realtime emit", async () => {
    mocks.updateChecklistItem.mockResolvedValue({ item: { ...item, completed: false }, projectId: "project", changed: false, replayed: true, receiptId: "existing-receipt" });
    const response = await PATCH(request({ completed: true }), context());
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { completed: false } });
    expect(mocks.projectChecklistTelemetry).toHaveBeenCalledExactlyOnceWith("existing-receipt");
    expect(mocks.loadTaskWithRelations).not.toHaveBeenCalled(); expect(mocks.emitTaskUpdated).not.toHaveBeenCalled(); assertCorrelation(response, "actor");
  });
  it("projects a no-op receipt without emitting a business change", async () => {
    mocks.updateChecklistItem.mockResolvedValue({ item, projectId: "project", changed: false, replayed: false, receiptId: "noop-receipt" });
    const response = await PATCH(request(), context());
    expect(response.status).toBe(200); expect(mocks.projectChecklistTelemetry).toHaveBeenCalledWith("noop-receipt");
    expect(mocks.loadTaskWithRelations).not.toHaveBeenCalled(); expect(mocks.emitTaskUpdated).not.toHaveBeenCalled(); assertCorrelation(response, "actor");
  });
  it.each(["projection-rejects", "projection-throws", "load-task", "emit", "emit-and-logger"])("keeps committed success when %s fails", async (failure) => {
    if (failure === "projection-rejects") mocks.projectChecklistTelemetry.mockRejectedValue(Error("private projection"));
    if (failure === "projection-throws") mocks.projectChecklistTelemetry.mockImplementation(() => { throw Error("private projection"); });
    if (failure === "load-task") mocks.loadTaskWithRelations.mockRejectedValue(Error("private task lookup"));
    if (failure === "emit" || failure === "emit-and-logger") mocks.emitTaskUpdated.mockImplementation(() => { throw Error("private emit"); });
    if (failure === "emit-and-logger") mocks.warn.mockImplementation(() => { throw Error("private sink"); });
    const response = await PATCH(request(), context());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, data: item }); assertCorrelation(response, "actor");
  });
  it("does not wait for telemetry projection completion", async () => {
    mocks.projectChecklistTelemetry.mockReturnValue(new Promise(() => {}));
    const response = await PATCH(request(), context());
    expect(response.status).toBe(200); assertCorrelation(response, "actor");
  });
  it("preserves legacy text/position payloads without an operation key", async () => {
    mocks.updateChecklistItem.mockResolvedValue({ item: { ...item, text: "Edited", position: 9 }, projectId: "project", changed: true, replayed: false });
    const response = await PATCH(request({ text: "Edited", position: 9 }, null), context());
    expect(response.status).toBe(200);
    expect(mocks.updateChecklistItem).toHaveBeenCalledWith(expect.objectContaining({ update: { text: "Edited", position: 9 }, operationId: undefined }));
    expect(mocks.projectChecklistTelemetry).not.toHaveBeenCalled(); expect(mocks.emitTaskUpdated).toHaveBeenCalledOnce(); assertCorrelation(response, "actor");
  });
  it("drops an invalid action ID rather than persisting or logging untrusted input", async () => {
    const response = await PATCH(request({ completed: true }, operationId, "private-untrusted-action"), context());
    expect(response.status).toBe(200);
    expect(mocks.updateChecklistItem.mock.calls[0][0].context).not.toHaveProperty("actionId");
    const { completed } = assertCorrelation(response, "actor"); expect(completed).not.toHaveProperty("actionId");
  });
  it("keeps one action/operation over retries while assigning independent request IDs", async () => {
    const responses = await Promise.all([PATCH(request(), context()), PATCH(request(), context())]);
    expect(responses.every(response => response.status === 200)).toBe(true);
    const ids = responses.map(response => response.headers.get("X-Request-Id")); expect(ids[0]).not.toBe(ids[1]);
    const commands = mocks.updateChecklistItem.mock.calls.map(call => call[0]);
    expect(commands.every(command => command.operationId === operationId && command.context.actionId === actionId)).toBe(true);
    expect(commands.map(command => command.context.requestId).sort()).toEqual([...ids].sort());
  });
});
