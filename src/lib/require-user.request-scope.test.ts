import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  findUnique: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique }, $queryRaw: mocks.queryRaw },
}));

import { nextAuthOptions } from "./nextauth";
import { requireDbUser, requireSession } from "./require-user";
import { requireApiUser } from "./require-api-user";
import { UnauthorizedError } from "./errors";
import { resetRevocationColumnProbe } from "./auth";

const ENV_KEYS = ["AUTH_STATUS_STRICT"] as const;
let saved: Record<string, string | undefined>;

/**
 * Replaces `getServerSession` with the real NextAuth `session` callback so the
 * test exercises the production identity path (database read inside the
 * callback) rather than a hand-written session object.
 */
function signInAs(userId = "user-1") {
  mocks.getServerSession.mockImplementation(async () => {
    const session: Session = {
      expires: "2026-10-01",
      user: { name: "Pavel", email: "employee@example.invalid" },
    };
    return nextAuthOptions.callbacks!.session!({
      session,
      token: { sub: userId, email: "employee@example.invalid", name: "Pavel" },
      user: { id: "unused", email: "employee@example.invalid", emailVerified: null },
      newSession: { user: { globalRole: "ADMIN" } },
      trigger: "update",
    });
  });
}

function httpRequest(url = "http://localhost/api/tasks") {
  return new Request(url);
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.AUTH_STATUS_STRICT;
  vi.resetAllMocks();
  resetRevocationColumnProbe();
  mocks.findUnique.mockResolvedValue({
    id: "user-1",
    email: "employee@example.invalid",
    name: "Pavel",
    globalRole: "USER",
    emailVerified: null,
    avatarUrl: null,
    isBlocked: false,
    blockedAt: null,
  });
  mocks.queryRaw.mockResolvedValue([{ blocked: false }]);
  signInAs();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("session reads inside one request", () => {
  it("reads the account from the database once for every guard of the request", async () => {
    const request = httpRequest();

    const [first, second, third] = await Promise.all([
      requireDbUser(request),
      requireDbUser(request),
      requireApiUser(request),
    ]);
    await requireDbUser(request);

    expect(first.id).toBe("user-1");
    expect(second.id).toBe("user-1");
    expect(third.id).toBe("user-1");
    // One row read plus one revocation probe, regardless of the guard count.
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    // The session itself is decoded once per request as well.
    expect(mocks.getServerSession).toHaveBeenCalledTimes(1);
  });

  it("shares the callback read between requireSession and requireDbUser", async () => {
    const request = httpRequest();

    await requireSession(request);
    const user = await requireDbUser(request);

    expect(user.id).toBe("user-1");
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("reads the account again on the next request", async () => {
    await requireDbUser(httpRequest("http://localhost/api/tasks?page=1"));
    await requireDbUser(httpRequest("http://localhost/api/tasks?page=2"));

    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("revocation is still applied on every request", () => {
  it("rejects a blocked account and does not fall back to another query", async () => {
    mocks.queryRaw.mockResolvedValue([{ blocked: true }]);
    const request = httpRequest();

    await expect(requireDbUser(request)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(requireApiUser(request)).rejects.toBeInstanceOf(UnauthorizedError);

    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects a deleted account", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const request = httpRequest();

    await expect(requireDbUser(request)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("denies access when the status is unreadable and strict mode is enabled", async () => {
    process.env.AUTH_STATUS_STRICT = "1";
    mocks.queryRaw.mockRejectedValue(new Error("connection reset"));

    await expect(requireDbUser(httpRequest())).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("keeps access when the revocation columns are not migrated yet", async () => {
    mocks.queryRaw.mockRejectedValue(
      Object.assign(new Error('column "isBlocked" does not exist'), { code: "42703" }),
    );

    await expect(requireDbUser(httpRequest())).resolves.toMatchObject({ id: "user-1" });
  });
});
