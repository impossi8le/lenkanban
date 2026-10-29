const TOKEN_REGEX = /^v1\.([0-9]{13})\.([0-9a-f]{64})$/;
const MAX_FUTURE_WINDOW_MS = (24 * 60 + 5) * 60 * 1000; // 24 hours + 5 minutes = 86,700,000 ms

/**
 * Validates and extracts the session expiry timestamp from a token and ISO string.
 *
 * @param token - Expected format: `v1.<13 decimal digits>.<64 lowercase hex chars>`
 * @param expiresAt - Canonical ISO 8601 UTC string matching token timestamp
 * @param nowMs - Current time in milliseconds (must be finite, non-negative)
 * @returns Expiry timestamp in milliseconds if valid, otherwise null
 */
export function parseSessionExpiry(
  token: unknown,
  expiresAt: unknown,
  nowMs: number
): number | null {
  if (typeof token !== 'string') {
    return null;
  }

  const match = TOKEN_REGEX.exec(token);
  if (!match || match[0] !== token) {
    return null;
  }

  if (typeof expiresAt !== 'string') {
    return null;
  }

  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) {
    return null;
  }

  const expiryMs = Number(match[1]);
  if (!Number.isSafeInteger(expiryMs)) {
    return null;
  }

  let canonicalIso: string;
  try {
    canonicalIso = new Date(expiryMs).toISOString();
  } catch {
    return null;
  }

  if (expiresAt !== canonicalIso) {
    return null;
  }

  if (expiryMs <= nowMs || expiryMs > nowMs + MAX_FUTURE_WINDOW_MS) {
    return null;
  }

  return expiryMs;
}
