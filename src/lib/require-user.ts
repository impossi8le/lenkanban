import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { cache } from "react";

import { nextAuthOptions } from "@/lib/nextauth";
import { prisma } from "@/lib/prisma";
import { UnauthorizedError } from "@/lib/errors";
import { deniesAccessForStatus, readAccountStatus } from "@/lib/auth";
import { memoizeInRequest, recallResolvedIdentity } from "@/lib/session-cache";

/**
 * Server-render path: a layout and a page of the same render share one session
 * read. Route handlers have no React render scope, so they pass the `Request`
 * object and get the same guarantee from `memoizeInRequest`.
 */
const readSessionForRender = cache(() => getServerSession(nextAuthOptions));

export async function requireSession(request?: Request): Promise<Session> {
  const session = request
    ? await memoizeInRequest(request, "session", () => getServerSession(nextAuthOptions))
    : await readSessionForRender();
  if (!session?.user?.email) {
    throw new UnauthorizedError();
  }
  return session;
}

export async function requireDbUser(request?: Request) {
  const session = await requireSession(request);

  // The session callback already read this account (role and revocation state)
  // from the database for this very request. Reuse that row instead of reading
  // the same user again through the email lookup.
  const resolved = recallResolvedIdentity(session);
  if (resolved) {
    if (!resolved.user) {
      // Deleted account: the callback dropped the identity, keep denying.
      throw new UnauthorizedError();
    }
    // A blocked account loses API access immediately, even with a still-valid JWT.
    if (deniesAccessForStatus(resolved.status)) {
      throw new UnauthorizedError();
    }
    return resolved.user;
  }

  // Session assembled outside the callback (tests, older mocks): keep the
  // established email-based contract.
  const user = await memoizeInRequest(request, `user:${session.user!.email!}`, () =>
    prisma.user.findUnique({ where: { email: session.user!.email! } }),
  );
  if (!user) {
    // Should not happen because /api/auth/register creates it.
    throw new UnauthorizedError();
  }

  // A blocked account loses API access immediately, even with a still-valid JWT.
  const status = await memoizeInRequest(request, `status:${user.id}`, () =>
    readAccountStatus(user.id),
  );
  if (deniesAccessForStatus(status)) {
    throw new UnauthorizedError();
  }

  return user;
}

export function isGlobalAdmin(user: { globalRole?: string | null }) {
  return user.globalRole === "ADMIN";
}
