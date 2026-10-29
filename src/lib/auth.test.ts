import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: queryRaw } }));

import {
  canManageLocalPassword,
  deniesAccessForStatus,
  externalIdentityKey,
  isEmergencyAdminEmail,
  isLocalCredentialsSignInAllowed,
  isLocalRegistrationAllowed,
  localAuthMode,
  normalizeEmail,
  planExternalLink,
  prismaAccountStatus,
  readAccountStatus,
  readExternalId,
  resetExternalIdColumnProbe,
  resetRevocationColumnProbe,
} from "./auth";

const ENV_KEYS = ["LOCAL_AUTH_MODE", "EMERGENCY_ADMIN_EMAIL", "AUTH_STATUS_STRICT"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetAllMocks();
  resetRevocationColumnProbe();
  resetExternalIdColumnProbe();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("local sign-in mode", () => {
  it("keeps self-service local accounts while no provider is configured", () => {
    process.env.LOCAL_AUTH_MODE = "open";
    expect(localAuthMode()).toBe("open");
    expect(isLocalRegistrationAllowed()).toBe(true);
    expect(isLocalCredentialsSignInAllowed("employee@example.invalid")).toBe(true);
  });

  it("restricts local passwords to the emergency administrator otherwise", () => {
    expect(localAuthMode()).toBe("admin-only");
    expect(isLocalRegistrationAllowed()).toBe(false);
    expect(isLocalCredentialsSignInAllowed("employee@example.invalid")).toBe(false);
  });

  it("falls back to admin-only for an unknown mode instead of reopening local passwords", () => {
    process.env.LOCAL_AUTH_MODE = "true";
    expect(localAuthMode()).toBe("admin-only");
    expect(isLocalCredentialsSignInAllowed("employee@example.invalid")).toBe(false);
  });

  it("matches the emergency administrator case-insensitively and only by exact email", () => {
    process.env.LOCAL_AUTH_MODE = "admin-only";
    process.env.EMERGENCY_ADMIN_EMAIL = "  Admin@Example.Invalid ";
    expect(isEmergencyAdminEmail("admin@example.invalid")).toBe(true);
    expect(isEmergencyAdminEmail("admin@example.invalid.evil")).toBe(false);
    expect(isEmergencyAdminEmail("other@example.invalid")).toBe(false);
    expect(isLocalCredentialsSignInAllowed("ADMIN@example.invalid")).toBe(true);
    expect(isLocalCredentialsSignInAllowed("employee@example.invalid")).toBe(false);
  });

  it("does not treat an empty configuration as a bypass", () => {
    process.env.EMERGENCY_ADMIN_EMAIL = "   ";
    expect(isEmergencyAdminEmail("")).toBe(false);
    expect(isEmergencyAdminEmail("anyone@example.invalid")).toBe(false);
  });

  it("normalizes emails", () => {
    expect(normalizeEmail("  User@Example.Invalid ")).toBe("user@example.invalid");
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(42)).toBe("");
  });
});

