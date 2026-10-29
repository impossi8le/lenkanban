import { createHash } from "node:crypto";

import type { NextAuthOptions } from "next-auth";
import type { NextApiRequest } from "next";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

import { normalizeLogin } from "@/lib/login-identity";
import { prisma } from "@/lib/prisma";
import { getClientIpFromHeaders, rateLimitOrThrowKey } from "@/lib/rate-limit";
import { rememberResolvedIdentity } from "@/lib/session-cache";
import {
  deniesAccessForStatus,
  isAccountStatusStrict,
  isEmailVerificationRequired,
  isLocalCredentialsSignInAllowed,
  readAccountStatus,
} from "@/lib/auth";

/**
 * A fixed, non-secret bcrypt hash used only to keep the timing of "unknown email"
 * close to "wrong password". It never matches a real credential.
 */
const TIMING_EQUALIZER_HASH = "$2b$12$drLkzltboNsgTFWZ99reI.qQcYiDZHDP24144kB7fpSY4KIP3aJdO";

function emailRateLimitKey(email: string): string {
  return createHash("sha256").update(email, "utf8").digest("hex").slice(0, 32);
}

/**
 * `PATCH /api/user/profile` accepts names up to 100 characters. The session copy
 * follows the same bound so an oversized client payload cannot bloat the JWT.
 */
const MAX_PROFILE_NAME_LENGTH = 100;

/**
 * Reads the name supplied through `useSession().update({ name })`.
 *
 * Only a non-empty string of reasonable length is accepted; any other value
 * keeps the name already stored in the token, so an empty update cannot erase
 * it. The value is user data and is never logged.
 */
function readUpdatedName(session: unknown): string | null {
  if (!session || typeof session !== "object") return null;
  const candidate = (session as { name?: unknown }).name;
  if (typeof candidate !== "string") return null;
  const name = candidate.trim();
  if (!name || name.length > MAX_PROFILE_NAME_LENGTH) return null;
  return name;
}

export const nextAuthOptions: NextAuthOptions = {
  pages: {
    signIn: "/sign-in",
  },
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Логин", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        const email = normalizeLogin(credentials?.email);
        const password = typeof credentials?.password === "string" ? credentials.password : "";

        // Every rejection below returns `null`. NextAuth turns it into the same
        // generic `CredentialsSignin`, so a caller cannot tell "no such account",
        // "wrong password", "unverified" or "blocked" apart.
        if (!email || !password) return null;

        // Rate limit by IP and by email. Both are best-effort stores; any limiter
        // failure denies the attempt (fail-closed) instead of bypassing the limit.
        try {
          const ip = getClientIpFromHeaders((req as NextApiRequest | undefined)?.headers);
          await rateLimitOrThrowKey("auth:login", ip);
          await rateLimitOrThrowKey("auth:login", `email:${emailRateLimitKey(email)}`);
        } catch {
          return null;
        }

        // When the corporate provider is the only allowed source, local passwords
        // stop working for everyone except the configured emergency administrator.
        if (!isLocalCredentialsSignInAllowed(email)) return null;

        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            passwordHash: true,
            emailVerified: true,
            globalRole: true,
          },
        });

        if (!user?.passwordHash) {
          // Equalize the work done for an unknown email against a real compare.
          await bcrypt.compare(password, TIMING_EQUALIZER_HASH);
          return null;
        }

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        // An unverified address must not reveal that the password was correct.
        if (isEmailVerificationRequired() && !user.emailVerified) return null;

        // Blocked accounts cannot start a new session. `unknown` is allowed unless
        // strict mode is on, so deploying before the migration is not a lockout.
        if (deniesAccessForStatus(await readAccountStatus(user.id))) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatarUrl,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user?.id) token.sub = user.id;
      if (user?.email) token.email = user.email;
      // A profile update is the only place where the client may change the
      // displayed name. The role and the identity still come from the database.
      if (trigger === "update") {
        const name = readUpdatedName(session);
        if (name) token.name = name;
      }
      return token;
    },
    async session({ session, token }) {
      if (!session.user || !token.sub) return session;

      // The role and the revocation state always come from the database, never
      // from a client session-update payload. The whole row is read once: the
      // request guards reuse it (`requireDbUser`) instead of querying the same
      // account a second time in the same request.
      const user = await prisma.user.findUnique({ where: { id: token.sub } });

      if (!user) {
        // Deleted account: the JWT must not keep granting access.
        return { ...session, user: undefined };
      }

      const status = await readAccountStatus(token.sub);
      if (deniesAccessForStatus(status)) {
        // Blocked account: drop the identity so every `requireSession`-based
        // guard rejects this cookie immediately, without waiting for JWT expiry.
        return { ...session, user: undefined };
      }

      session.user.id = token.sub;
      if (user.email) session.user.email = user.email;
      // Always project the name from the token: after `update()` the session
      // skeleton still carries the name decoded from the old token.
      session.user.name = typeof token.name === "string" && token.name ? token.name : undefined;
      session.user.globalRole = user.globalRole;

      // Hand the row to the request guards. The session object is created per
      // read, so this never outlives the request that produced it.
      rememberResolvedIdentity(session, { user, status });
      return session;
    },
  },
};

/**
 * Deployment note: `AUTH_STATUS_STRICT=1` should be enabled only after the
 * `User.isBlocked` / `User.blockedAt` migration is applied. Before that the status
 * probe reports `unknown` and sessions stay usable.
 */
export const accountStatusStrict = isAccountStatusStrict;
