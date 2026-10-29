import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({ apiLogger: { warn: vi.fn() } }));
import { installFrameworkWarningBoundary } from "./framework-warning-boundary";

const require = createRequire(import.meta.url);
const nextActions = require("next/dist/server/app-render/action-utils.js") as {
  getActionNotFoundError: (id: string) => Error;
  getInvalidServerReferenceIdError: (id: string) => Error;
};
const secret = "synthetic-private-action-token";

function fixture() {
  const original = vi.fn();
  const target = { warn: original, error: vi.fn() };
  const logger = { warn: vi.fn() };
  installFrameworkWarningBoundary({ console: target, logger });
  return { target, original, logger };
}

describe("owned Next Server Action warning boundary", () => {
  it.each([
    ["E788", nextActions.getActionNotFoundError],
    ["E793", nextActions.getInvalidServerReferenceIdError],
  ] as const)("adapts installed Next %s warning without passing its text", (code, createError) => {
    const { target, original, logger } = fixture();
    target.warn(createError(secret));
    expect(original).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith({
      event: "framework.server_action.rejected", source: "server", outcome: "rejected", statusCode: 404, errorCode: code,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
  });

  it("never reads recognized Error message, stack, coercion or nested secrets", () => {
    const { target, original, logger } = fixture();
    const read = vi.fn(() => { throw Error(secret); });
    const error = nextActions.getActionNotFoundError(secret);
    Object.defineProperties(error, {
      message: { get: read }, stack: { get: read }, cause: { get: read },
      toString: { get: read }, nested: { value: { token: secret, error: Error(secret) } },
    });
    expect(() => target.warn(error)).not.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(original).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
  });

  it("installs once across module reloads and preserves the existing wrapper", async () => {
    const { target, original, logger } = fixture();
    const wrapper = target.warn;
    installFrameworkWarningBoundary({ console: target, logger });
    vi.resetModules();
    const reloaded = await import("./framework-warning-boundary");
    reloaded.installFrameworkWarningBoundary({ console: target, logger });
    expect(target.warn).toBe(wrapper);
    target.warn(nextActions.getActionNotFoundError(secret));
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });

  it("never falls back to raw output if the safe sink throws", () => {
    const { target, original, logger } = fixture();
    logger.warn.mockImplementation(() => { throw Error(secret); });
    expect(() => target.warn(nextActions.getInvalidServerReferenceIdError(secret))).not.toThrow();
    expect(original).not.toHaveBeenCalled();
    expect(target.error).not.toHaveBeenCalled();
  });

  it("forwards an uninspectable proxy without adding a classification failure", () => {
    const { target, original, logger } = fixture();
    const read = vi.fn(() => { throw Error(secret); });
    const warning = new Proxy({}, { getPrototypeOf: read, get: read });
    expect(() => target.warn(warning)).not.toThrow();
    expect(original).toHaveBeenCalledOnce();
    // Compare identity without asking the assertion formatter to inspect Proxy fields.
    expect(original.mock.calls[0].length).toBe(1);
    expect(original.mock.calls[0][0] === warning).toBe(true);
    expect(original.mock.contexts[0]).toBe(target);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("forwards unrelated warnings with exact receiver and argument identities", () => {
    const { target, original, logger } = fixture();
    const receiver = { custom: true };
    const ordinary = Error(secret);
    const inherited = Object.create(Object.assign(Error(secret), { __NEXT_ERROR_CODE: "E788" }));
    const getter = vi.fn(() => "E788");
    const accessor = Object.defineProperty(Error(secret), "__NEXT_ERROR_CODE", { get: getter });
    const otherCode = Object.assign(Error(secret), { __NEXT_ERROR_CODE: "E999" });
    const plain = { __NEXT_ERROR_CODE: "E788", error: ordinary };
    const inputs = [[], [ordinary], [inherited], [accessor], [otherCode], [plain],
      [nextActions.getActionNotFoundError(secret), "extra"], ["warning", { nested: { token: secret } }]];
    for (const args of inputs) Reflect.apply(target.warn, receiver, args);
    expect(original.mock.calls).toEqual(inputs);
    expect(original.mock.contexts).toEqual(inputs.map(() => receiver));
    expect(getter).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    target.error(ordinary);
    expect(target.error).toHaveBeenCalledExactlyOnceWith(ordinary);
  });
});
