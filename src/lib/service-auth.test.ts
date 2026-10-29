import { describe, expect, it } from "vitest";
import { hasConfiguredServiceSecret, isServiceBearerAuthorized } from "./service-auth";

describe("service authentication", () => {
  const secret = "test-only-service-secret";
  it("accepts exactly the configured bearer without trimming", () => {
    expect(hasConfiguredServiceSecret(secret)).toBe(true);
    expect(isServiceBearerAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });
  it.each([undefined, null, "", " ", "two words", "\tsecret", "secret\n", "secret\r", "secret\0", "secret\u007f", "café", 123, {}, []])("rejects missing, blank, control or non-ASCII secret %j", (invalidSecret) => {
    expect(hasConfiguredServiceSecret(invalidSecret)).toBe(false);
    expect(isServiceBearerAuthorized(`Bearer ${secret}`, invalidSecret)).toBe(false);
  });
  it.each([undefined, null, "", "Bearer wrong", "Basic test", `bearer ${secret}`, `Bearer ${secret} `, ` Bearer ${secret}`, `Bearer ${secret}\n`, [`Bearer ${secret}`], [`Bearer ${secret}`, "Bearer wrong"], 123, {}])("rejects malformed, wrong or repeated auth %j", (header) => {
    expect(isServiceBearerAuthorized(header, secret)).toBe(false);
  });
  it("rejects equal string length but unequal UTF-8 bytes without throwing", () => {
    expect(() => isServiceBearerAuthorized("Bearer é", "a")).not.toThrow();
    expect(isServiceBearerAuthorized("Bearer é", "a")).toBe(false);
  });
  it("does not invoke hostile input coercion or property traps", () => {
    const hostile = new Proxy({}, { get() { throw Error("private"); }, getPrototypeOf() { throw Error("private"); } });
    expect(() => hasConfiguredServiceSecret(hostile)).not.toThrow();
    expect(hasConfiguredServiceSecret(hostile)).toBe(false);
    expect(() => isServiceBearerAuthorized(hostile, secret)).not.toThrow();
    expect(isServiceBearerAuthorized(hostile, secret)).toBe(false);
    expect(() => isServiceBearerAuthorized("Bearer anything", hostile)).not.toThrow();
    expect(isServiceBearerAuthorized("Bearer anything", hostile)).toBe(false);
  });
});
