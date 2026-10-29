import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ query: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: runtime.query, user: { findUnique: runtime.user } } }));
// Password timing is covered by authorize tests. This suite exercises admission,
// without paying twenty bcrypt rounds or creating a real account/session.
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(async () => false) } }));
import { POST } from "./route";
import { nextAuthOptions } from "@/lib/nextauth";

const credentials = { email: "unknown-account@example.invalid", password: "synthetic-invalid-password" };
const headers = { "x-forwarded-for": "203.0.113.7" };
const authorize = (nextAuthOptions.providers[0] as unknown as {
  options: { authorize: (value: typeof credentials, request: { headers: typeof headers }) => Promise<unknown> };
}).options.authorize;
let counts: Map<string, number>;
let originalMode: string | undefined;
beforeEach(() => {
  vi.resetAllMocks(); counts = new Map();
  originalMode = process.env.LOCAL_AUTH_MODE; process.env.LOCAL_AUTH_MODE = "open";
  runtime.user.mockResolvedValue(null); // No real account, password check or session.
  runtime.query.mockImplementation(async (_sql, key: string, ...values: unknown[]) => {
    const limit = values.find(value => typeof value === "number") as number;
    const count = counts.get(key) ?? 0;
    if (count >= limit) return [];
    counts.set(key, count + 1); return [{ count: count + 1 }];
  });
});
afterEach(() => {
  if (originalMode === undefined) delete process.env.LOCAL_AUTH_MODE;
  else process.env.LOCAL_AUTH_MODE = originalMode;
});
function preflight() {
  return POST(new Request("https://app.test/api/auth-login", {
    method: "POST", headers, body: JSON.stringify(credentials),
  }));
}

describe("actual login preflight plus credentials admission", () => {
  it("charges separate preflight and actual-auth IP buckets for one full form submit", async () => {
    expect((await preflight()).status).toBe(200);
    expect(await authorize(credentials, { headers })).toBeNull();
    expect(counts.get("auth:login:203.0.113.7")).toBe(1);
    expect(counts.get("auth:login:preflight:203.0.113.7")).toBe(1);
    expect([...counts.entries()].filter(([key]) => key.startsWith("auth:login:email:")))
      .toEqual([[expect.stringMatching(/^auth:login:email:[a-f0-9]+$/), 1]]);
  });

  it("admits twenty complete form attempts and gives preflight 429/Retry-After on the next", async () => {
    for (let index = 0; index < 20; index++) {
      expect((await preflight()).status).toBe(200);
      expect(await authorize(credentials, { headers })).toBeNull();
    }
    const limited = await preflight();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({ error: "RateLimited", retryAfter: 60 });
    expect(runtime.user).toHaveBeenCalledTimes(20);
    expect(counts.get("auth:login:203.0.113.7")).toBe(20);
    expect(counts.get("auth:login:preflight:203.0.113.7")).toBe(20);
  });

  it("does not allow preflight separation to bypass direct callback or account limits", async () => {
    for (let index = 0; index < 20; index++) await authorize(credentials, { headers });
    expect((await preflight()).status).toBe(200);
    expect(await authorize(credentials, { headers })).toBeNull();
    expect(runtime.user).toHaveBeenCalledTimes(20);
    expect(counts.get("auth:login:203.0.113.7")).toBe(20);
    expect([...counts.entries()].find(([key]) => key.startsWith("auth:login:email:"))?.[1]).toBe(20);
  });

  it("retains the account quota across different effective IP addresses", async () => {
    for (let index = 1; index <= 20; index++) {
      await authorize(credentials, { headers: { "x-forwarded-for": `203.0.113.${index}` } });
    }
    expect(await authorize(credentials, { headers: { "x-forwarded-for": "203.0.113.21" } })).toBeNull();
    expect(runtime.user).toHaveBeenCalledTimes(20);
    expect(counts.get("auth:login:203.0.113.21")).toBe(1);
    expect([...counts.entries()].find(([key]) => key.startsWith("auth:login:email:"))?.[1]).toBe(20);
  });

  it("retains generic fail-closed credentials rejection when the shared store fails", async () => {
    runtime.query.mockRejectedValue(new Error("synthetic-private-store-error"));
    // Preflight has no authentication authority; the actual authorize remains closed.
    expect((await preflight()).status).toBe(200);
    expect(await authorize(credentials, { headers })).toBeNull();
    expect(runtime.user).not.toHaveBeenCalled();
  });
});
