import { inflateRawSync } from "node:zlib";
import sharp from "sharp";
import { MAX_ATTACHMENT_BYTES } from "./storage";

export const MAX_UPLOAD_FILES = 5;
export const MAX_UPLOAD_BATCH_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_ZIP_ENTRIES = 2048;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_MARKER_BYTES = 1024 * 1024;

export class AttachmentUploadError extends Error {
  readonly code = "INVALID_UPLOAD";
  constructor() {
    super("Invalid attachment upload");
    this.name = "AttachmentUploadError";
  }
}

function reject(): never { throw new AttachmentUploadError(); }

const formats: Record<string, { mime: string; kind: string }> = {
  jpg: { mime: "image/jpeg", kind: "jpeg" },
  jpeg: { mime: "image/jpeg", kind: "jpeg" },
  png: { mime: "image/png", kind: "png" },
  webp: { mime: "image/webp", kind: "webp" },
  pdf: { mime: "application/pdf", kind: "pdf" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "docx" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "xlsx" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "pptx" },
};

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function entryName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some(byte => byte > 127)) reject();
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!name || name.length > 512 || /[\p{Cc}\p{Cf}\\:%]/u.test(name) || name.startsWith("/")) reject();
  const parts = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) reject();
  if (/(?:vbaproject|vbadata|activex|embeddings)/i.test(name) || /\.(?:bin|exe|dll|js|vbs)$/i.test(name)) reject();
  return name;
}

function extraFields(bytes: Buffer): void {
  for (let cursor = 0; cursor < bytes.length;) {
    if (cursor + 4 > bytes.length) reject();
    const id = bytes.readUInt16LE(cursor);
    const size = bytes.readUInt16LE(cursor + 2);
    cursor += 4 + size;
    // Reject ZIP64 and alternate Unicode name/comment interpretations.
    if (cursor > bytes.length || [0x0001, 0x7075, 0x6375].includes(id)) reject();
  }
}

/** Strict stored/deflate ZIP subset. Data descriptors, ZIP64 and encrypted entries are rejected. */
function officePackage(bytes: Buffer, kind: string): void {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) reject();
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (!count || count > MAX_ZIP_ENTRIES || bytes.readUInt16LE(eocd + 8) !== count
    || centralOffset + centralSize !== eocd || !centralOffset) reject();
  const markerNames = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "xl/workbook.xml", "ppt/presentation.xml"]);
  const markers = new Map<string, string>();
  const names = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  let cursor = centralOffset;
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) reject();
    const needed = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const local = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (needed >= 45 || flags & ~0x0806 || (method !== 0 && method !== 8) || (method === 0 && flags & 6) || disk
      || [compressed, size, local].includes(0xffffffff) || end > eocd || !nameLength) reject();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = entryName(nameBytes, Boolean(flags & 0x0800));
    extraFields(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    const canonical = name.normalize("NFC").toLowerCase();
    if (names.has(canonical) || ((mode & 0xf000) && ![0x4000, 0x8000].includes(mode & 0xf000))
      || ((mode & 0xf000) === 0x4000 && !name.endsWith("/"))) reject();
    names.add(canonical);
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES || (size && (!compressed || size > compressed * 100))) reject();
    if (local + 30 > centralOffset || bytes.readUInt32LE(local) !== 0x04034b50) reject();
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressed;
    if (bytes.readUInt16LE(local + 4) !== needed || bytes.readUInt16LE(local + 6) !== flags
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt32LE(local + 14) !== crc
      || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size
      || localNameLength !== nameLength || dataEnd > centralOffset
      || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) reject();
    if (name.endsWith("/") && (size || compressed)) reject();
    extraFields(bytes.subarray(local + 30 + localNameLength, dataStart));
    ranges.push({ start: local, end: dataEnd });
    const source = bytes.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (method === 0) content = source;
    else {
      const inflated = inflateRawSync(source, { maxOutputLength: Math.max(1, size), info: true }) as unknown as {
        buffer: Buffer; engine: { bytesWritten: number };
      };
      if (inflated.engine.bytesWritten !== source.length) reject();
      content = inflated.buffer;
    }
    if (content.length !== size || crc32(content) !== crc) reject();
    if (markerNames.has(name)) {
      if (size > MAX_MARKER_BYTES) reject();
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (/<!DOCTYPE|<!ENTITY|macroEnabled|vbaProject|activeX/i.test(xml)) reject();
      markers.set(name, xml);
    }
    cursor = end;
  }
  if (cursor !== eocd) reject();
  ranges.sort((a, b) => a.start - b.start);
  let next = 0;
  for (const range of ranges) { if (range.start !== next) reject(); next = range.end; }
  if (next !== centralOffset) reject();
  const main = kind === "docx" ? "word/document.xml" : kind === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml";
  const types = markers.get("[Content_Types].xml");
  const relations = markers.get("_rels/.rels");
  const document = markers.get(main);
  const mainKind = kind === "docx" ? "wordprocessingml.document" : kind === "xlsx" ? "spreadsheetml.sheet" : "presentationml.presentation";
  const namespace = kind === "docx" ? "wordprocessingml" : kind === "xlsx" ? "spreadsheetml" : "presentationml";
  const root = kind === "docx" ? "document" : kind === "xlsx" ? "workbook" : "presentation";
  if (!types || !relations || !document || !types.includes(`PartName="/${main}"`)
    || !types.includes(`ContentType="application/vnd.openxmlformats-officedocument.${mainKind}.main+xml"`)
    || !types.includes("http://schemas.openxmlformats.org/package/2006/content-types")
    || !relations.includes("http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument")
    || !relations.includes(`Target="${main}"`)
    || !document.includes(`http://schemas.openxmlformats.org/${namespace}/2006/main`)
    || !new RegExp(`<(?:(?:[A-Za-z_][A-Za-z0-9_.-]*):)?${root}(?:\\s|/?>)`).test(document)) reject();
}

