/**
 * Shared server-side authentication policy.
 *
 * The source of truth for accounts is the local PostgreSQL database (`User`).
 * An external corporate identity provider (JWT/OIDC) is a future *option*: the
 * contract below is deliberately provider-agnostic so that an adapter can be
 * added without touching the session plumbing. See docs/engineering/SSO_CONTRACT.md.
 *
 * This module must stay free of NextAuth imports at module scope: `nextauth.ts`
 * imports it, and a static cycle would make the callbacks order-dependent.
 */

import { prisma } from "@/lib/prisma";
import { UnauthorizedError } from "@/lib/errors";

/** Maximum accepted length of a stored external identity key. */
export const EXTERNAL_ID_MAX_LENGTH = 255;

/** Emails are matched case-insensitively and trimmed. */
export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** SMTP verification is optional for the local MVP; only explicit true enables it. */
export function isEmailVerificationRequired(): boolean {
  return normalizeEmail(process.env.EMAIL_VERIFICATION_REQUIRED) === "true";
}

// ---------------------------------------------------------------------------
// Local sign-in mode
// ---------------------------------------------------------------------------

/**
 * `open`        — every local account with a password may sign in (current state).
 * `admin-only`  — only the emergency administrator may use a local password.
 *
 * Unknown values fall back to `admin-only`: a misconfigured environment must not
 * silently reopen the local password path once the corporate provider is live.
 */
export type LocalAuthMode = "open" | "admin-only";

export function localAuthMode(): LocalAuthMode {
  const raw = normalizeEmail(process.env.LOCAL_AUTH_MODE);
  return raw === "open" ? "open" : "admin-only";
}

/** Registration creates local password accounts; it is only allowed in `open` mode. */
export function isLocalRegistrationAllowed(): boolean {
  return localAuthMode() === "open";
}

/**
 * The emergency administrator is a local account that must keep working when the
 * corporate provider is unreachable. It is configured by email, never by a shared
 * bypass flag, so ordinary employees cannot use it.
 */
export function isEmergencyAdminEmail(email: unknown): boolean {
  const configured = normalizeEmail(process.env.EMERGENCY_ADMIN_EMAIL);
  if (!configured) return false;
  return normalizeEmail(email) === configured;
}

/** Whether a local password sign-in attempt is permitted for this email. */
export function isLocalCredentialsSignInAllowed(email: unknown): boolean {
  if (isEmergencyAdminEmail(email)) return true;
  return localAuthMode() === "open";
}

// ---------------------------------------------------------------------------
// Account status / revocation
// ---------------------------------------------------------------------------

/**
 * `blocked` — the account must not authenticate or keep an existing session.
 * `active`  — the account may use the application.
 * `unknown` — the status could not be read (row missing, or the revocation
 *             columns are not migrated yet).
 */
export type AccountStatus = "active" | "blocked" | "unknown";

export interface AccountStatusSource {
  read(userId: string): Promise<AccountStatus>;
}

/**
 * Revocation is fail-closed only when `AUTH_STATUS_STRICT=1`. That flag is meant
 * for environments where the `User.isBlocked` / `User.blockedAt` migration is
 * already applied: a read failure then denies access instead of degrading to the
 * pre-migration behaviour. Without the flag an unreadable status is allowed, so
 * deploying this code before the migration cannot lock every user out.
 */
export function isAccountStatusStrict(): boolean {
  return process.env.AUTH_STATUS_STRICT === "1";
}

/** Single decision point used by sessions, API guards and the sign-in callback. */
export function deniesAccessForStatus(status: AccountStatus): boolean {
  if (status === "blocked") return true;
  return status === "unknown" && isAccountStatusStrict();
}

/**
 * Once PostgreSQL reports the revocation columns as missing we stop issuing the
 * query for the lifetime of the process; otherwise every session read would pay
 * for a failing statement. A deploy after the migration re-detects them.
 */
let revocationColumns: "present" | "missing" | "unknown" = "unknown";

/** Test seam: lets a suite reset the cached schema probe. */
export function resetRevocationColumnProbe(): void {
  revocationColumns = "unknown";
}

function isMissingColumnError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "42703" || code === "P2021" || code === "P2022") return true;
  const message = error instanceof Error ? error.message : "";
  return /column .* does not exist/i.test(message);
}

export const prismaAccountStatus: AccountStatusSource = {
  async read(userId: string): Promise<AccountStatus> {
    if (!userId) return "unknown";
    if (revocationColumns === "missing") return "unknown";
    try {
      const rows = await prisma.$queryRaw<{ blocked: boolean | null }[]>`
        SELECT ("isBlocked" = true OR "blockedAt" IS NOT NULL) AS blocked
        FROM "User"
        WHERE "id" = ${userId}
        LIMIT 1
      `;
      revocationColumns = "present";
      const row = rows[0];
      if (!row) return "unknown";
      return row.blocked ? "blocked" : "active";
    } catch (error) {
      if (isMissingColumnError(error)) revocationColumns = "missing";
      // A database failure keeps the probe open so the next request retries.
      return "unknown";
    }
  },
};

export async function readAccountStatus(
  userId: string,
  source: AccountStatusSource = prismaAccountStatus
): Promise<AccountStatus> {
  return source.read(userId);
}

export async function isAccountAllowed(
  userId: string,
  source: AccountStatusSource = prismaAccountStatus
): Promise<boolean> {
  return !deniesAccessForStatus(await readAccountStatus(userId, source));
}

