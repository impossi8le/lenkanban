import { describe, expect, it } from "vitest";
import {
  createUploadToken, readUploadTokenSecret, UPLOAD_TOKEN_TTL_MS, UploadTokenError,
  verifyUploadToken, type UploadTokenPayload,
} from "./upload-token";

const secret = "synthetic-upload-secret-value-0123456789";
const fileId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
const now = new Date("2026-10-22T10:00:00Z");

function payload(overrides: Partial<UploadTokenPayload> = {}): UploadTokenPayload {
  return {
    v: 1,
    taskId: "task-1",
    actorId: "actor-1",
    fileId,
    name: "report.pdf",
    mime: "application/pdf",
    size: 42,
    nonce: "a".repeat(48),
    expiresAt: now.getTime() + UPLOAD_TOKEN_TTL_MS,
    ...overrides,
  };
}

describe("upload token", () => {
  it("round-trips a server-issued payload", () => {
    const token = createUploadToken(secret, payload());
    expect(verifyUploadToken(token, secret, now)).toEqual(payload());
  });

  it("rejects a tampered payload or signature", () => {
    const token = createUploadToken(secret, payload());
    const [encoded, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload(), taskId: "other-task" }), "utf8").toString("base64url");
    expect(() => verifyUploadToken(`${forged}.${signature}`, secret, now)).toThrow(UploadTokenError);
    expect(() => verifyUploadToken(`${encoded}.${signature!.slice(0, -1)}A`, secret, now)).toThrow(UploadTokenError);
    expect(() => verifyUploadToken(token, `${secret}-other`, now)).toThrow(UploadTokenError);
  });

  it("rejects malformed tokens without throwing a parse error", () => {
    for (const value of [undefined, null, 42, "", ".", "a.b.c", `${"a".repeat(5000)}.b`]) {
      expect(() => verifyUploadToken(value, secret, now)).toThrow(UploadTokenError);
    }
  });

  it("expires at the bound deadline, not before", () => {
    const token = createUploadToken(secret, payload());
    expect(verifyUploadToken(token, secret, new Date(now.getTime() + UPLOAD_TOKEN_TTL_MS - 1)).taskId).toBe("task-1");
    expect(() => verifyUploadToken(token, secret, new Date(now.getTime() + UPLOAD_TOKEN_TTL_MS)))
      .toThrow(expect.objectContaining({ code: "EXPIRED" }));
  });

  it("refuses a payload with a non-canonical key or out-of-range size", () => {
    expect(() => verifyUploadToken(createUploadToken(secret, payload({ fileId: "../../etc/passwd" })), secret, now))
      .toThrow(UploadTokenError);
    expect(() => verifyUploadToken(createUploadToken(secret, payload({ size: 0 })), secret, now))
      .toThrow(UploadTokenError);
  });

  it("requires a sufficiently strong configured secret", () => {
    expect(readUploadTokenSecret({ ATTACHMENT_UPLOAD_SECRET: "short" })).toBeNull();
    expect(readUploadTokenSecret({})).toBeNull();
    expect(readUploadTokenSecret({ ATTACHMENT_UPLOAD_SECRET: secret })).toBe(secret);
    expect(readUploadTokenSecret({ NEXTAUTH_SECRET: secret })).toBe(secret);
  });
});
