import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ verify: vi.fn(), apply: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/sso-provider", () => ({ resolveCorporateProvider: () => ({ verify: f.verify }) }));
vi.mock("@/lib/sso", () => ({ applyCorporateIdentity: f.apply }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrow: f.limit }));
import { POST } from "./route";
const request = () => new Request("https://test.invalid/api/auth/sso/sync", { method: "POST", headers: { authorization: "Bearer proof" } });
beforeEach(() => { vi.resetAllMocks(); f.verify.mockResolvedValue({ disabled: true }); });
it("accepts only provider-authenticated sync proof", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(f.verify).toHaveBeenCalledWith("proof", "sync"); expect(f.apply).toHaveBeenCalledWith({ disabled: true }, "sync");
});
it("rejects invalid proof without mutating accounts", async () => {
  f.verify.mockResolvedValue(null); expect((await POST(request())).status).toBe(401); expect(f.apply).not.toHaveBeenCalled();
});
it("reports failure without exposing provider/database errors", async () => {
  f.apply.mockRejectedValue(new Error("synthetic-secret"));
  const response = await POST(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-secret");
});
