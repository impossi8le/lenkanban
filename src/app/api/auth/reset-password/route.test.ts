import { beforeEach, describe, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ db: vi.fn(), limiter: vi.fn(), hash: vi.fn(), mail: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: effects.db, update: effects.db, updateMany: effects.db }, $queryRaw: effects.db, $transaction: effects.db } }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrow: effects.limiter, rateLimitErrorResponse: effects.limiter }));
vi.mock("bcryptjs", () => ({ default: { hash: effects.hash } }));
vi.mock("@/lib/email", () => ({ generateToken: effects.mail, sendPasswordResetEmail: effects.mail }));
vi.mock("@/lib/logger", () => ({ logAuthEvent: effects.log }));
import { POST } from "./route";

beforeEach(() => { vi.resetAllMocks(); effects.db.mockRejectedValue(new Error("MUST_NOT_ACCESS_DATABASE")); });
describe("local recovery is managed exclusively by SSO", () => {
  it.each([
    ["known-looking address", JSON.stringify({ email: "synthetic@example.invalid" })],
    ["unknown-looking address", JSON.stringify({ email: "unknown@example.invalid" })],
    ["old reset token", JSON.stringify({ token: "synthetic-private-token", password: "synthetic-private-password" })],
    ["invalid JSON", "{broken"], ["empty body", ""],
  ])("returns identical opaque410 without reading %s or external effects", async (_label, body) => {
    const request = new Request("https://app.test/api/auth/recovery?token=synthetic-private-query", { method: "POST", body });
    const json = vi.spyOn(request, "json");
    const text = vi.spyOn(request, "text");
    const response = await POST(request);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ success: false, error: {
      code: "RECOVERY_MANAGED_BY_SSO", message: "Восстановление доступа выполняется через корпоративный SSO.",
    } });
    expect(json).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });
  it.each([429, 500])("never reaches even a failed limiter with status%s", async status => {
    effects.limiter.mockRejectedValue(Object.assign(new Error("synthetic-provider-secret"), { status }));
    const response = await POST(new Request("https://app.test/api/auth/recovery", { method: "POST" }));
    expect(response.status).toBe(410);
    expect(await response.text()).not.toMatch(/synthetic|token|password|email/i);
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });
});
