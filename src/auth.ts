/**
 * Stable import path for the authentication policy (`@/auth`).
 *
 * NextAuth itself is configured in `src/lib/nextauth.ts` and exposed through
 * `src/app/api/auth/[...nextauth]/route.ts`. This module only re-exports the
 * provider-agnostic contract so that a future corporate identity adapter can be
 * wired in without changing every importer.
 */
export {
  canManageLocalPassword,
  deniesAccessForStatus,
  externalIdentityKey,
  isAccountAllowed,
  isAccountStatusStrict,
  isEmergencyAdminEmail,
  isLocalCredentialsSignInAllowed,
  isLocalRegistrationAllowed,
  localAuthMode,
  normalizeEmail,
  planExternalLink,
  readAccountStatus,
  readExternalId,
  requireUser,
  resolveExternalIdentityAdapter,
} from "@/lib/auth";

export type {
  AccountStatus,
  AccountStatusSource,
  ExternalIdentity,
  ExternalIdentityAdapter,
  ExternalLinkPlan,
  LocalAuthMode,
} from "@/lib/auth";
