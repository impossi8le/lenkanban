import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  queryRaw: vi.fn(),
  rateLimit: vi.fn(),
  sendVerificationEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique, create: mocks.create }, $queryRaw: mocks.queryRaw },
}));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(),
  getClientIpFromHeaders: () => "203.0.113.7",
  rateLimitOrThrow: mocks.rateLimit,
  rateLimitErrorResponse: (e: unknown) => Response.json(
    { error: "RateLimited", retryAfter: (e as { retryAfterSec: number }).retryAfterSec },
    { status: 429 },
  ),
}));
vi.mock("@/lib/email", () => ({
  generateToken: () => "synthetic-verification-token",
  sendVerificationEmail: mocks.sendVerificationEmail,
}));
vi.mock("@/lib/logger", () => ({ logAuthEvent: vi.fn() }));

import { POST } from "./route";

const ENV_KEYS = ["LOCAL_AUTH_MODE", "EMAIL_VERIFICATION_REQUIRED"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.LOCAL_AUTH_MODE = "open";
  process.env.EMAIL_VERIFICATION_REQUIRED = "true";
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.sendVerificationEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function request(body: unknown) {
  return new Request("https://app.test/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const valid = { email: "New.User@Example.Invalid", password: "synthetic-passphrase", name: "Test" };

describe("POST /api/auth/register", () => {
  it.each([undefined, "false"])("creates a verified account without SMTP for flag %s", async (flag) => {
    if (flag === undefined) delete process.env.EMAIL_VERIFICATION_REQUIRED;
    else process.env.EMAIL_VERIFICATION_REQUIRED = flag;
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: "user-1", email: "new.user@example.invalid", name: "Test" });
    mocks.sendVerificationEmail.mockRejectedValue(new Error("SMTP unavailable"));
    const response = await POST(request(valid));
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      emailVerified: expect.any(Date), verificationToken: null, verificationTokenExpiry: null, globalRole: "USER",
    });
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
    const duplicate = await (async () => {
      mocks.findUnique.mockResolvedValue({ id: "user-1" });
      return POST(request(valid));
    })();
    expect(await duplicate.json()).toEqual(await response.json());
  });

  it("keeps SMTP confirmation and leaves the account unverified when sending fails", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: "user-1", email: "new.user@example.invalid", name: "Test" });
    mocks.sendVerificationEmail.mockRejectedValue(new Error("SMTP unavailable"));
    expect((await POST(request(valid))).status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      emailVerified: null, verificationToken: "synthetic-verification-token", verificationTokenExpiry: expect.any(Date),
    });
    expect(mocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("creates a plain USER account and never an administrator", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: "user-1", email: "new.user@example.invalid", name: "Test" });

    const response = await POST(request(valid));
    expect(response.status).toBe(201);

    const args = mocks.create.mock.calls[0][0];
    expect(args.data).toMatchObject({ email: "new.user@example.invalid", globalRole: "USER" });
    expect(args.data.passwordHash).not.toBe(valid.password);
    expect(args.data.verificationToken).toBe("synthetic-verification-token");
  });

  it("returns an identical response for an address that already exists", async () => {
    mocks.findUnique.mockResolvedValue({ id: "user-9" });
    const duplicate = await POST(request(valid));
    const duplicateBody = await duplicate.json();

    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: "user-1", email: "new.user@example.invalid", name: "Test" });
    const fresh = await POST(request(valid));
    const freshBody = await fresh.json();

    expect(duplicate.status).toBe(fresh.status);
    expect(duplicateBody).toEqual(freshBody);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("refuses self-service registration when the local mode is closed", async () => {
    process.env.LOCAL_AUTH_MODE = "admin-only";
    const response = await POST(request(valid));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("REGISTRATION_DISABLED");
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limiter refuses", async () => {
    mocks.rateLimit.mockRejectedValue(Object.assign(new Error("RateLimited"), { status: 429, retryAfterSec: 60 }));
    const response = await POST(request(valid));
    expect(response.status).toBe(429);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a short password before any database access", async () => {
    const response = await POST(request({ email: "new.user@example.invalid", password: "short" }));
    expect(response.status).toBe(422);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
