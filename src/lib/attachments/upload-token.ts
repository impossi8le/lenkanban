import { createHmac, timingSafeEqual } from "node:crypto";
import { MAX_ATTACHMENT_BYTES } from "./storage";

/** Upload URL lifetime. The body itself has a separate 120 s streaming deadline. */
export const UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_LENGTH = 4096;
const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{32,64}$/;
const MIN_SECRET_LENGTH = 16;

export class UploadTokenError extends Error {
  constructor(readonly code: "INVALID" | "EXPIRED") {
    super(code === "EXPIRED" ? "Upload token expired" : "Invalid upload token");
    this.name = "UploadTokenError";
  }
}

export type UploadTokenPayload = {
  v: 1;
  taskId: string;
  actorId: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  nonce: string;
  expiresAt: number;
};

/** Server-only signing key. A weak or missing key disables the protocol. */
export function readUploadTokenSecret(env: Record<string, string | undefined>): string | null {
  const candidate = (env.ATTACHMENT_UPLOAD_SECRET ?? env.NEXTAUTH_SECRET ?? "").trim();
  return candidate.length >= MIN_SECRET_LENGTH ? candidate : null;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function encode(payload: UploadTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function createUploadToken(secret: string, payload: UploadTokenPayload): string {
  const encoded = encode(payload);
  return `${encoded}.${sign(secret, encoded)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): UploadTokenPayload {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 9) throw new UploadTokenError("INVALID");
  const { v, taskId, actorId, fileId, name, mime, size, nonce, expiresAt } = value;
  if (v !== 1
    || typeof taskId !== "string" || !TASK_ID.test(taskId)
    || typeof actorId !== "string" || !actorId || actorId.length > 200
    || typeof fileId !== "string" || !FILE_ID.test(fileId)
    || typeof name !== "string" || !name || name.length > 200
    || typeof mime !== "string" || !mime || mime.length > 200
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES
    || typeof nonce !== "string" || !NONCE.test(nonce)
    || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new UploadTokenError("INVALID");
  }
  return { v: 1, taskId, actorId, fileId, name, mime, size, nonce, expiresAt };
}

/**
 * Verifies the HMAC before parsing the payload. The token is a capability for
 * one staged object only: task, actor, key and declared metadata are all bound.
 */
export function verifyUploadToken(token: unknown, secret: string, now: Date): UploadTokenPayload {
  if (typeof token !== "string" || token.length < 3 || token.length > MAX_TOKEN_LENGTH) {
    throw new UploadTokenError("INVALID");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new UploadTokenError("INVALID");
  const [encoded, signature] = parts;
  let expected: string;
  try {
    expected = sign(secret, encoded);
  } catch {
    throw new UploadTokenError("INVALID");
  }
  const actual = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new UploadTokenError("INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new UploadTokenError("INVALID");
  }
  const payload = parsePayload(parsed);
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || now.getTime() >= payload.expiresAt) {
    throw new UploadTokenError("EXPIRED");
  }
  return payload;
}
