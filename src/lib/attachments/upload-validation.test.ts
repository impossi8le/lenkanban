import { deflateRawSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  AttachmentUploadError, MAX_UPLOAD_BATCH_BYTES, MAX_UPLOAD_FILES, validateAttachmentUpload,
} from "./upload-validation";
import { MAX_ATTACHMENT_BYTES } from "./storage";

const office = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", main: "word/document.xml" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", main: "xl/workbook.xml" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", main: "ppt/presentation.xml" },
};
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const file = (data: Uint8Array, name = "report.pdf", type = "application/pdf") => new File([data as BlobPart], name, { type });
function crc32(bytes: Buffer) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}
type Entry = { name: string; data: Buffer; method?: number; flags?: number; mode?: number; extra?: Buffer; suffix?: Buffer };
function zip(entries: Entry[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const method = entry.method ?? 8;
    const payload = Buffer.concat([method === 0 ? entry.data : deflateRawSync(entry.data), entry.suffix ?? Buffer.alloc(0)]);
    const extra = entry.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.data), 14); local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    local.copy(central, 8, 6, 26); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(((entry.mode ?? 0x8000) * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, payload); centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + payload.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}
function packageEntries(kind: keyof typeof office): Entry[] {
  const { main } = office[kind];
  const mainKind = kind === "docx" ? "wordprocessingml.document" : kind === "xlsx" ? "spreadsheetml.sheet" : "presentationml.presentation";
  const namespace = kind === "docx" ? "wordprocessingml" : kind === "xlsx" ? "spreadsheetml" : "presentationml";
  const root = kind === "docx" ? "document" : kind === "xlsx" ? "workbook" : "presentation";
  return [
    { name: "[Content_Types].xml", data: Buffer.from(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${mainKind}.main+xml" /></Types>`) },
    { name: "_rels/.rels", data: Buffer.from(`<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}" /></Relationships>`) },
    { name: main, data: Buffer.from(`<m:${root} xmlns:m="http://schemas.openxmlformats.org/${namespace}/2006/main" />`) },
  ];
}
async function invalid(value: File) {
  const error = await validateAttachmentUpload(value).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AttachmentUploadError);
  expect(error).toMatchObject({ code: "INVALID_UPLOAD", message: "Invalid attachment upload" });
  expect(String(error)).not.toContain("SYNTHETIC_SECRET");
  expect(error).not.toHaveProperty("cause");
}

describe("bounded attachment content validation", () => {
  it("exposes engineering batch limits", () => {
    expect(MAX_UPLOAD_FILES).toBe(5); expect(MAX_UPLOAD_BATCH_BYTES).toBe(50 * 1024 * 1024);
  });
  it("accepts a PDF signature/EOF and preserves original bytes", async () => {
    const result = await validateAttachmentUpload(file(pdf));
    expect(result).toEqual({ name: "report.pdf", mime: "application/pdf", bytes: pdf });
  });
  it.each(["png", "jpeg", "webp"] as const)("fully decodes an actual tiny %s image", async (format) => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).toFormat(format).toBuffer();
    const result = await validateAttachmentUpload(file(bytes, `image.${format}`, `image/${format}`));
    expect(result.bytes).toEqual(bytes);
    expect(result.mime).toBe(`image/${format}`);
  });
  it("rejects a truncated image after a valid header", async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
    await invalid(file(bytes.subarray(0, bytes.length - 20), "image.png", "image/png"));
  });
  it("rejects a claimed image format that differs from server detection", async () => {
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    await invalid(file(bytes, "image.jpg", "image/jpeg"));
  });
  it.each(["../SYNTHETIC_SECRET.pdf", "dir\\SYNTHETIC_SECRET.pdf", "SYNTHETIC_SECRET\u0001.pdf", "SYNTHETIC_SECRET\u0085.pdf", "SYNTHETIC_SECRET\u202e.pdf", " report.pdf", `${"x".repeat(197)}.pdf`])
  ("rejects unsafe filename %j", async name => { await invalid(file(pdf, name)); });
  it.each(["application/octet-stream", "text/html", "image/png", ""])("rejects mismatched MIME %s", async mime => {
    await invalid(file(pdf, "report.pdf", mime));
  });
  it.each(["report.html", "report.doc", "report.exe", "toString", "report.pdf.exe", "pdf"])("rejects unsupported extension %s", async name => {
    await invalid(file(pdf, name));
  });
  it.each([Buffer.alloc(0), Buffer.from("SYNTHETIC_SECRET"), Buffer.from("%PDF-1.7\ntruncated")])("rejects missing signature/end marker %#", async bytes => {
    await invalid(file(bytes));
  });
  it("rejects oversize files before reading bytes", async () => {
    const value = file(pdf);
    Object.defineProperty(value, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
    Object.defineProperty(value, "arrayBuffer", { value: () => { throw new Error("SYNTHETIC_SECRET must not read"); } });
    await invalid(value);
  });
  it("rejects byte length that disagrees with declared size", async () => {
    const value = file(pdf); Object.defineProperty(value, "size", { value: pdf.length + 1 }); await invalid(value);
  });
  it.each(["docx", "xlsx", "pptx"] as const)("accepts strict bounded %s package markers", async kind => {
    const bytes = zip(packageEntries(kind));
    const result = await validateAttachmentUpload(file(bytes, `report.${kind}`, office[kind].mime));
    expect(result.bytes).toEqual(bytes);
  });
  it("accepts stored ZIP entries as well as deflate", async () => {
    const bytes = zip(packageEntries("docx").map(entry => ({ ...entry, method: 0 })));
    expect((await validateAttachmentUpload(file(bytes, "report.docx", office.docx.mime))).bytes).toEqual(bytes);
  });
  it.each(["../word/evil.xml", "/evil.xml", "word\\evil.xml", "word/%2e%2e/evil.xml", "word/./evil.xml", "word//evil.xml", "word/vbaProject.bin", "word/activeX/control.xml"])
  ("rejects ZIP path or macro entry %s", async name => {
    await invalid(file(zip([...packageEntries("docx"), { name, data: Buffer.from("SYNTHETIC_SECRET") }]), "report.docx", office.docx.mime));
  });
  it.each([1, 8, 0x40])("rejects unsupported ZIP flags %s", async flags => {
    const entries = packageEntries("docx"); entries[0].flags = flags;
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it("rejects duplicate names including case aliases", async () => {
    const entries = packageEntries("docx");
    entries.push({ ...entries[2], name: entries[2].name.toUpperCase() });
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it("rejects Unicode normalization path aliases", async () => {
    const entries = packageEntries("docx");
    entries.push({ name: "word/é.xml", data: Buffer.from("a") }, { name: "word/e\u0301.xml", data: Buffer.from("b") });
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it("checks decompressed CRC even if local and central headers agree", async () => {
    const bytes = zip(packageEntries("docx"));
    const central = bytes.readUInt32LE(bytes.length - 6);
    bytes.writeUInt32LE(1, 14); bytes.writeUInt32LE(1, central + 16);
    await invalid(file(bytes, "report.docx", office.docx.mime));
  });
  it("rejects trailing data after a deflate stream even with consistent headers", async () => {
    const entries = packageEntries("docx"); entries[0].suffix = Buffer.from("SYNTHETIC_SECRET");
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it.each([0x0001, 0x7075, 0x6375])("rejects alternate/ZIP64 extra field %s", async id => {
    const entries = packageEntries("docx"); const extra = Buffer.alloc(4); extra.writeUInt16LE(id, 0); entries[0].extra = extra;
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it("rejects entry counts above the fixed bound", async () => {
    const entries = packageEntries("docx");
    for (let i = entries.length; i < 2049; i++) entries.push({ name: `word/x${i}.xml`, data: Buffer.from("x") });
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it("rejects symlink modes", async () => {
    const entries = packageEntries("docx"); entries[2].mode = 0xa000;
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it("rejects expansion bombs using declared size and compression ratio", async () => {
    const entries = packageEntries("docx"); entries.push({ name: "word/large.xml", data: Buffer.alloc(1024 * 1024, 65) });
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it.each(["content-type", "document-root", "entities", "macro-type"])("rejects invalid Office marker XML %s", async scenario => {
    const entries = packageEntries("docx");
    if (scenario === "content-type") entries[0].data = Buffer.from(entries[0].data.toString().replace(".document.main+xml", ".wrong.main+xml"));
    if (scenario === "document-root") entries[2].data = Buffer.from("SYNTHETIC_SECRET");
    if (scenario === "entities") entries[2].data = Buffer.concat([Buffer.from('<!DOCTYPE x [<!ENTITY a "SYNTHETIC_SECRET">]>'), entries[2].data]);
    if (scenario === "macro-type") entries[0].data = Buffer.concat([entries[0].data, Buffer.from("macroEnabled")]);
    await invalid(file(zip(entries), "report.docx", office.docx.mime));
  });
  it.each(["local-name", "crc", "zip64", "truncated", "trailing", "missing-main", "wrong-kind"])
  ("rejects malformed/inconsistent package %s", async scenario => {
    let entries = packageEntries(scenario === "wrong-kind" ? "xlsx" : "docx");
    if (scenario === "missing-main") entries = entries.slice(0, 2);
    let bytes = zip(entries);
    if (scenario === "local-name") bytes[30] ^= 1;
    if (scenario === "crc") bytes.writeUInt32LE(1, 14);
    if (scenario === "zip64") bytes.writeUInt16LE(45, 4);
    if (scenario === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
    if (scenario === "trailing") bytes = Buffer.concat([bytes, Buffer.from("junk")]);
    await invalid(file(bytes, "report.docx", office.docx.mime));
  });
});
