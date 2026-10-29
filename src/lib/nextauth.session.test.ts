import { beforeEach, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { nextAuthOptions } from "./nextauth";
import { recallResolvedIdentity } from "./session-cache";

const { findUnique, queryRaw } = vi.hoisted(() => ({ findUnique: vi.fn(), queryRaw: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique }, $queryRaw: queryRaw } }));

beforeEach(() => {
  vi.resetAllMocks();
  // The revocation probe is a separate query; default to an active account.
  queryRaw.mockResolvedValue([{ blocked: false }]);
});

async function sessionFor(sub?: string, clientRole = "ADMIN") {
  const session: Session = { expires: "2026-10-01", user: { name: "Pavel", email: "test@example.invalid" } };
  return nextAuthOptions.callbacks!.session!({
    session, token: { sub },
    user: { id: "unused", email: "test@example.invalid", emailVerified: null },
    newSession: { user: { globalRole: clientRole } }, trigger: "update",
  });
}

it("exposes the current database role for an existing JWT session", async () => {
  findUnique.mockResolvedValue({ id: "user-1", globalRole: "ADMIN", email: "test@example.invalid" });
  expect((await sessionFor("user-1")).user).toMatchObject({ id: "user-1", globalRole: "ADMIN" });
  // One read of the whole row: the request guards reuse it instead of reading
  // the same account again.
  expect(findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } });
  expect(findUnique).toHaveBeenCalledTimes(1);
});

it("hands the database row and status to the request guards", async () => {
  const row = { id: "user-1", globalRole: "USER", email: "test@example.invalid" };
  findUnique.mockResolvedValue(row);
  const session = await sessionFor("user-1");
  expect(recallResolvedIdentity(session)).toEqual({ user: row, status: "active" });
});

it("does not expose an identity to the guards for a blocked account", async () => {
  findUnique.mockResolvedValue({ id: "user-1", globalRole: "ADMIN", email: "test@example.invalid" });
  queryRaw.mockResolvedValue([{ blocked: true }]);
  const session = await sessionFor("user-1");
  expect(recallResolvedIdentity(session)).toBeNull();
});

it("refreshes a downgraded role and ignores client-provided elevation", async () => {
  findUnique.mockResolvedValue({ globalRole: "USER", email: "test@example.invalid" });
  expect((await sessionFor("user-1", "ADMIN")).user).toMatchObject({ globalRole: "USER" });
});

it("drops the identity for a deleted database user instead of reporting USER", async () => {
  findUnique.mockResolvedValue(null);
  expect((await sessionFor("deleted-user")).user).toBeUndefined();
});

it("drops the identity for a blocked account without waiting for JWT expiry", async () => {
  findUnique.mockResolvedValue({ globalRole: "ADMIN", email: "test@example.invalid" });
  queryRaw.mockResolvedValue([{ blocked: true }]);
  expect((await sessionFor("user-1")).user).toBeUndefined();
});

it("does not query the database without a signed subject", async () => {
  await sessionFor();
  expect(findUnique).not.toHaveBeenCalled();
  expect(queryRaw).not.toHaveBeenCalled();
});