describe("account status and revocation", () => {
  it("always denies a blocked account", () => {
    expect(deniesAccessForStatus("blocked")).toBe(true);
    expect(deniesAccessForStatus("active")).toBe(false);
  });

  it("only denies an unreadable status in strict mode", () => {
    expect(deniesAccessForStatus("unknown")).toBe(false);
    process.env.AUTH_STATUS_STRICT = "1";
    expect(deniesAccessForStatus("unknown")).toBe(true);
  });

  it("reads blocked from either column", async () => {
    queryRaw.mockResolvedValue([{ blocked: true }]);
    expect(await prismaAccountStatus.read("user-1")).toBe("blocked");
    queryRaw.mockResolvedValue([{ blocked: false }]);
    expect(await prismaAccountStatus.read("user-1")).toBe("active");
  });

  it("reports unknown for a missing row", async () => {
    queryRaw.mockResolvedValue([]);
    expect(await prismaAccountStatus.read("user-1")).toBe("unknown");
  });

  it("reports unknown when the revocation columns are not migrated and stops probing", async () => {
    queryRaw.mockRejectedValue(Object.assign(new Error('column "isBlocked" does not exist'), { code: "42703" }));
    expect(await prismaAccountStatus.read("user-1")).toBe("unknown");
    expect(await prismaAccountStatus.read("user-2")).toBe("unknown");
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("retries after a transient database failure", async () => {
    queryRaw.mockRejectedValueOnce(new Error("connection reset"));
    expect(await prismaAccountStatus.read("user-1")).toBe("unknown");
    queryRaw.mockResolvedValueOnce([{ blocked: true }]);
    expect(await prismaAccountStatus.read("user-1")).toBe("blocked");
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("uses the injected source instead of the database", async () => {
    const source = { read: vi.fn().mockResolvedValue("blocked" as const) };
    expect(await readAccountStatus("user-1", source)).toBe("blocked");
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("never queries without a user id", async () => {
    expect(await prismaAccountStatus.read("")).toBe("unknown");
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("local password management", () => {
  it("refuses local recovery for an account bound to an external identity", () => {
    expect(canManageLocalPassword({ externalId: "corp#123", passwordHash: "x" })).toBe(false);
    expect(canManageLocalPassword({ externalId: "", passwordHash: "x" })).toBe(true);
    expect(canManageLocalPassword({ externalId: null })).toBe(true);
    expect(canManageLocalPassword({})).toBe(true);
  });

  it("reads externalId and tolerates the column not being migrated yet", async () => {
    queryRaw.mockResolvedValue([{ externalId: "corp#123" }]);
    expect(await readExternalId("user-1")).toBe("corp#123");

    resetExternalIdColumnProbe();
    queryRaw.mockRejectedValue(Object.assign(new Error('column "externalId" does not exist'), { code: "42703" }));
    expect(await readExternalId("user-1")).toBeNull();
    expect(await readExternalId("user-2")).toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("external identity key", () => {
  it("binds issuer and subject into one stable key", () => {
    expect(externalIdentityKey({ issuer: "https://idp.example.invalid", subject: "12345" }))
      .toBe("https://idp.example.invalid#12345");
  });

  it("rejects an empty issuer or subject", () => {
    expect(externalIdentityKey({ issuer: "", subject: "12345" })).toBeNull();
    expect(externalIdentityKey({ issuer: "iss", subject: "   " })).toBeNull();
  });

  it("rejects control characters and oversized keys", () => {
    expect(externalIdentityKey({ issuer: "iss", subject: "1\u0000" })).toBeNull();
    expect(externalIdentityKey({ issuer: "i".repeat(250), subject: "1".repeat(10) })).toBeNull();
  });
});

describe("external link planning", () => {
  it("links a returning identity to the same local user", () => {
    expect(planExternalLink({ identity: {}, key: "iss#1", existingByExternalId: { id: "user-1" } }))
      .toEqual({ action: "link", userId: "user-1" });
  });

  it("creates a new account for an unknown identity", () => {
    expect(planExternalLink({ identity: {}, key: "iss#1" })).toEqual({ action: "create" });
  });

  it("never merges into a local account only because the email matches", () => {
    expect(planExternalLink({
      identity: {}, key: "iss#1", existingByEmail: { id: "user-1", externalId: null },
    })).toEqual({ action: "deny", reason: "email-owned-by-local-account" });
  });

  it("refuses to re-bind an account that already has another external identity", () => {
    expect(planExternalLink({
      identity: {}, key: "iss#2", existingByEmail: { id: "user-1", externalId: "iss#1" },
    })).toEqual({ action: "deny", reason: "external-id-conflict" });
  });

  it("denies a suspended identity and a blocked account", () => {
    expect(planExternalLink({ identity: { disabled: true }, key: "iss#1" }))
      .toEqual({ action: "deny", reason: "blocked" });
    expect(planExternalLink({
      identity: {}, key: "iss#1", existingByExternalId: { id: "user-1", isBlocked: true },
    })).toEqual({ action: "deny", reason: "blocked" });
  });

  it("denies an identity without a usable key", () => {
    expect(planExternalLink({ identity: {}, key: null }))
      .toEqual({ action: "deny", reason: "external-id-conflict" });
  });
});
