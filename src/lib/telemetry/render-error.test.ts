import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ capture: vi.fn(), render: vi.fn(), client: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureException: mocks.capture }));
vi.mock("./client", () => ({ getBrowserTelemetryClient: mocks.client }));
import { reportRenderFailure } from "./render-error";
const FIRST = "a12bc345-6789-4abc-8def-012345678901";
const SECOND = "b12bc345-6789-4abc-8def-012345678901";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce(FIRST).mockReturnValue(SECOND) });
  mocks.context.mockReturnValue("1:actor-A-session");
  mocks.client.mockReturnValue({ captureRenderFailure: mocks.render, getDiagnosticContext: mocks.context });
});
afterEach(() => vi.unstubAllGlobals());

it("uses one stable local reference for the same Error without duplicate sink attempts", () => {
  const error = new Error("synthetic-private-render-message");
  error.stack = "synthetic-private-stack";
  expect(reportRenderFailure(error)).toBe(FIRST);
  expect(reportRenderFailure(error)).toBe(FIRST);
  expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(error, { errorId: FIRST, event: "client.render.failed", operation: "app.render" });
  expect(mocks.render).toHaveBeenCalledExactlyOnceWith(FIRST);
  expect(JSON.stringify(mocks.render.mock.calls)).not.toMatch(/synthetic-private|message|stack/);
});

it("different Error instances receive different references even with identical messages", () => {
  expect(reportRenderFailure(new Error("same-private-text"))).toBe(FIRST);
  expect(reportRenderFailure(new Error("same-private-text"))).toBe(SECOND);
  expect(mocks.capture).toHaveBeenCalledTimes(2);
  expect(mocks.render.mock.calls).toEqual([[FIRST], [SECOND]]);
});

it("gives the same Error a fresh reference after account A switches to account B", () => {
  const error = new Error("synthetic-reused-private-error");
  expect(reportRenderFailure(error)).toBe(FIRST);
  mocks.context.mockReturnValue("3:actor-B-session");
  expect(reportRenderFailure(error)).toBe(SECOND);
  expect(reportRenderFailure(error)).toBe(SECOND);
  expect(mocks.capture.mock.calls.map(([, context]) => context.errorId)).toEqual([FIRST, SECOND]);
  expect(mocks.render.mock.calls).toEqual([[FIRST], [SECOND]]);
});

it("reports the same Error again after an unready context obtains a registered session", () => {
  const error = new Error("synthetic-reused-before-init");
  mocks.context.mockReturnValue("1:unready");
  expect(reportRenderFailure(error)).toBe(FIRST);
  expect(reportRenderFailure(error)).toBe(FIRST);
  mocks.context.mockReturnValue("1:registered-session");
  expect(reportRenderFailure(error)).toBe(SECOND);
  expect(reportRenderFailure(error)).toBe(SECOND);
  expect(mocks.capture).toHaveBeenCalledTimes(2);
  expect(mocks.render.mock.calls).toEqual([[FIRST], [SECOND]]);
});

it("does not claim delivery when there is no initialized browser telemetry client", () => {
  mocks.client.mockReturnValue(null);
  expect(reportRenderFailure(new Error("synthetic-private"))).toBe(FIRST);
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  expect(mocks.render).not.toHaveBeenCalled();
});

it("contains failures of UUID generation, sink adapters, and malformed thrown values", () => {
  vi.stubGlobal("crypto", { randomUUID: () => { throw new Error("uuid unavailable"); } });
  expect(reportRenderFailure(new Error("synthetic-private"))).toBeNull();
  expect(mocks.capture).not.toHaveBeenCalled();
  vi.stubGlobal("crypto", { randomUUID: () => FIRST });
  mocks.capture.mockImplementation(() => { throw new Error("sink adapter unavailable"); });
  expect(reportRenderFailure(new Error("different-private"))).toBeNull();
  expect(() => reportRenderFailure("synthetic-string-throw" as unknown as Error)).not.toThrow();
});
