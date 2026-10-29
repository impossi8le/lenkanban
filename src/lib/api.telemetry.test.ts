import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiPatch, apiPost } from "./api";

const ACTION = "a12bc345-6789-4abc-8def-012345678901";
const OTHER_ACTION = "b12bc345-6789-4abc-8def-012345678901";
const REQUEST = "c12bc345-6789-4abc-8def-012345678901";
const OTHER_REQUEST = "d12bc345-6789-4abc-8def-012345678901";
const ERROR_ID = "e12bc345-6789-4abc-8def-012345678901";
const OPERATION = "f12bc345-6789-4abc-8def-012345678901";
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
function ok(data: unknown = { saved: true }, headers?: HeadersInit) {
  return Response.json({ success: true, data }, { headers });
}

describe("API telemetry keeps business behavior and safe correlation", () => {
  it("correlates POST with optional existing action/operation IDs without changing its body", async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await apiPost("/api/tasks/task/lifecycle", { action: "edit_description", description: "private value" }, { actionId: ACTION, operationId: OPERATION });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/tasks/task/lifecycle"); expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ action: "edit_description", description: "private value" }));
    const headers = new Headers(init?.headers); expect(headers.get("X-Action-Id")).toBe(ACTION); expect(headers.get("X-Operation-Id")).toBe(OPERATION);
  });
  it.each([
    { "Content-Type": "application/json", "X-Existing": "one" },
    new Headers({ "Content-Type": "application/json", "X-Existing": "one" }),
    [["Content-Type", "application/json"], ["X-Existing", "one"]] as [string, string][],
  ])("merges each HeadersInit form without mutating caller headers", async headers => {
    const original = new Headers(headers);
    fetchMock.mockResolvedValue(ok());
    const onResult = vi.fn();
    const options: RequestInit = { method: "PATCH", headers, body: "synthetic-body", credentials: "same-origin" };
    await expect(apiFetch("/api/tasks/1", options, { actionId: ACTION, operationId: OPERATION, onResult })).resolves.toEqual({ saved: true });
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get("x-action-id")).toBe(ACTION);
    expect(new Headers(init.headers).get("x-operation-id")).toBe(OPERATION);
    expect(new Headers(init.headers).get("x-existing")).toBe("one");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init).toMatchObject({ method: "PATCH", body: "synthetic-body", credentials: "same-origin", redirect: "error" });
    expect([...new Headers(headers)]).toEqual([...original]);
    expect(options).not.toHaveProperty("redirect");
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it.each(["https://foreign.invalid/api", "//foreign.invalid/api", "/\\foreign.invalid/api", "\\\\foreign.invalid/api", "/api/has space"])("does not attach correlation or callbacks to unsafe/foreign path %s", async path => {
    fetchMock.mockResolvedValue(ok());
    const onResult = vi.fn();
    await apiFetch(path, undefined, { actionId: ACTION, operationId: OPERATION, onResult });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("x-action-id")).toBe(false);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("x-operation-id")).toBe(false);
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
    expect(onResult).not.toHaveBeenCalled();
  });

  it.each(["bad", "", "00000000-0000-0000-0000-000000000000"])("ignores malformed action ID %j", async actionId => {
    fetchMock.mockResolvedValue(ok());
    const onResult = vi.fn();
    await apiFetch("/api/tasks/1", undefined, { actionId, onResult });
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("ignores a malformed operation ID while retaining valid action correlation", async () => {
    fetchMock.mockResolvedValue(ok());
    await apiFetch("/api/tasks/1", undefined, { actionId: ACTION, operationId: "private-invalid" });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("x-action-id")).toBe(ACTION);
    expect(headers.has("x-operation-id")).toBe(false);
  });

  it("preserves standard and legacy DTOs and compatibility of existing calls", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "standard" })).mockResolvedValueOnce(Response.json({ id: "legacy" }));
    await expect(apiFetch("/api/standard")).resolves.toEqual({ id: "standard" });
    await expect(apiPatch("/api/legacy", { completed: true })).resolves.toEqual({ id: "legacy" });
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PATCH", body: '{"completed":true}', headers: { "Content-Type": "application/json" } });
  });

  it.each([[400, "rejected"], [401, "rejected"], [403, "rejected"], [409, "conflict"], [500, "failure"]] as const)("reports returned HTTP %i exactly once and excludes raw payload", async (status, outcome) => {
    const payload = { error: { message: "synthetic-private-message", details: { token: "synthetic-token", cookie: "synthetic-cookie" } } };
    fetchMock.mockResolvedValue(Response.json(payload, { status, headers: { "X-Request-Id": REQUEST.toUpperCase(), "X-Error-Id": ERROR_ID.toUpperCase() } }));
    const onResult = vi.fn();
    await expect(apiPatch("/api/tasks/1", { text: "synthetic-private-body" }, { actionId: ACTION, onResult })).rejects.toMatchObject({ status, payload, requestId: REQUEST, errorId: ERROR_ID });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0]).toEqual({ outcome, durationMs: expect.any(Number), statusCode: status, requestId: REQUEST, errorId: ERROR_ID });
    expect(JSON.stringify(onResult.mock.calls)).not.toMatch(/synthetic-|payload|details|cookie|token|message|text/);
  });

  it("only accepts UUID response correlation fields and bounds nonnegative duration", async () => {
    fetchMock.mockResolvedValue(ok({ text: "synthetic-private" }, { "X-Request-Id": "untrusted-private-id", "X-Error-Id": "not-a-uuid" }));
    const onResult = vi.fn();
    await apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult });
    const result = onResult.mock.calls[0][0];
    expect(result).toEqual({ outcome: "success", statusCode: 200, durationMs: expect.any(Number) });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThanOrEqual(86400000);
  });

  it("preserves invalid JSON failure and reports one failure with the received HTTP status", async () => {
    fetchMock.mockResolvedValue(new Response("not-json-private", { status: 200, headers: { "X-Request-Id": REQUEST } }));
    const onResult = vi.fn();
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).rejects.toBeInstanceOf(SyntaxError);
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ outcome: "failure", durationMs: expect.any(Number), statusCode: 200, requestId: REQUEST });
  });

  it.each(["network", "abort"])("preserves the original %s exception and never fabricates a server ID", async kind => {
    const original = Object.assign(new Error("synthetic-private-network-error"), { name: kind === "abort" ? "AbortError" : "TypeError" });
    fetchMock.mockRejectedValue(original);
    const onResult = vi.fn();
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).rejects.toBe(original);
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ outcome: kind === "abort" ? "cancelled" : "failure", durationMs: expect.any(Number) });
  });

  it("a throwing callback cannot change success or replace the original thrown value", async () => {
    const onResult = vi.fn(() => { throw new Error("synthetic callback exception"); });
    fetchMock.mockResolvedValueOnce(ok({ saved: true }));
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).resolves.toEqual({ saved: true });
    const original = new Error("synthetic-original-error");
    fetchMock.mockRejectedValueOnce(original);
    await expect(apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult })).rejects.toBe(original);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("keeps retry attempts and overlapping caller contexts separate", async () => {
    const first = vi.fn();
    const second = vi.fn();
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(ok({}, { "X-Request-Id": OTHER_REQUEST }));
    const pending = apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult: first });
    await apiFetch("/api/tasks/2", undefined, { actionId: OTHER_ACTION, onResult: second });
    release(ok({}, { "X-Request-Id": REQUEST }));
    await pending;
    expect(first).toHaveBeenCalledExactlyOnceWith({ outcome: "success", durationMs: expect.any(Number), statusCode: 200, requestId: REQUEST });
    expect(second).toHaveBeenCalledExactlyOnceWith({ outcome: "success", durationMs: expect.any(Number), statusCode: 200, requestId: OTHER_REQUEST });
    fetchMock.mockResolvedValueOnce(ok({}, { "X-Request-Id": OTHER_REQUEST }));
    await apiFetch("/api/tasks/1", undefined, { actionId: ACTION, onResult: first });
    expect(first.mock.calls.map(([result]) => result.requestId)).toEqual([REQUEST, OTHER_REQUEST]);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-Action-Id")).toBe(ACTION);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("X-Action-Id")).toBe(OTHER_ACTION);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("X-Action-Id")).toBe(ACTION);
  });
});
