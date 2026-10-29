import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  queryRaw: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: mocks.findUnique }, $queryRaw: mocks.queryRaw } }));
vi.mock("@/lib/rate-limit", () => ({
  getClientIpFromHeaders: () => "203.0.113.7",
  rateLimitOrThrowKey: mocks.rateLimit,
}));

import { nextAuthOptions } from "./nextauth";
import { resetRevocationColumnProbe } from "./auth";

/** bcrypt hash of "correct horse battery" at the production cost. */
const PASSWORD_HASH = "$2b$12$3tbqX4zEdbR65LaKYP8J/.qUW0bUuSKsdYLbekAHS9VRDcsyHj47G";

const ENV_KEYS = ["LOCAL_AUTH_MODE", "EMERGENCY_ADMIN_EMAIL", "AUTH_STATUS_STRICT", "EMAIL_VERIFICATION_REQUIRED"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.LOCAL_AUTH_MODE = "open";
  process.env.EMAIL_VERIFICATION_REQUIRED = "true";
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.queryRaw.mockResolvedValue([{ blocked: false }]);
  resetRevocationColumnProbe();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

// NextAuth v4 keeps the user-supplied credentials config under `options`; the
// top-level `authorize` is the library's `() => null` placeholder.
const authorize = (nextAuthOptions.providers[0] as unknown as {
  options: { authorize: (c: Record<string, unknown>, req: unknown) => Promise<unknown> };
}).options;

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "employee@example.invalid",
    name: "Employee",
    avatarUrl: null,
    passwordHash: PASSWORD_HASH,
    emailVerified: new Date(Date.UTC(2026, 9, 1)),
    globalRole: "USER",
    ...overrides,
  };
}

const request = { headers: { "x-forwarded-for": "203.0.113.7" } };

describe("credentials authorize", () => {
  it("maps short aliases and full synthetic emails to the same account and rate key", async () => {
    mocks.findUnique.mockResolvedValue(user({ email: "barhat@taskboard.lenremontn8n.ru" }));
    for (const email of [" BARHAT ", "barhat@taskboard.lenremontn8n.ru"]) {
      await expect(authorize.authorize({ email, password: "correct horse battery" }, request))
        .resolves.toMatchObject({ email: "barhat@taskboard.lenremontn8n.ru" });
    }
    for (const call of mocks.findUnique.mock.calls) {
      expect(call[0].where).toEqual({ email: "barhat@taskboard.lenremontn8n.ru" });
    }
    expect(mocks.rateLimit.mock.calls[1][1]).toBe(mocks.rateLimit.mock.calls[3][1]);
  });
  it.each([undefined, "false"])("allows the first ADMIN then rejects blocking for flag %s", async (flag) => {
    if (flag === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
    else process.env.EMAIL_VERIFICATION_REQUIRED = flag;
    mocks.findUnique.mockResolvedValue(user({
      email: "admin@example.invalid", globalRole: "ADMIN", emailVerified: null,
    }));
    await expect(authorize.authorize({ email: "admin@example.invalid", password: "correct horse battery" }, request))
      .resolves.toMatchObject({ id: "user-1", email: "admin@example.invalid" });
    mocks.queryRaw.mockResolvedValue([{ blocked: true }]);
    await expect(authorize.authorize({ email: "admin@example.invalid", password: "correct horse battery" }, request)).resolves.toBeNull();
  });

  it.each([undefined, "false"])("allows the first ADMIN then requires confirmation when flag %s changes to true", async (flag) => {
    if (flag === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
    else process.env.EMAIL_VERIFICATION_REQUIRED = flag;
    mocks.findUnique.mockResolvedValue(user({
      email: "admin@example.invalid", globalRole: "ADMIN", emailVerified: null,
    }));
    await expect(authorize.authorize({ email: "admin@example.invalid", password: "correct horse battery" }, request))
      .resolves.toMatchObject({ id: "user-1", email: "admin@example.invalid" });
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    await expect(authorize.authorize({ email: "admin@example.invalid", password: "correct horse battery" }, request)).resolves.toBeNull();
  });

  it("signs in a verified local account with the right password", async () => {
    mocks.findUnique.mockResolvedValue(user());
    await expect(authorize.authorize(
      { email: "  Employee@Example.Invalid ", password: "correct horse battery" }, request,
    )).resolves.toMatchObject({ id: "user-1", email: "employee@example.invalid" });
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "employee@example.invalid" },
    }));
  });

  it("returns the same null for an unknown email as for a wrong password", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    await expect(authorize.authorize({ email: "nobody@example.invalid", password: "whatever" }, request))
      .resolves.toBeNull();

    mocks.findUnique.mockResolvedValueOnce(user());
    await expect(authorize.authorize({ email: "employee@example.invalid", password: "wrong password" }, request))
      .resolves.toBeNull();
  });

  it("rejects an unverified address without disclosing that the password matched", async () => {
    mocks.findUnique.mockResolvedValue(user({ emailVerified: null }));
    await expect(authorize.authorize({ email: "employee@example.invalid", password: "correct horse battery" }, request))
      .resolves.toBeNull();
  });

  it("rejects a blocked account", async () => {
    mocks.findUnique.mockResolvedValue(user());
    mocks.queryRaw.mockResolvedValue([{ blocked: true }]);
    await expect(authorize.authorize({ email: "employee@example.invalid", password: "correct horse battery" }, request))
      .resolves.toBeNull();
  });

  it("rejects every attempt when the rate limiter refuses", async () => {
    mocks.findUnique.mockResolvedValue(user());
    mocks.rateLimit.mockRejectedValue(Object.assign(new Error("RateLimited"), { status: 429 }));
    await expect(authorize.authorize({ email: "employee@example.invalid", password: "correct horse battery" }, request))
      .resolves.toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("fails closed when the limiter itself breaks", async () => {
    mocks.findUnique.mockResolvedValue(user());
    mocks.rateLimit.mockRejectedValue(new Error("database unavailable"));
    await expect(authorize.authorize({ email: "employee@example.invalid", password: "correct horse battery" }, request))
      .resolves.toBeNull();
  });

  it("limits by IP and by a hashed email key, never by the raw address", async () => {
    mocks.findUnique.mockResolvedValue(user());
    await authorize.authorize({ email: "employee@example.invalid", password: "correct horse battery" }, request);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    const keys = mocks.rateLimit.mock.calls.map((call) => call[1] as string);
    expect(keys[0]).toBe("203.0.113.7");
    expect(keys[1]).toMatch(/^email:[0-9a-f]{32}$/);
    expect(keys[1]).not.toContain("employee@example.invalid");
  });

  it("refuses a local password when only the emergency administrator may use one", async () => {
    process.env.LOCAL_AUTH_MODE = "admin-only";
    process.env.EMERGENCY_ADMIN_EMAIL = "rescue@example.invalid";
    mocks.findUnique.mockResolvedValue(user());
    await expect(authorize.authorize({ email: "employee@example.invalid", password: "correct horse battery" }, request))
      .resolves.toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();

    mocks.findUnique.mockResolvedValue(user({ id: "rescue-1", email: "rescue@example.invalid", globalRole: "ADMIN" }));
    await expect(authorize.authorize({ email: "rescue@example.invalid", password: "correct horse battery" }, request))
      .resolves.toMatchObject({ id: "rescue-1" });
  });

  it("rejects empty credentials before touching storage", async () => {
    await expect(authorize.authorize({ email: "", password: "x" }, request)).resolves.toBeNull();
    await expect(authorize.authorize({ email: "employee@example.invalid", password: "" }, request)).resolves.toBeNull();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
