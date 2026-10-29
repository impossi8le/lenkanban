import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthOptions, Session } from "next-auth";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  queryRaw: vi.fn(),
  logCalls: [] as unknown[][],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique }, $queryRaw: mocks.queryRaw },
}));

// Any technical logging from this module is captured so the tests can prove the
// user-supplied name value never reaches a sink.
vi.mock("@/lib/logger", () => {
  const record = (...args: unknown[]) => {
    mocks.logCalls.push(args);
  };
  const sink = { info: record, warn: record, error: record, debug: record, trace: record, fatal: record };
  return {
    logger: sink,
    apiLogger: sink,
    authLogger: sink,
    socketLogger: sink,
    dbLogger: sink,
    emailLogger: sink,
    automationLogger: sink,
  };
});

import { nextAuthOptions } from "./nextauth";

const EXISTING_NAME = "Старое имя";
const UPDATED_NAME = "Секретное Имя-42";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.logCalls.length = 0;
  mocks.queryRaw.mockResolvedValue([{ blocked: false }]);
  mocks.findUnique.mockResolvedValue({ globalRole: "ADMIN", email: "test@example.invalid" });
});

type JwtCallbackParams = Parameters<NonNullable<NonNullable<NextAuthOptions["callbacks"]>["jwt"]>>[0];

function jwtUpdate(payload: unknown, token: Record<string, unknown> = { sub: "user-1", name: EXISTING_NAME }) {
  // The published type requires `user`/`account`, but NextAuth omits both on a
  // session update; the callbacks must not depend on them.
  return nextAuthOptions.callbacks!.jwt!({
    token,
    trigger: "update",
    session: payload,
  } as unknown as JwtCallbackParams);
}

async function sessionFor(token: Record<string, unknown>, staleName: string | undefined = EXISTING_NAME) {
  const session: Session = {
    expires: "2026-10-01",
    user: { name: staleName, email: "test@example.invalid" },
  };
  return nextAuthOptions.callbacks!.session!({
    session,
    token,
    user: { id: "unused", email: "test@example.invalid", emailVerified: null },
    newSession: undefined,
    trigger: "update",
  });
}

describe("jwt callback on a session update", () => {
  it("carries a valid new name from the update payload into the token", async () => {
    const token = await jwtUpdate({ name: `  ${UPDATED_NAME}  ` });
    expect(token.name).toBe(UPDATED_NAME);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   \t\n  "],
    ["missing field", undefined],
    ["null", null],
    ["number", 42],
    ["object", { toString: () => UPDATED_NAME }],
    ["array", [UPDATED_NAME]],
    ["too long", "x".repeat(101)],
  ])("keeps the stored name for an invalid value: %s", async (_label, value) => {
    const token = await jwtUpdate({ name: value });
    expect(token.name).toBe(EXISTING_NAME);
  });

  it("keeps the stored name when update() is called without a payload", async () => {
    const token = await jwtUpdate(undefined);
    expect(token.name).toBe(EXISTING_NAME);
  });

  it("ignores the update payload when the trigger is not an update", async () => {
    const token = await nextAuthOptions.callbacks!.jwt!({
      token: { sub: "user-1", name: EXISTING_NAME },
      trigger: "signIn",
      session: { name: UPDATED_NAME },
    } as unknown as JwtCallbackParams);
    expect(token.name).toBe(EXISTING_NAME);
  });

  it("leaves a token without a stored name unchanged when the update is invalid", async () => {
    const token = await jwtUpdate({ name: "   " }, { sub: "user-1" });
    expect(token.name).toBeUndefined();
  });
});

describe("session callback", () => {
  it("exposes the name stored in the token instead of the stale session value", async () => {
    const session = await sessionFor({ sub: "user-1", name: UPDATED_NAME });
    expect(session.user?.name).toBe(UPDATED_NAME);
  });

  it("omits the name when the token has none", async () => {
    const session = await sessionFor({ sub: "user-1" }, undefined);
    expect(session.user?.name).toBeUndefined();
  });

  it("does not expose a name for a deleted or blocked account", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect((await sessionFor({ sub: "user-1", name: UPDATED_NAME })).user).toBeUndefined();

    mocks.findUnique.mockResolvedValue({ globalRole: "ADMIN", email: "test@example.invalid" });
    mocks.queryRaw.mockResolvedValue([{ blocked: true }]);
    expect((await sessionFor({ sub: "user-1", name: UPDATED_NAME })).user).toBeUndefined();
  });
});

describe("name privacy", () => {
  it("never writes the name value to a logger or the console", async () => {
    const consoleSpies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];

    const token = await jwtUpdate({ name: UPDATED_NAME });
    await sessionFor(token);

    const logged = [
      ...mocks.logCalls,
      ...consoleSpies.flatMap((spy) => spy.mock.calls),
    ];
    expect(JSON.stringify(logged)).not.toContain(UPDATED_NAME);
    expect(JSON.stringify(logged)).not.toContain(EXISTING_NAME);
  });
});
