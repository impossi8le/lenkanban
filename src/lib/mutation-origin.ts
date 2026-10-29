import { ForbiddenError } from "./errors";

/**
 * Configured public origin, else the origin Next.js derived for this request.
 * Behind a proxy the derived origin is the internal one (`http://localhost:3000`),
 * so a configured `NEXTAUTH_URL`/`APP_URL` is the only value a browser can match.
 */
export function trustedMutationOrigin(request: Request): string {
  // Match application URL precedence, but never skip malformed explicit trust
  // configuration in favour of a lower-priority URL or the incoming request.
  const configured = [process.env.NEXT_PUBLIC_APP_URL, process.env.APP_URL, process.env.NEXTAUTH_URL]
    .find(value => value?.trim());
  if (configured !== undefined) {
    try {
      const url = new URL(configured.trim());
      if ((url.protocol !== "http:" && url.protocol !== "https:")
        || url.username || url.password || url.search || url.hash) throw new ForbiddenError();
      return url.origin;
    } catch {
      throw new ForbiddenError();
    }
  }
  return new URL(request.url).origin;
}

/** The literal-space scheme recognized by getApiUser; other whitespace stays a cookie. */
function hasBearerCredential(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ") && authorization.slice(7).trim().length > 0;
}

/**
 * Same-site check for command mutations: organization administration, API tokens
 * and task lifecycle. A missing Origin is accepted only for a bearer credential,
 * because requireApiUser has already verified it.
 */
export function requireTrustedMutationOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new ForbiddenError();
  if (origin === null && hasBearerCredential(request)) return;
  if (origin !== trustedMutationOrigin(request)) throw new ForbiddenError();
}
