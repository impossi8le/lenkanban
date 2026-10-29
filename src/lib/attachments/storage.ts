import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AttachmentStorageError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "UNAVAILABLE") {
    super(code === "INVALID_INPUT" ? "Invalid attachment storage input" : "Attachment storage unavailable");
    this.name = "AttachmentStorageError";
  }
}

/** A staged key already holds an object; a retried upload must never replace it. */
export class AttachmentAlreadyExistsError extends Error {
  readonly code = "ALREADY_EXISTS";
  constructor() {
    super("Attachment object already exists");
    this.name = "AttachmentAlreadyExistsError";
  }
}

export interface PrivateAttachmentStore {
  put(taskId: string, bytes: Uint8Array): Promise<{ fileId: string; size: number }>;
  /**
   * Writes to a server-derived key without replacing an existing object. Used by
   * the presign protocol so a repeated PUT cannot change bytes after validation.
   */
  putWithId?(taskId: string, fileId: string, bytes: Uint8Array): Promise<{ fileId: string; size: number }>;
  get(taskId: string, fileId: string): Promise<Uint8Array | null>;
  /** Cleanup only: caller must own this upload attempt, not just know an ID. */
  deleteOwned(taskId: string, fileId: string): Promise<void>;
}

export type OwnedObject = { fileId: string; lastModified: Date | null };

/** Listing exists only for bounded, DB-aware reconciliation; it is not a read API. */
export interface ListableAttachmentStore extends PrivateAttachmentStore {
  list(taskId: string): Promise<OwnedObject[]>;
}

const MAX_LIST_PAGES = 5;
const MAX_LIST_KEYS = 5000;

export function taskPrefix(taskId: string): string {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) {
    throw new AttachmentStorageError("INVALID_INPUT");
  }
  const taskHash = createHash("sha256").update(taskId, "utf8").digest("hex");
  return `attachments/v1/${taskHash}/`;
}

export function objectKey(taskId: string, fileId: string): string {
  if (typeof fileId !== "string" || !FILE_ID.test(fileId)) {
    throw new AttachmentStorageError("INVALID_INPUT");
  }
  return `${taskPrefix(taskId)}${fileId}`;
}

/** Returns the file ID only for a key inside this task namespace with a canonical shape. */
function ownedFileId(prefix: string, key: unknown): string | null {
  if (typeof key !== "string" || !key.startsWith(prefix)) return null;
  const fileId = key.slice(prefix.length);
  return FILE_ID.test(fileId) ? fileId : null;
}

function isMissingObject(error: unknown): boolean {
  try {
    const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
    return candidate?.name === "NoSuchKey" && candidate.$metadata?.httpStatusCode === 404;
  } catch {
    return false;
  }
}

function isPreconditionFailed(error: unknown): boolean {
  try {
    const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
    return candidate?.name === "PreconditionFailed"
      || candidate?.name === "ConditionalRequestConflict"
      || candidate?.$metadata?.httpStatusCode === 412
      || candidate?.$metadata?.httpStatusCode === 409;
  } catch {
    return false;
  }
}

/** No environment lookup or automatic activation. Caller supplies a private bucket/client. */
export function createPrivateAttachmentStore(
  client: Pick<S3Client, "send">,
  bucket: string,
): ListableAttachmentStore {
  if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || bucket.includes("..")) {
    throw new AttachmentStorageError("INVALID_INPUT");
  }

  return {
    async put(taskId, bytes) {
      const fileId = randomUUID();
      const key = objectKey(taskId, fileId);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentStorageError("INVALID_INPUT");
      }
      // Keep the uploaded bytes stable across an await or transport retry.
      const body = Buffer.from(bytes);
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: "application/octet-stream",
          ContentDisposition: "attachment",
          CacheControl: "private, no-store",
          IfNoneMatch: "*",
        }));
        return { fileId, size: body.length };
      } catch {
        // Deliberately discard SDK message, cause, endpoint and request metadata.
        throw new AttachmentStorageError("UNAVAILABLE");
      }
    },

    async putWithId(taskId, fileId, bytes) {
      const key = objectKey(taskId, fileId);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentStorageError("INVALID_INPUT");
      }
      const body = Buffer.from(bytes);
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: "application/octet-stream",
          ContentDisposition: "attachment",
          CacheControl: "private, no-store",
          IfNoneMatch: "*",
        }));
        return { fileId, size: body.length };
      } catch (error) {
        if (isPreconditionFailed(error)) throw new AttachmentAlreadyExistsError();
        throw new AttachmentStorageError("UNAVAILABLE");
      }
    },

    async get(taskId, fileId) {
      const key = objectKey(taskId, fileId);
      let response;
      try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw new AttachmentStorageError("UNAVAILABLE");
      }

      const body = response.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
      let complete = false;
      try {
        const declared = response.ContentLength;
        if (typeof declared !== "number" || !Number.isSafeInteger(declared)
          || declared < 0 || declared > MAX_ATTACHMENT_BYTES
          || !body || typeof body[Symbol.asyncIterator] !== "function") {
          throw new AttachmentStorageError("UNAVAILABLE");
        }
        // One bounded buffer: millions of tiny chunks must not create millions of allocations.
        const bytes = Buffer.alloc(declared);
        let length = 0;
        for await (const chunk of body) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_ATTACHMENT_BYTES - length
            || chunk.byteLength > declared - length) {
            throw new AttachmentStorageError("UNAVAILABLE");
          }
          bytes.set(chunk, length);
          length += chunk.byteLength;
        }
        if (length !== declared) throw new AttachmentStorageError("UNAVAILABLE");
        complete = true;
        return bytes;
      } catch {
        throw new AttachmentStorageError("UNAVAILABLE");
      } finally {
        if (!complete) {
          try { body?.destroy?.(); } catch { /* Cleanup cannot replace the safe failure. */ }
        }
      }
    },

    async deleteOwned(taskId, fileId) {
      const key = objectKey(taskId, fileId);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        throw new AttachmentStorageError("UNAVAILABLE");
      }
    },

    async list(taskId) {
      const prefix = taskPrefix(taskId);
      const found: OwnedObject[] = [];
      let token: string | undefined;
      try {
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const response = await client.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix, MaxKeys: 1000,
            ...(token ? { ContinuationToken: token } : {}),
          }));
          const contents = response.Contents ?? [];
          for (const entry of contents) {
            const fileId = ownedFileId(prefix, entry.Key);
            // Foreign or malformed keys are ignored, never deleted.
            if (!fileId) continue;
            const lastModified = entry.LastModified instanceof Date ? entry.LastModified : null;
            found.push({ fileId, lastModified });
            if (found.length >= MAX_LIST_KEYS) return found;
          }
          if (!response.IsTruncated || !response.NextContinuationToken) return found;
          token = response.NextContinuationToken;
        }
        return found;
      } catch {
        throw new AttachmentStorageError("UNAVAILABLE");
      }
    },
  };
}
