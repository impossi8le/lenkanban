import { MAX_ATTACHMENT_BYTES } from "./storage";
import { MAX_UPLOAD_BATCH_BYTES, MAX_UPLOAD_FILES } from "./upload-validation";

/** Multipart framing overhead above the raw payload sum. */
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BATCH_BYTES + 1024 * 1024;
export const UPLOAD_BODY_DEADLINE_MS = 120_000;
/** JSON control bodies are a few hundred bytes; anything larger is abuse. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;
export const JSON_BODY_DEADLINE_MS = 10_000;

export class AttachmentBodyError extends Error {
  constructor(readonly code: "TOO_LARGE" | "DEADLINE" | "MALFORMED") {
    super(code === "TOO_LARGE"
      ? "Attachment upload body too large"
      : code === "DEADLINE" ? "Attachment upload deadline exceeded" : "Malformed attachment upload");
    this.name = "AttachmentBodyError";
  }
}

/**
 * Reads the request body with an explicit byte limit and deadline. The limit is
 * enforced while streaming, so a declared Content-Length is never trusted and a
 * stalled client cannot hold the handler open indefinitely.
 */
export async function readBoundedBody(
  request: Request,
  limit: number = MAX_UPLOAD_BODY_BYTES,
  deadlineMs: number = UPLOAD_BODY_DEADLINE_MS,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > limit)) {
    throw new AttachmentBodyError("TOO_LARGE");
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Cancelling resolves a pending read with `done`; the flag below makes
      // sure a truncated body can never be mistaken for a complete one.
      timedOut = true;
      void reader.cancel().catch(() => undefined);
      reject(new AttachmentBodyError("DEADLINE"));
    }, deadlineMs);
  });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const step = await Promise.race([reader.read(), deadline]);
      if (timedOut) throw new AttachmentBodyError("DEADLINE");
      if (step.done) break;
      const chunk = step.value;
      if (!(chunk instanceof Uint8Array)) throw new AttachmentBodyError("MALFORMED");
      total += chunk.byteLength;
      if (total > limit) throw new AttachmentBodyError("TOO_LARGE");
      chunks.push(chunk);
    }
    complete = true;
    const bytes = Buffer.alloc(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!complete) {
      try { await reader.cancel(); } catch { /* Cleanup cannot replace the safe failure. */ }
    }
  }
}

/**
 * Reads a small JSON control body with the same streaming limit and deadline as
 * file bodies. Callers must authenticate first: an unauthenticated request never
 * reaches this function.
 */
export async function readBoundedJsonBody(
  request: Request,
  limit: number = MAX_JSON_BODY_BYTES,
  deadlineMs: number = JSON_BODY_DEADLINE_MS,
): Promise<unknown> {
  const bytes = await readBoundedBody(request, limit, deadlineMs);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AttachmentBodyError("MALFORMED");
  }
}

export function requireMultipart(request: Request): string {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(contentType) || !/boundary=/i.test(contentType)) {
    throw new AttachmentBodyError("MALFORMED");
  }
  return contentType;
}

export type ParsedUploadForm = {
  taskId: string;
  files: File[];
};

/**
 * Parses only the two accepted fields. Extra fields are ignored, and any client
 * supplied projectId, storage key, URL or bucket is never read.
 */
export async function parseUploadForm(bytes: Uint8Array, contentType: string): Promise<ParsedUploadForm> {
  let form: FormData;
  try {
    form = await new Response(bytes as unknown as BodyInit, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new AttachmentBodyError("MALFORMED");
  }
  const taskId = form.get("taskId");
  const files = form.getAll("files");
  if (typeof taskId !== "string" || !taskId || files.length === 0
    || files.length > MAX_UPLOAD_FILES || files.some(entry => typeof entry === "string")) {
    throw new AttachmentBodyError("MALFORMED");
  }
  return { taskId, files: files as File[] };
}

function safeFilename(name: string): { fallback: string; encoded: string } {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base.replace(/[\p{Cc}\p{Cf}"\\]/gu, "").trim().slice(0, 200);
  const safe = cleaned || "attachment";
  const fallback = safe.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";
  return { fallback, encoded: encodeURIComponent(safe) };
}

/**
 * Download responses are always opaque octet-stream attachments: uploaded HTML
 * or SVG can never be rendered inline from the application origin.
 */
export function attachmentDownloadHeaders(name: string, size: number): Headers {
  const { fallback, encoded } = safeFilename(name);
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
}

export function isAllowedAttachmentSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 1 && size <= MAX_ATTACHMENT_BYTES;
}
