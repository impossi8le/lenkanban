import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { corporateAdmission, resolveCorporateProvider, signStubAssertion, type StubAssertion } from "./sso-provider";

const secret = "synthetic-test-key-with-at-least-32-characters";
const claims = (): StubAssertion => ({ issuer: "lenkanban-test", subject: "employee-1", email: "one@example.invalid",
  groups: ["employees"], disabled: false, audience: "lenkanban", purpose: "login", expiresAt: Date.now() + 30000 });
beforeEach(() => {
  vi.stubEnv("SSO_TEST_MODE", "1"); vi.stubEnv("SSO_PROVIDER", "stub"); vi.stubEnv("SSO_STUB_SECRET", secret);
  vi.stubEnv("SSO_ALLOWED_GROUPS", "employees");
});
afterEach(() => vi.unstubAllEnvs());

describe("synthetic provider server validation", () => {
  it("validates a signed assertion and admission", async () => {
    const identity = await resolveCorporateProvider()!.verify(signStubAssertion(claims(), secret), "login");
    expect(identity?.subject).toBe("employee-1"); expect(corporateAdmission(identity!)).toBe(true);
  });
  it.each(["production", "disabled", "weak-key"])("does not resolve under %s", mode => {
    if (mode === "production") vi.stubEnv("NODE_ENV", "production");
    if (mode === "disabled") vi.stubEnv("SSO_TEST_MODE", "0");
    if (mode === "weak-key") vi.stubEnv("SSO_STUB_SECRET", "weak");
    expect(resolveCorporateProvider()).toBeNull();
  });
  it.each(["signature", "expired", "future", "issuer", "audience", "purpose", "malformed"])("rejects %s", async failure => {
    const input = { ...claims(), ...(failure === "expired" ? { expiresAt: Date.now() - 1 } : {}),
      ...(failure === "future" ? { expiresAt: Date.now() + 120000 } : {}),
      ...(failure === "issuer" ? { issuer: "evil" } : {}), ...(failure === "audience" ? { audience: "evil" } : {}),
      ...(failure === "purpose" ? { purpose: "sync" } : {}) } as StubAssertion;
    const assertion = failure === "malformed" ? "junk" : signStubAssertion(input, failure === "signature" ? "wrong" : secret);
    expect(await resolveCorporateProvider()!.verify(assertion, "login")).toBeNull();
  });
  it("binds link proof to the signed current local user", async () => {
    const assertion = signStubAssertion({ ...claims(), purpose: "link", localUserId: "u1" }, secret);
    expect(await resolveCorporateProvider()!.verify(assertion, "link", "u2")).toBeNull();
    expect(await resolveCorporateProvider()!.verify(assertion, "link", "u1")).not.toBeNull();
  });
  it("denies disabled, missing groups and unconfigured admission", () => {
    const identity = { ...claims(), provider: "stub" };
    expect(corporateAdmission({ ...identity, disabled: true })).toBe(false);
    expect(corporateAdmission({ ...identity, groups: [] })).toBe(false);
    vi.stubEnv("SSO_ALLOWED_GROUPS", ""); expect(corporateAdmission(identity)).toBe(false);
  });
});
