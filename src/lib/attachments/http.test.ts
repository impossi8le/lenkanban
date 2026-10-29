import { describe, expect, it } from "vitest";
import {
  AttachmentBodyError, MAX_UPLOAD_BODY_BYTES, attachmentDownloadHeaders, isAllowedAttachmentSize,
  parseUploadForm, readBoundedBody, requireMultipart,
} from "./http";
import { MAX_ATTACHMENT_BYTES } from "./storage";
import { MAX_UPLOAD_FILES } from "./upload-validation";

function streamed(chunks: Uint8Array[], hang = false, headers: Record<string, string> = {}): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!hang) controller.close();
    },
  });
  return new Request("https://app.test/api/uploads/direct", {
    method: "POST", headers, body: stream, duplex: "half",
  } as RequestInit);
}

function multipart(entries: { name: string; value: string | File }[]): { form: FormData; request: Request } {
  const form = new FormData();
  for (const entry of entries) form.append(entry.name, entry.value);
  return {
    form,
    request: new Request("https://app.test/api/uploads/direct", { method: "POST", body: form }),
  };
}

describe("bounded upload body", () => {
  it("reads the exact bytes under the limit", async () => {
    const bytes = await readBoundedBody(streamed([Uint8Array.from([1, 2]), Uint8Array.from([3])]));
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("returns an empty buffer when there is no body", async () => {
    const request = new Request("https://app.test/api/uploads/direct", { method: "POST" });
    expect((await readBoundedBody(request)).byteLength).toBe(0);
  });

  it("rejects a declared length above the limit before reading", async () => {
    const request = streamed([Uint8Array.from([1])], false, { "content-length": String(MAX_UPLOAD_BODY_BYTES + 1) });
    await expect(readBoundedBody(request)).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("rejects an invalid declared length", async () => {
    const request = streamed([Uint8Array.from([1])], false, { "content-length": "12ab" });
    await expect(readBoundedBody(request)).rejects.toBeInstanceOf(AttachmentBodyError);
  });

  it("stops an actual stream that exceeds the limit", async () => {
    const request = streamed([new Uint8Array(1), new Uint8Array(64)]);
    await expect(readBoundedBody(request, 32)).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("aborts a stalled stream at the deadline", async () => {
    // A stream whose pull never settles: only the deadline can end the read.
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const request = { headers: new Headers(), body: stalled } as unknown as Request;
    await expect(readBoundedBody(request, 1024, 20)).rejects.toMatchObject({ code: "DEADLINE" });
  });

  it("accepts only multipart content types", () => {
    expect(requireMultipart(new Request("https://app.test", {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=abc" },
    }))).toContain("boundary=abc");
    expect(() => requireMultipart(new Request("https://app.test", {
      method: "POST", headers: { "content-type": "application/json" },
    }))).toThrow(AttachmentBodyError);
    expect(() => requireMultipart(new Request("https://app.test", {
      method: "POST", headers: { "content-type": "multipart/form-data" },
    }))).toThrow(AttachmentBodyError);
  });
});

describe("multipart form parsing", () => {
  it("accepts taskId and up to five files", async () => {
    const { request } = multipart([
      { name: "taskId", value: "task_1" },
      { name: "files", value: new File([Uint8Array.from([1])], "a.pdf", { type: "application/pdf" }) },
    ]);
    const contentType = request.headers.get("content-type") ?? "";
    const parsed = await parseUploadForm(await readBoundedBody(request), contentType);
    expect(parsed.taskId).toBe("task_1");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].name).toBe("a.pdf");
  });

  it.each([
    ["missing taskId", [{ name: "files", value: new File([Uint8Array.from([1])], "a.pdf") }]],
    ["no files", [{ name: "taskId", value: "task" }]],
    ["string field named files", [{ name: "taskId", value: "task" }, { name: "files", value: "not-a-file" }]],
  ])("rejects %s", async (_label, entries) => {
    const { request } = multipart(entries as { name: string; value: string | File }[]);
    const contentType = request.headers.get("content-type") ?? "";
    await expect(parseUploadForm(await readBoundedBody(request), contentType))
      .rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("rejects more files than the engineering limit", async () => {
    const entries: { name: string; value: string | File }[] = [{ name: "taskId", value: "task" }];
    for (let index = 0; index <= MAX_UPLOAD_FILES; index++) {
      entries.push({ name: "files", value: new File([Uint8Array.from([1])], `a${index}.pdf`) });
    }
    const { request } = multipart(entries);
    const contentType = request.headers.get("content-type") ?? "";
    await expect(parseUploadForm(await readBoundedBody(request), contentType))
      .rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("rejects a body that is not valid multipart", async () => {
    await expect(parseUploadForm(Uint8Array.from([1, 2, 3]), "multipart/form-data; boundary=abc"))
      .rejects.toBeInstanceOf(AttachmentBodyError);
  });
});

describe("download response headers", () => {
  it("uses opaque octet-stream attachment disposition with a safe unicode filename", () => {
    const headers = attachmentDownloadHeaders("отчёт \"final\".pdf", 12);
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(headers.get("Content-Length")).toBe("12");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    const disposition = headers.get("Content-Disposition") ?? "";
    expect(disposition.startsWith("attachment;")).toBe(true);
    expect(disposition).toContain("filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20final.pdf");
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  it("strips paths and control characters from the fallback name", () => {
    const disposition = attachmentDownloadHeaders("../../etc/passwd\u0000\u0007", 1).get("Content-Disposition") ?? "";
    expect(disposition).toContain('filename="passwd"');
    expect(disposition).not.toContain("..");
  });

  it("falls back to a generic name when nothing safe remains", () => {
    expect(attachmentDownloadHeaders("\u0000", 1).get("Content-Disposition")).toContain('filename="attachment"');
  });
});

describe("size bounds", () => {
  it("keeps the per-file range 1..25 MiB", () => {
    expect(isAllowedAttachmentSize(1)).toBe(true);
    expect(isAllowedAttachmentSize(MAX_ATTACHMENT_BYTES)).toBe(true);
    expect(isAllowedAttachmentSize(0)).toBe(false);
    expect(isAllowedAttachmentSize(MAX_ATTACHMENT_BYTES + 1)).toBe(false);
    expect(isAllowedAttachmentSize(1.5)).toBe(false);
  });
});
