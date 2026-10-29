import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  transaction: vi.fn(), compare: vi.fn(), revoked: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: f.transaction } }));
vi.mock("bcryptjs", () => ({ default: { compare: f.compare } }));
vi.mock("@/socket/board-events", () => ({ emitAuthRevoked: f.revoked }));
import { applyCorporateIdentity } from "./sso";
const identity = { provider: "stub", issuer: "lenkanban-test", subject: "one", email: "one@example.invalid", groups: ["employees"] };
const local = { id: "u1", email: identity.email, externalId: null, passwordHash: "hash", isBlocked: false, blockedAt: null };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("SSO_ALLOWED_GROUPS", "employees");
  f.transaction.mockImplementation(async callback => callback({ user: f }));
  f.findUnique.mockResolvedValue(null); f.findFirst.mockResolvedValue(null);
  f.create.mockResolvedValue({ id: "new", email: identity.email });
  f.update.mockResolvedValue({ id: "u1", email: identity.email });
  f.updateMany.mockResolvedValue({ count: 1 }); f.compare.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe("corporate mapping transactions (mock DB)", () => {
  it("creates USER only with stable binding", async () => {
    expect(await applyCorporateIdentity(identity, "login")).toMatchObject({ id: "new" });
    expect(f.create.mock.calls[0][0].data).toMatchObject({ globalRole: "USER", externalId: "lenkanban-test#one" });
    expect(f.transaction.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable" });
  });
  it("uses the existing pure policy to refuse merging by email", async () => {
    f.findFirst.mockResolvedValue(local);
    expect(await applyCorporateIdentity(identity, "login")).toBeNull(); expect(f.create).not.toHaveBeenCalled();
  });
  it("retains id and role on subsequent login/email change", async () => {
    f.findUnique.mockResolvedValue({ ...local, externalId: "lenkanban-test#one", globalRole: "ADMIN" });
    await applyCorporateIdentity(identity, "login");
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1" }, data: { email: identity.email } }));
  });
  it("rejects blockedAt even if isBlocked=false", async () => {
    f.findUnique.mockResolvedValue({ ...local, blockedAt: new Date() });
    expect(await applyCorporateIdentity(identity, "login")).toBeNull();
  });
  it("links only the password-proven current account and clears recovery credentials", async () => {
    f.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(local); f.findFirst.mockResolvedValue(local);
    expect(await applyCorporateIdentity(identity, "link", { userId: "u1", password: "proof" })).toEqual({ id: "u1" });
    expect(f.updateMany.mock.calls[0][0].data).toMatchObject({ passwordHash: null, resetToken: null, externalId: "lenkanban-test#one" });
  });
  it.each(["foreign-binding", "foreign-email", "password", "no-proof"])("refuses %s", async mode => {
    f.findUnique.mockResolvedValueOnce(mode === "foreign-binding" ? { ...local, id: "other" } : null).mockResolvedValueOnce(local);
    f.findFirst.mockResolvedValue(mode === "foreign-email" ? { ...local, id: "other" } : local);
    if (mode === "password") f.compare.mockResolvedValue(false);
    expect(await applyCorporateIdentity(identity, "link", mode === "no-proof" ? undefined : { userId: "u1", password: "proof" })).toBeNull();
    expect(f.updateMany).not.toHaveBeenCalled();
  });
  it.each(["disabled", "groups"])("persists %s revocation and signals only after commit", async mode => {
    f.findUnique.mockResolvedValue(local);
    f.transaction.mockImplementation(async callback => {
      const result = await callback({ user: f }); expect(f.revoked).not.toHaveBeenCalled(); return result;
    });
    await applyCorporateIdentity({ ...identity, ...(mode === "disabled" ? { disabled: true } : { groups: [] }) }, "sync");
    expect(f.update.mock.calls[0][0].data.isBlocked).toBe(true);
    expect(f.revoked).toHaveBeenCalledWith("u1", "corporate-access-revoked");
  });
  it("does not signal when transaction rolls back", async () => {
    f.findUnique.mockResolvedValue(local);
    f.transaction.mockImplementation(async callback => { await callback({ user: f }); throw new Error("rollback"); });
    await expect(applyCorporateIdentity({ ...identity, disabled: true }, "sync")).rejects.toThrow("rollback");
    expect(f.revoked).not.toHaveBeenCalled();
  });
  it("sync does not create missing users or unblock local blocks", async () => {
    await applyCorporateIdentity(identity, "sync"); expect(f.create).not.toHaveBeenCalled();
    f.findUnique.mockResolvedValue({ ...local, isBlocked: true });
    expect(await applyCorporateIdentity(identity, "sync")).toEqual({ id: "u1", admitted: false });
    expect(f.update).not.toHaveBeenCalled();
  });
});
