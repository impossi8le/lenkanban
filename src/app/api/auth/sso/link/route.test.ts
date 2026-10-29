import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ user: vi.fn(), verify: vi.fn(), apply: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: f.user }));
vi.mock("@/lib/sso-provider", () => ({ resolveCorporateProvider: () => ({ verify: f.verify }) }));
vi.mock("@/lib/sso", () => ({ applyCorporateIdentity: f.apply }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrow: f.limit }));
import { POST } from "./route";
function request(origin = "https://test.invalid", body: unknown = { assertion: "proof", password: "local-password", userId: "attacker-target" }) {
  return new Request("https://test.invalid/api/auth/sso/link", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("NEXTAUTH_URL", "https://test.invalid"); f.user.mockResolvedValue({ id: "signed-user" });
  f.verify.mockResolvedValue({ subject: "one" }); f.apply.mockResolvedValue({ id: "signed-user" });
});
afterEach(() => vi.unstubAllEnvs());
it("uses the signed current user and never a submitted target id", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(f.verify).toHaveBeenCalledWith("proof", "link", "signed-user");
  expect(f.apply).toHaveBeenCalledWith({ subject: "one" }, "link", { userId: "signed-user", password: "local-password" });
});
it("rejects cross-origin CSRF before user lookup", async () => {
  expect((await POST(request("https://evil.invalid"))).status).toBe(403); expect(f.user).not.toHaveBeenCalled();
});
it.each(["session", "proof", "limit", "conflict"])("rejects %s with generic response", async failure => {
  if (failure === "session") f.user.mockRejectedValue(new Error("synthetic-secret"));
  if (failure === "proof") f.verify.mockResolvedValue(null);
  if (failure === "limit") f.limit.mockRejectedValue(new Error("synthetic-secret"));
  if (failure === "conflict") f.apply.mockRejectedValue(new Error("synthetic-secret"));
  const response = await POST(request()); expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("synthetic-secret");
});
it("rejects malformed input", async () => { expect((await POST(request(undefined, {}))).status).toBe(400); });
