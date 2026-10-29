import { createHash, randomBytes } from "crypto";
import { z } from "zod";

export const API_TOKEN_SCOPES = [
  "request.read", "request.create", "request.update", "request.move", "request.comment",
  "request.attachment.read", "request.export", "board.create", "board.columns.manage",
  "board.members.manage", "board.privileges.manage",
] as const;
export type ApiTokenScope = typeof API_TOKEN_SCOPES[number];
export const apiTokenOptionsSchema = z.object({
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).default([]),
  expiresAt: z.coerce.date().nullable().optional().transform(value => value ?? null),
});

export type ApiTokenPlaintext = {
  token: string;
  prefix: string;
  hash: string;
  scopes: ApiTokenScope[];
  expiresAt: Date | null;
};

// Token format: kb2_<prefix>_<secret>
// - prefix: short identifier (not secret), allows quick lookup
// - secret: high entropy
export function generateApiToken(options: { scopes?: readonly ApiTokenScope[]; expiresAt?: Date | null } = {}): ApiTokenPlaintext {
  const { scopes, expiresAt } = apiTokenOptionsSchema.parse(options);
  const prefix = randomBytes(6).toString("hex"); // 12 chars
  const secret = randomBytes(32).toString("base64url");
  const token = `kb2_${prefix}_${secret}`;
  const hash = hashApiToken(token);
  return { token, prefix, hash, scopes: [...new Set(scopes)], expiresAt };
}

export function hashApiToken(token: string) {
  // Fast + stable; OK for random high-entropy tokens. (Not for passwords.)
  return createHash("sha256").update(token).digest("hex");
}

export function parseApiToken(token: string): { prefix: string } | null {
  const m = /^kb2_([a-f0-9]{12})_[A-Za-z0-9_-]{20,}$/.exec(token.trim());
  if (!m) return null;
  return { prefix: m[1] };
}
