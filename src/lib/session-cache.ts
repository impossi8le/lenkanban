import type { User } from "@prisma/client";

import type { AccountStatus } from "@/lib/auth";

/**
 * Request-scoped memoization for the session identity.
 *
 * One navigation fires several API requests, and each of them used to read the
 * same account from PostgreSQL again (role + revocation probe, and then the same
 * row once more in `requireDbUser`). The scope below is bound to the `Request`
 * object that Next.js creates for a single HTTP request: two requests never share
 * an entry, so a revoked or blocked account is rejected on the very next request.
 *
 * There is deliberately no TTL and no process-wide cache. An entry lives exactly
 * as long as the request that created it, which keeps the "role and status are
 * always read from the database" contract intact.
 */

type RequestScope = Map<string, Promise<unknown>>;

const scopes = new WeakMap<object, RequestScope>();

function scopeFor(request: Request): RequestScope {
  let scope = scopes.get(request);
  if (!scope) {
    scope = new Map();
    scopes.set(request, scope);
  }
  return scope;
}

/**
 * Runs `load` once per request for the given key. Without a request object the
 * call is not memoized: there is no scope to attach it to.
 */
export function memoizeInRequest<T>(
  request: Request | null | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!request) return load();

  const scope = scopeFor(request);
  const cached = scope.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const pending = load();
  scope.set(key, pending);
  // A failed read is retried by the next caller instead of replaying the same
  // rejection for the rest of the request.
  pending.catch(() => {
    if (scope.get(key) === pending) scope.delete(key);
  });
  return pending;
}

/**
 * The account row and revocation status that the NextAuth `session` callback
 * already read. `requireDbUser` reuses it instead of querying the same account
 * again inside the same request.
 */
export type ResolvedIdentity = {
  user: User | null;
  status: AccountStatus;
};

const identities = new WeakMap<object, ResolvedIdentity>();

/** Called by the session callback with the object it is about to return. */
export function rememberResolvedIdentity(session: object, identity: ResolvedIdentity): void {
  identities.set(session, identity);
}

/**
 * Returns the identity read by the callback for this exact session object.
 * `null` means "not read here" (e.g. a session assembled outside the callback),
 * so the caller must fall back to its own query.
 */
export function recallResolvedIdentity(
  session: object | null | undefined,
): ResolvedIdentity | null {
  if (!session) return null;
  return identities.get(session) ?? null;
}
