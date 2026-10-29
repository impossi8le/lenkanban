import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { AttachmentStorageError, createPrivateAttachmentStore, MAX_ATTACHMENT_BYTES } from "./storage";

const fileId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
function fixture() {
  const send = vi.fn();
  const store = createPrivateAttachmentStore({ send } as unknown as Pick<S3Client, "send">, "test-private");
  return { send, store };
}

describe("private task attachment storage", () => {
  it.each(["", "../bucket", "bucket/other", "test-private\n", "UPPERCASE", "a..b"])
  ("rejects invalid bucket configuration %j before any I/O", (bucket) => {
    const send = vi.fn();
    expect(() => createPrivateAttachmentStore({ send } as unknown as Pick<S3Client, "send">, bucket))
      .toThrow(AttachmentStorageError);
    expect(send).not.toHaveBeenCalled();
  });

  it("creates fresh IDs, task-bound keys, stable bytes and conditional private writes", async () => {
    const { send, store } = fixture();
    send.mockResolvedValue({});
    const input = Uint8Array.from([1, 2]);
    const pending = store.put("task_A", input);
    input[0] = 9;
    const saved = await pending;
    const second = await store.put("task_A", input);
    expect(saved).toEqual({ fileId: expect.stringMatching(/^[0-9a-f-]{36}$/), size: 2 });
    expect(second.fileId).not.toBe(saved.fileId);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: "test-private",
      Key: `attachments/v1/${createHash("sha256").update("task_A").digest("hex")}/${saved.fileId}`,
      Body: Buffer.from([1, 2]), ContentLength: 2, ContentType: "application/octet-stream",
      ContentDisposition: "attachment", CacheControl: "private, no-store", IfNoneMatch: "*",
    });
    expect(Object.keys(saved).sort()).toEqual(["fileId", "size"]);
  });

  it.each([0, MAX_ATTACHMENT_BYTES])("accepts storage size boundary %s", async (size) => {
    const { send, store } = fixture();
    send.mockResolvedValue({});
    expect((await store.put("task", new Uint8Array(size))).size).toBe(size);
  });

  it("rejects oversize writes before calling storage", async () => {
    const { send, store } = fixture();
    await expect(store.put("task", new Uint8Array(MAX_ATTACHMENT_BYTES + 1)))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["", "../task", "task/child", "task%2Fchild", "task%252Fchild", "task\n", "任务", "x".repeat(129)])
  ("rejects noncanonical task identity %j in every operation", async (taskId) => {
    const { send, store } = fixture();
    await expect(store.put(taskId, new Uint8Array())).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.get(taskId, fileId)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.deleteOwned(taskId, fileId)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["", "../file", `${fileId}/other`, fileId.toUpperCase(), `${fileId}?token=secret`, `${fileId}\n`])
  ("rejects noncanonical object identity %j", async (id) => {
    const { send, store } = fixture();
    await expect(store.get("task", id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.deleteOwned("task", id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(send).not.toHaveBeenCalled();
  });

  it("never reads or deletes another task's namespace after a copied file ID", async () => {
    const { send, store } = fixture();
    send.mockImplementation(async (command) => {
      const hash = createHash("sha256").update("task_A").digest("hex");
      if (command instanceof GetObjectCommand && command.input.Key === `attachments/v1/${hash}/${fileId}`) {
        return { Body: Readable.from([Buffer.from("ok")]), ContentLength: 2 };
      }
      if (command instanceof GetObjectCommand) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      return {};
    });
    expect(await store.get("task_A", fileId)).toEqual(Buffer.from("ok"));
    expect(await store.get("task_B", fileId)).toBeNull();
    await store.deleteOwned("task_B", fileId);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[2][0].input.Key).not.toBe(send.mock.calls[0][0].input.Key);
  });

  it.each([undefined, -1, 0.5, NaN, MAX_ATTACHMENT_BYTES + 1])
  ("rejects invalid declared length %s and closes the stream", async (ContentLength) => {
    const { send, store } = fixture();
    const body = Readable.from([Buffer.from("x")]);
    send.mockResolvedValue({ Body: body, ContentLength });
    await expect(store.get("task", fileId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(body.destroyed).toBe(true);
  });

  it.each([
    { declared: 2, chunks: [Buffer.from("x")] },
    { declared: 1, chunks: [Buffer.from("xx")] },
    { declared: 1, chunks: ["x"] },
    { declared: MAX_ATTACHMENT_BYTES, chunks: [new Uint8Array(MAX_ATTACHMENT_BYTES), Buffer.from("x")] },
  ])("rejects truncated, lying or malformed streams ($declared)", async ({ declared, chunks }) => {
    const { send, store } = fixture();
    const body = Readable.from(chunks);
    send.mockResolvedValue({ Body: body, ContentLength: declared });
    await expect(store.get("task", fileId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(body.destroyed).toBe(true);
  });

  it("accepts an exact multi-chunk stream and an empty object", async () => {
    const { send, store } = fixture();
    send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from("a"), Buffer.from("bc")]), ContentLength: 3 });
    expect(await store.get("task", fileId)).toEqual(Buffer.from("abc"));
    send.mockResolvedValueOnce({ Body: Readable.from([]), ContentLength: 0 });
    expect(await store.get("task", fileId)).toEqual(Buffer.alloc(0));
  });

  it("copies reused chunk buffers before the next read", async () => {
    const { send, store } = fixture();
    const Body = {
      async *[Symbol.asyncIterator]() {
        const chunk = Buffer.from("a");
        yield chunk;
        chunk[0] = 98;
        yield chunk;
      },
    };
    send.mockResolvedValue({ Body, ContentLength: 2 });
    expect(await store.get("task", fileId)).toEqual(Buffer.from("ab"));
  });

  it.each([undefined, {}, Buffer.from("x")])("rejects a missing or non-stream body", async (Body) => {
    const { send, store } = fixture();
    send.mockResolvedValue({ Body, ContentLength: 1 });
    await expect(store.get("task", fileId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it.each([403, 404, 500])("does not mistake arbitrary status %s errors for missing objects", async (status) => {
    const { send, store } = fixture();
    send.mockRejectedValue({ name: "AccessDenied", $metadata: { httpStatusCode: status } });
    await expect(store.get("task", fileId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("drops synthetic secrets from SDK errors for all operations", async () => {
    const { send, store } = fixture();
    send.mockRejectedValue(new Error("SYNTHETIC_SECRET endpoint/body/key/filename"));
    for (const operation of [() => store.put("task", new Uint8Array()),
      () => store.get("task", fileId), () => store.deleteOwned("task", fileId)]) {
      const error = await operation().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AttachmentStorageError);
      expect(error).toMatchObject({ code: "UNAVAILABLE", message: "Attachment storage unavailable" });
      expect(String(error)).not.toContain("SYNTHETIC_SECRET");
      expect(JSON.stringify(error)).not.toContain("SYNTHETIC_SECRET");
      expect(error).not.toHaveProperty("cause");
    }
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("sanitizes mid-stream failures even if cleanup also fails", async () => {
    const { send, store } = fixture();
    const Body = {
      async *[Symbol.asyncIterator]() { yield Buffer.from("a"); throw new Error("SYNTHETIC_SECRET"); },
      destroy() { throw new Error("SYNTHETIC_CLEANUP_SECRET"); },
    };
    send.mockResolvedValue({ Body, ContentLength: 2 });
    await expect(store.get("task", fileId)).rejects.toMatchObject({ message: "Attachment storage unavailable" });
  });
});

describe("bounded task-scoped listing for reconciliation", () => {
  const prefix = `attachments/v1/${createHash("sha256").update("task_A").digest("hex")}/`;
  const modified = new Date("2026-10-20T00:00:00.000Z");

  it("lists only canonical keys inside this task namespace", async () => {
    const { send, store } = fixture();
    send.mockResolvedValue({ Contents: [
      { Key: `${prefix}${fileId}`, LastModified: modified },
      { Key: `${prefix}not-a-uuid`, LastModified: modified },
      { Key: `attachments/v1/${createHash("sha256").update("other").digest("hex")}/${fileId}`, LastModified: modified },
      { Key: prefix, LastModified: modified },
      { Key: 42 },
    ] });
    expect(await store.list("task_A")).toEqual([{ fileId, lastModified: modified }]);
    const command = send.mock.calls[0][0];
    expect(command.input).toEqual({ Bucket: "test-private", Prefix: prefix, MaxKeys: 1000 });
  });

  it("follows bounded pagination and stops at the page limit", async () => {
    const { send, store } = fixture();
    send.mockResolvedValue({ Contents: [{ Key: `${prefix}${fileId}` }], IsTruncated: true, NextContinuationToken: "next" });
    const listed = await store.list("task_A");
    expect(send).toHaveBeenCalledTimes(5);
    expect(listed).toHaveLength(5);
    expect(listed.every(entry => entry.fileId === fileId)).toBe(true);
    expect(send.mock.calls[1][0].input).toMatchObject({ ContinuationToken: "next" });
  });

  it("returns what was listed when the backend reports no further page", async () => {
    const { send, store } = fixture();
    send.mockResolvedValue({ Contents: [{ Key: `${prefix}${fileId}`, LastModified: modified }], IsTruncated: false });
    expect(await store.list("task_A")).toEqual([{ fileId, lastModified: modified }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["../task", "", "task A", "a".repeat(129)])("rejects an invalid task ID %j before I/O", async taskId => {
    const { send, store } = fixture();
    await expect(store.list(taskId)).rejects.toBeInstanceOf(AttachmentStorageError);
    expect(send).not.toHaveBeenCalled();
  });

  it("maps listing failures to a safe error", async () => {
    const { send, store } = fixture();
    send.mockRejectedValue(new Error("SYNTHETIC_SECRET bucket/key"));
    const error = await store.list("task_A").catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "UNAVAILABLE", message: "Attachment storage unavailable" });
    expect(String(error)).not.toContain("SYNTHETIC_SECRET");
    expect(error).not.toHaveProperty("cause");
  });
});
