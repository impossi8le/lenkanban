import { describe, expect, it, vi } from "vitest";
import { TASK_REQUEST_STATES, decodeTaskRequestMarker, evaluateTaskRequestMutation } from "./task-request-policy";

const taskId = "task-one";
const marker = (state = "DRAFT", executorId: string | null = null) => ({
  taskId, contractVersion: 1, state, authorId: "author-one", executorId,
});
const invalid = { valid: false };
const invalidDecision = { allowed: false, code: "INVALID_REQUEST_MARKER" };
const markedDecision = { allowed: false, code: "REQUEST_LIFECYCLE_NOT_ENABLED" };
function expectInvalid(value: unknown, expectedTaskId = taskId) {
  expect(decodeTaskRequestMarker(value, expectedTaskId)).toEqual(invalid);
  expect(evaluateTaskRequestMutation(value, expectedTaskId)).toEqual(invalidDecision);
}

describe("closed request marker dispatch, activation off", () => {
  it("only explicit null dispatches to legacy; missing projection must not become a grant", () => {
    expect(decodeTaskRequestMarker(null, taskId)).toEqual({ valid: true, marker: null });
    expect(evaluateTaskRequestMutation(null, taskId)).toEqual({ allowed: true, mode: "legacy" });
    expectInvalid(undefined);
  });
  it.each(["кириллица", "legacy.task/path", "x".repeat(129), "", "task\n"])("null preserves the previously authorized legacy Task ID %s without imposing marker syntax", expectedTaskId => {
    expect(decodeTaskRequestMarker(null, expectedTaskId)).toEqual({ valid: true, marker: null });
    expect(evaluateTaskRequestMutation(null, expectedTaskId)).toEqual({ allowed: true, mode: "legacy" });
    expectInvalid(marker(), expectedTaskId);
    expectInvalid(undefined, expectedTaskId);
  });

  it("publishes exactly the agreed seven states, independent of legacy workflow values", () => {
    expect([...TASK_REQUEST_STATES]).toEqual(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED", "CANCELLED"]);
    expect(new Set(TASK_REQUEST_STATES).size).toBe(7);
    for (const state of ["TODO", "DOING", "DONE", "COLUMN_CUSTOM", "draft", "submitted", "UNKNOWN"]) expectInvalid(marker(state));
  });

  it.each([
    ["DRAFT", null], ["SUBMITTED", null], ["IN_PROGRESS", "executor-one"],
    ["NEEDS_INFO", "executor-one"], ["COMPLETED", "executor-one"],
    ["CLOSED", "executor-one"],
    ["CANCELLED", null], ["CANCELLED", "executor-one"],
  ] as const)("valid %s with executor %s is decoded but every mutation is denied", (state, executorId) => {
    const input = marker(state, executorId);
    expect(decodeTaskRequestMarker(input, taskId)).toEqual({ valid: true, marker: input });
    expect(evaluateTaskRequestMutation(input, taskId)).toEqual(markedDecision);
  });

  it.each(["DRAFT", "SUBMITTED"])("%s cannot already have an executor", state => {
    expectInvalid(marker(state, "executor-one"));
  });
  it.each(["IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED"])("%s requires one executor rather than an assignee array", state => {
    expectInvalid(marker(state));
    expectInvalid({ ...marker(state), executorId: [] });
    expectInvalid({ ...marker(state), executorId: ["executor-one"] });
  });
  it("allows author/executor identity equality without deriving extra capabilities", () => {
    const input = { ...marker("IN_PROGRESS", "author-one") };
    expect(decodeTaskRequestMarker(input, taskId)).toEqual({ valid: true, marker: input });
    expect(evaluateTaskRequestMutation(input, taskId)).toEqual(markedDecision);
  });

  it.each([false, true, 0, 1, NaN, Infinity, "", "null", [], [marker()], new Date(), new Map()])("rejects nonrecord marker %s without a legacy fallback", value => {
    expectInvalid(value);
  });
  it.each([0, 2, -1, 1.5, NaN, Infinity, "1", null, undefined])("rejects unsupported contractVersion %s", contractVersion => {
    expectInvalid({ ...marker(), contractVersion });
  });
  it.each(["taskId", "contractVersion", "state", "authorId", "executorId"] as const)("requires the explicit own field %s", field => {
    const input: Record<string, unknown> = marker();
    delete input[field];
    expectInvalid(input);
  });
  it("rejects a valid marker belonging to a different task", () => {
    expectInvalid(marker(), "other-task");
    expectInvalid({ ...marker(), taskId: "other-task" });
  });
  it.each(["", " ", "a/b", "a\\b", "a?b", "a.b", "a:b", "юзер", "a\nb", "a\0b", "a\n", "a\r", "a\r\n", "a\u2028", "a\u2029", "x".repeat(129)])("rejects invalid resource/user ID %s in every identifier slot", id => {
    expectInvalid({ ...marker(), taskId: id }, id);
    expectInvalid({ ...marker(), authorId: id });
    expectInvalid(marker("IN_PROGRESS", id));
  });
  it("accepts the exact ID bounds and closed ASCII alphabet", () => {
    for (const id of ["a", "A_0-z", "a".repeat(128)]) {
      const input = { ...marker("IN_PROGRESS", id), taskId: id, authorId: id };
      expect(decodeTaskRequestMarker(input, id)).toEqual({ valid: true, marker: input });
      expect(evaluateTaskRequestMutation(input, id)).toEqual(markedDecision);
    }
  });
  it.each([undefined, false, 1, {}, ["executor-one"]])("does not normalize a malformed nullable executor %s to absence", executorId => {
    expectInvalid({ ...marker("CANCELLED"), executorId });
  });
  it.each([
    { globalRole: "ADMIN" }, { role: "PROJECT_ADMIN" }, { ownerId: "author-one" },
    { departmentId: "department-one" }, { responsibleGroupId: "group-one" },
    { assignees: [{ userId: "author-one" }] }, { createdById: "author-one" },
    { permissions: ["request.read", "request.internal.read"] }, { lifecycleEnabled: true },
  ])("additional metadata cannot grant or change marker dispatch: %j", metadata => {
    expectInvalid({ ...marker(), ...metadata });
    expect(evaluateTaskRequestMutation(marker(), taskId)).toEqual(markedDecision);
  });
  it("counts symbols and nonenumerable extras as unsupported fields", () => {
    expectInvalid({ ...marker(), [Symbol("hidden-grant")]: true });
    const input = marker();
    Object.defineProperty(input, "hiddenGrant", { value: "PRIVATE_VALUE", enumerable: false });
    expectInvalid(input);
  });
  it("requires own values instead of inheriting a marker projection", () => {
    expectInvalid(Object.create(marker()));
    expectInvalid(Object.assign(Object.create({ authorId: "author-one" }), { taskId, contractVersion: 1, state: "DRAFT", executorId: null }));
  });
  it("rejects accessors without invoking a hostile getter or leaking its exception", () => {
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER_CONTENT"); });
    const input = marker();
    Object.defineProperty(input, "authorId", { get: getter, enumerable: true, configurable: true });
    expectInvalid(input);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["ownKeys", "getOwnPropertyDescriptor"] as const)("fails closed on a throwing proxy %s trap", trap => {
    const sentinel = new Error("PRIVATE_PROXY_CONTENT");
    const input = new Proxy(marker(), trap === "ownKeys"
      ? { ownKeys() { throw sentinel; } }
      : { getOwnPropertyDescriptor() { throw sentinel; } });
    expect(() => expectInvalid(input)).not.toThrow();
  });
  it("fails closed when reflective traps return an invalid key layout", () => {
    const input = new Proxy(marker(), { ownKeys: () => ["taskId", "taskId"] });
    expectInvalid(input);
  });
  it("does not mutate a frozen marker and has no permissive marked state", () => {
    const input = Object.freeze(marker("CANCELLED", "executor-one"));
    const original = { ...input };
    for (let i = 0; i < 3; i++) {
      expect(decodeTaskRequestMarker(input, taskId)).toEqual({ valid: true, marker: original });
      expect(evaluateTaskRequestMutation(input, taskId)).toEqual(markedDecision);
    }
    expect(input).toEqual(original);
  });
});
