import { createCanonicalPort } from "./local-port";
import { beforeEach, expect, it, vi } from "vitest";
import { bearer } from "./adapter";
import { hashApiToken } from "@/lib/api-tokens";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), session: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { apiToken: { findUnique: mocks.findUnique, update: mocks.update } } }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.session }));
vi.mock("@/lib/auth", () => ({ isAccountAllowed: mocks.allowed }));
const token = `kb2_123456789abc_${"z".repeat(43)}`;
const authorization = `Bearer ${token}`;
const row = { id: "token-row", revokedAt: null, user: { id: "owner", globalRole: "USER" } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findUnique.mockResolvedValue(row); mocks.update.mockResolvedValue({}); mocks.allowed.mockResolvedValue(true);
});

it("N1/N17 executes actual canonical token hashing, fresh revokedAt lookup and never falls back to a cookie session", async () => {
  const port = createCanonicalPort();
  expect(bearer(new Headers({ authorization, cookie: "session=synthetic" }))).toBe(authorization);
  await expect(port.authenticate(authorization)).resolves.toMatchObject({ id: "owner", globalRole: "USER" });
  mocks.findUnique.mockResolvedValue({ ...row, revokedAt: new Date() });
  await expect(port.authenticate(authorization)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  for (const [query] of mocks.findUnique.mock.calls) expect(query).toEqual({ where: { tokenHash: hashApiToken(token) }, include: { user: true } });
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

it("N2 re-reads the canonical owner/role each time, and fails closed for deleted/blocked accounts", async () => {
  const port = createCanonicalPort();
  await expect(port.authenticate(authorization)).resolves.toMatchObject({ id: "owner", globalRole: "USER" });
  mocks.findUnique.mockResolvedValue({ ...row, user: { id: "owner", globalRole: "ADMIN" } });
  await expect(port.authenticate(authorization)).resolves.toMatchObject({ id: "owner", globalRole: "ADMIN" });
  mocks.allowed.mockResolvedValue(false);
  await expect(port.authenticate(authorization)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  mocks.findUnique.mockResolvedValue(null);
  await expect(port.authenticate(authorization)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  expect(mocks.session).not.toHaveBeenCalled();
});
