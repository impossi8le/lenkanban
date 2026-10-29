import { isIP } from "node:net";

/**
 * Single server-side source for the Socket.IO process endpoints.
 * No historical production domain is embedded here: an unset configuration
 * means same-origin/loopback defaults, never a previously deployed host.
 */
const DEFAULT_SOCKET_PORT = 3556;
const DEFAULT_APP_PORT = 3555;
const LOOPBACK_HOST = "127.0.0.1";

export function parsePort(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}

export function getSocketPort(): number {
  return parsePort(process.env.SOCKET_PORT, DEFAULT_SOCKET_PORT);
}

function getInternalEmitHost(): string {
  const host = process.env.INTERNAL_EMIT_HOST?.trim();
  if (!host) return LOOPBACK_HOST;
  const ipVersion = isIP(host);
  if (ipVersion === 6) return `[${host}]`;
  if (ipVersion === 4) return host;
  // Accept a DNS hostname only, never a URL, port, credentials or path.
  if (host.length <= 253 && !/^[\d.]+$/.test(host) && host.split(".").every(label =>
    label.length > 0 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)
  )) return host;
  return LOOPBACK_HOST;
}

/** Signed server-only bridge; explicit host supports a separate container. */
export function getInternalEmitUrl(): string {
  return `http://${getInternalEmitHost()}:${getSocketPort()}/internal/emit`;
}

function configuredOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Configured application origin, in precedence order. Returns undefined when
 * nothing valid is configured so callers can use a same-origin/loopback path.
 */
export function getAppOrigin(): string | undefined {
  return configuredOrigin(process.env.NEXT_PUBLIC_APP_URL)
    ?? configuredOrigin(process.env.APP_URL)
    ?? configuredOrigin(process.env.NEXTAUTH_URL);
}

/** Next.js session endpoint used by the socket process for cookie validation. */
export function getSessionApiUrl(): URL {
  const origin = getAppOrigin();
  const url = origin
    ? new URL(origin)
    : new URL(`http://${LOOPBACK_HOST}:${parsePort(process.env.PORT, DEFAULT_APP_PORT)}`);
  url.pathname = "/api/auth/session";
  return url;
}
