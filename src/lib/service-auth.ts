import { timingSafeEqual } from "node:crypto";

const VALID_SECRET_REGEX = /^[\x21-\x7E]+$/;

export function hasConfiguredServiceSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length > 0 && VALID_SECRET_REGEX.test(secret);
}

export function isServiceBearerAuthorized(header: unknown, secret: unknown): boolean {
  if (!hasConfiguredServiceSecret(secret)) return false;
  const rawHeader = header;
  if (typeof rawHeader !== "string") return false;

  const expected = `Bearer ${secret}`;
  if (rawHeader.length !== expected.length) return false;
  const headerBuf = Buffer.from(rawHeader, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  if (headerBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(headerBuf, expectedBuf);
}
