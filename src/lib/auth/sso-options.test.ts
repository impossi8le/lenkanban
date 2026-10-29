import type { NextAuthOptions } from "next-auth";
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ verify: vi.fn(), apply: vi.fn(), limit: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/sso-provider", () => ({ resolveCorporateProvider: f.resolve }));
vi.mock("@/lib/sso", () => ({ applyCorporateIdentity: f.apply }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: f.limit, getClientIpFromHeaders: () => "test-ip" }));
import { withCorporateProvider } from "./sso-options";
const options: NextAuthOptions = { providers: [], session: { strategy: "jwt" }, callbacks: {} };
function authorize() {
  const provider = withCorporateProvider(options).providers[0];
  if (provider.type !== "credentials") throw new Error("expected credentials");
  // NextAuth merges CredentialsProvider.options into the provider at initialization.
  return (provider.options as typeof provider).authorize;
}
beforeEach(() => {
  vi.resetAllMocks(); f.resolve.mockReturnValue({ verify: f.verify });
  f.verify.mockResolvedValue({ subject: "one" }); f.apply.mockResolvedValue({ id: "u1", email: "one@example.invalid" });
});
it("composes without altering existing callbacks/session or local providers", () => {
  const result = withCorporateProvider(options);
  expect(result.callbacks).toBe(options.callbacks); expect(result.session).toBe(options.session);
  expect(options.providers).toHaveLength(0);
});
it("validates before mapping and returns the persisted identity for signed NextAuth session", async () => {
  expect(await authorize()({ assertion: "proof" }, { headers: {} })).toEqual({ id: "u1", email: "one@example.invalid" });
  expect(f.verify).toHaveBeenCalledWith("proof", "login"); expect(f.apply).toHaveBeenCalledWith({ subject: "one" }, "login");
});
it.each(["missing", "invalid", "limit", "database"])("fails closed for %s", async failure => {
  if (failure === "missing") f.resolve.mockReturnValue(null);
  if (failure === "invalid") f.verify.mockResolvedValue(null);
  if (failure === "limit") f.limit.mockRejectedValue(new Error("secret must not escape"));
  if (failure === "database") f.apply.mockRejectedValue(new Error("secret must not escape"));
  expect(await authorize()({ assertion: "proof" }, { headers: {} })).toBeNull();
});
