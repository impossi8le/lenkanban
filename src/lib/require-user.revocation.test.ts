import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  findUnique: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique }, $queryRaw: mocks.queryRaw },
}));

import { requireDbUser } from "./require-user";
import { UnauthorizedError } from "./errors";
import { resetRevocationColumnProbe } from "./auth";

const ENV_KEYS = ["AUTH_STATUS_STRICT"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.AUTH_STATUS_STRICT;
  vi.resetAllMocks();
  resetRevocationColumnProbe();
  mocks.getServerSession.mockResolvedValue({
    expires: "2026-10-01",
    user: { id: "user-1", email: "employee@example.invalid" },
  });
  mocks.findUnique.mockResolvedValue({ id: "user-1", email: "employee@example.invalid", globalRole: "USER" });
  mocks.queryRaw.mockResolvedValue([{ blocked: false }]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("requireDbUser", () => {
  it("resolves the current identity by session email", async () => {
    await expect(requireDbUser()).resolves.toMatchObject({ id: "user-1" });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { email: "employee@example.invalid" } });
  });

  it("rejects a blocked account with a still-valid session cookie", async () => {
    mocks.queryRaw.mockResolvedValue([{ blocked: true }]);
    await expect(requireDbUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a deleted account", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(requireDbUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a session without an email without querying the database", async () => {
    mocks.getServerSession.mockResolvedValue({ expires: "2026-10-01", user: { id: "user-1" } });
    await expect(requireDbUser()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("keeps access when the revocation status is unreadable before the migration", async () => {
    mocks.queryRaw.mockRejectedValue(Object.assign(new Error('column "isBlocked" does not exist'), { code: "42703" }));
    await expect(requireDbUser()).resolves.toMatchObject({ id: "user-1" });
  });

  it("denies access when the status is unreadable and strict mode is enabled", async () => {
    process.env.AUTH_STATUS_STRICT = "1";
    mocks.queryRaw.mockRejectedValue(new Error("connection reset"));
    await expect(requireDbUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
