import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), getClientIpFromHeaders: () => "203.0.113.7", rateLimitErrorResponse: vi.fn() }));
import { rateLimitOrThrowKey } from "@/lib/rate-limit";
import { POST } from "./route";

beforeEach(() => { vi.mocked(rateLimitOrThrowKey).mockResolvedValue(undefined); });
describe("login preflight", () => {
  it.each(["barhat", " BARHAT ", "barhat@taskboard.lenremontn8n.ru", "employee@example.invalid"])("accepts %s", async (email) => {
    const response = await POST(new Request("https://example.invalid/api/auth-login", {
      method: "POST", body: JSON.stringify({ email, password: "synthetic-password" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
  it.each(["", "a@@b.ru", "has spaces", "a@"])("rejects %s", async (email) => {
    const response = await POST(new Request("https://example.invalid/api/auth-login", {
      method: "POST", body: JSON.stringify({ email, password: "synthetic-password" }),
    }));
    expect(response.status).toBe(422);
  });
});