export type AttachmentDescriptor = {
  name: string;
  mime: string;
  size: number;
  kind: string;
};

/**
 * Declared metadata check shared by presign and byte validation. It rejects an
 * unknown extension, a mismatched MIME or an out-of-range size before any bytes
 * are read; it never decides that the content itself is valid.
 */
export function validateAttachmentDescriptor(name: unknown, mime: unknown, size: unknown): AttachmentDescriptor {
  if (typeof name !== "string" || !name || name.length > 200
    || /[\p{Cc}\p{Cf}/\\]/u.test(name) || name !== name.trim()) reject();
  if (typeof mime !== "string" || !mime
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) reject();
  if (name.lastIndexOf(".") < 1) reject();
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  const format = Object.hasOwn(formats, extension) ? formats[extension] : undefined;
  if (!format || mime !== format.mime) reject();
  return { name, mime: format.mime, size, kind: format.kind };
}

/** Format/signature validation only; does not provide malware scanning or document sanitization. */
export async function validateAttachmentUpload(file: File): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
  try {
    if (!(file instanceof File)) reject();
    const descriptor = validateAttachmentDescriptor(file.name, file.type, file.size);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== descriptor.size || bytes.length > MAX_ATTACHMENT_BYTES) reject();
    if (["jpeg", "png", "webp"].includes(descriptor.kind)) {
      const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_PIXELS, animated: true });
      const metadata = await image.metadata();
      if (metadata.format !== descriptor.kind || !metadata.width || !metadata.height
        || metadata.width * metadata.height * (metadata.pages ?? 1) > MAX_PIXELS) reject();
      // Force decoding; metadata parsing alone accepts truncated image payloads.
      await image.raw().toBuffer();
    } else if (descriptor.kind === "pdf") {
      if (!/^%PDF-1\.[0-7][\r\n]/.test(bytes.subarray(0, 10).toString("latin1"))
        || !/%%EOF[\t\r\n ]*$/.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1"))) reject();
    } else {
      officePackage(bytes, descriptor.kind);
    }
    return { name: descriptor.name, mime: descriptor.mime, bytes };
  } catch {
    throw new AttachmentUploadError();
  }
}