/**
 * Local password recovery must not become a way around the corporate provider.
 * An account bound to an external identity has no locally managed password.
 */
export function canManageLocalPassword(user: {
  externalId?: string | null;
  passwordHash?: string | null;
}): boolean {
  if (typeof user.externalId === "string" && user.externalId.length > 0) return false;
  return true;
}

let externalIdColumn: "present" | "missing" | "unknown" = "unknown";

/** Test seam for the `User.externalId` schema probe. */
export function resetExternalIdColumnProbe(): void {
  externalIdColumn = "unknown";
}

/**
 * Reads the corporate binding for a local account. Until the `externalId` column
 * is migrated the value is reported as `null` (i.e. "local account"), which keeps
 * password recovery working exactly as before the migration.
 */
export async function readExternalId(userId: string): Promise<string | null> {
  if (!userId || externalIdColumn === "missing") return null;
  try {
    const rows = await prisma.$queryRaw<{ externalId: string | null }[]>`
      SELECT "externalId" FROM "User" WHERE "id" = ${userId} LIMIT 1
    `;
    externalIdColumn = "present";
    return rows[0]?.externalId ?? null;
  } catch (error) {
    if (isMissingColumnError(error)) externalIdColumn = "missing";
    return null;
  }
}

// ---------------------------------------------------------------------------
// External identity adapter contract (no provider is implemented yet)
// ---------------------------------------------------------------------------

export interface ExternalIdentity {
  /** Adapter identifier, e.g. `corporate-jwt`. */
  readonly provider: string;
  /** Token issuer / IdP identifier. Together with `subject` it is the stable key. */
  readonly issuer: string;
  /** Stable, never-reassigned identifier of the person inside the issuer. */
  readonly subject: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly groups?: readonly string[];
  /** Provider-reported suspension flag; treated exactly like a local block. */
  readonly disabled?: boolean;
}

/**
 * An adapter validates the provider response on the server and returns a
 * normalized identity. It must never trust browser-supplied ids.
 */
export interface ExternalIdentityAdapter {
  readonly id: string;
  authenticate(request: Request): Promise<ExternalIdentity | null>;
}

/**
 * Integration point for the future corporate provider. Returning `null` keeps the
 * application on local credentials only, which is the agreed state for now.
 */
export function resolveExternalIdentityAdapter(): ExternalIdentityAdapter | null {
  return null;
}

/**
 * Stable storage key for `User.externalId`. The issuer is part of the key so that
 * two providers (or a re-issued issuer) can never collide.
 */
export function externalIdentityKey(identity: Pick<ExternalIdentity, "issuer" | "subject">): string | null {
  const issuer = typeof identity.issuer === "string" ? identity.issuer.trim() : "";
  const subject = typeof identity.subject === "string" ? identity.subject.trim() : "";
  if (!issuer || !subject) return null;
  const key = `${issuer}#${subject}`;
  if (key.length > EXTERNAL_ID_MAX_LENGTH) return null;
  // Control characters would corrupt logs and comparisons.
  if (/[\u0000-\u001f\u007f]/.test(key)) return null;
  return key;
}

export type ExternalLinkPlan =
  | { action: "link"; userId: string }
  | { action: "create" }
  | { action: "deny"; reason: "blocked" | "external-id-conflict" | "email-owned-by-local-account" };

/**
 * Pure linking decision.
 *
 * Rules agreed in #12:
 * - the same external key always maps to the same `User.id`;
 * - an email match alone never merges an external identity into a local account;
 * - an account already bound to another external key is never re-bound silently.
 */
export function planExternalLink(input: {
  identity: { disabled?: boolean };
  key: string | null;
  existingByExternalId?: { id: string; isBlocked?: boolean } | null;
  existingByEmail?: { id: string; externalId?: string | null; isBlocked?: boolean } | null;
}): ExternalLinkPlan {
  if (input.identity.disabled) return { action: "deny", reason: "blocked" };
  if (!input.key) return { action: "deny", reason: "external-id-conflict" };

  const bound = input.existingByExternalId;
  if (bound) {
    if (bound.isBlocked) return { action: "deny", reason: "blocked" };
    return { action: "link", userId: bound.id };
  }

  const byEmail = input.existingByEmail;
  if (byEmail) {
    if (byEmail.isBlocked) return { action: "deny", reason: "blocked" };
    if (byEmail.externalId) return { action: "deny", reason: "external-id-conflict" };
    // Deliberately no automatic merge by email.
    return { action: "deny", reason: "email-owned-by-local-account" };
  }

  return { action: "create" };
}

// ---------------------------------------------------------------------------
// Session guard
// ---------------------------------------------------------------------------

/**
 * Resolves the signed session and rejects blocked accounts. NextAuth is imported
 * lazily to keep this module free of an import cycle with `nextauth.ts`.
 */
export async function requireUser() {
  const [{ getServerSession }, { nextAuthOptions }] = await Promise.all([
    import("next-auth"),
    import("@/lib/nextauth"),
  ]);
  const session = await getServerSession(nextAuthOptions);
  const userId = session?.user?.id;
  if (!session?.user?.email || !userId) throw new UnauthorizedError();
  if (deniesAccessForStatus(await readAccountStatus(userId))) throw new UnauthorizedError();
  return session;
}
