import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAttachmentStore } from "./local-storage";
import { createAttachmentStore, readAttachmentRuntimeConfig } from "./runtime";
import { MAX_ATTACHMENT_BYTES } from "./storage";
import { reconcileTaskOrphans } from "./orphans";
import { attachmentFileUrl } from "./task-port";

let temporary: string;
let directory: string;
const fileId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
function namespace(taskId = "task") {
  return join(directory, "attachments", "v1", createHash("sha256").update(taskId).digest("hex"));
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(join(tmpdir(), "taskboard-attachments-test-"));
  directory = join(temporary, "private");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("private local attachment storage", () => {
  it("initializes the configured directory through the runtime factory without S3", async () => {
    const factory = vi.fn();
    const store = createAttachmentStore(readAttachmentRuntimeConfig({ ATTACHMENT_LOCAL_DIR: directory }), factory);
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    const input = Uint8Array.from([1, 2, 3]);
    const pending = store.put("task", input);
    input[0] = 99;
    const saved = await pending;
    expect(saved).toEqual({ fileId: expect.stringMatching(/^[0-9a-f-]{36}$/), size: 3 });
    expect(await fs.readFile(join(namespace(), saved.fileId))).toEqual(Buffer.from([1, 2, 3]));
    const secondStore = createLocalAttachmentStore(directory);
    expect(await secondStore.get("task", saved.fileId)).toEqual(Buffer.from([1, 2, 3]));
    expect(await fs.readdir(namespace())).toEqual([saved.fileId]);
    if (process.platform !== "win32") {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(join(namespace(), saved.fileId))).mode & 0o777).toBe(0o600);
    }
  });

  it("isolates tasks, creates distinct IDs and makes deletion idempotent", async () => {
    const store = createLocalAttachmentStore(directory);
    const first = await store.put("task", Buffer.from("private"));
    const second = await store.put("task", Buffer.from("second"));
    expect(first.fileId).not.toBe(second.fileId);
    expect(await store.get("other", first.fileId)).toBeNull();
    await store.deleteOwned("other", first.fileId);
    expect(await store.get("task", first.fileId)).toEqual(Buffer.from("private"));
    await store.deleteOwned("task", first.fileId);
    await store.deleteOwned("task", first.fileId);
    expect(await store.get("task", first.fileId)).toBeNull();
    expect(await store.get("task", second.fileId)).toEqual(Buffer.from("second"));
  });

  it.each(["", "../task", "task/child", "task\\child", "task%2Fchild", "task\n", "x".repeat(129)])
  ("rejects invalid task identity %j in every operation", async taskId => {
    const store = createLocalAttachmentStore(directory);
    for (const action of [() => store.put(taskId, Buffer.from("x")), () => store.get(taskId, fileId),
      () => store.deleteOwned(taskId, fileId), () => store.list(taskId)]) {
      await expect(action()).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["", "../file", "..\\file", `${fileId}/child`, `${fileId}%2Fchild`, fileId.toUpperCase(), `${fileId}\n`])
  ("rejects invalid file identity %j", async requested => {
    const store = createLocalAttachmentStore(directory);
    await expect(store.get("task", requested)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.deleteOwned("task", requested)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([0, MAX_ATTACHMENT_BYTES])("round-trips bounded size %s", async size => {
    const store = createLocalAttachmentStore(directory);
    const saved = await store.put("task", new Uint8Array(size));
    expect((await store.get("task", saved.fileId))?.byteLength).toBe(size);
  });

  it("rejects oversize writes before creating task files and bounds reads", async () => {
    const store = createLocalAttachmentStore(directory);
    await expect(store.put("task", new Uint8Array(MAX_ATTACHMENT_BYTES + 1)))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await fs.readdir(directory)).toEqual([]);
    const saved = await store.put("task", Buffer.from("x"));
    await fs.truncate(join(namespace(), saved.fileId), MAX_ATTACHMENT_BYTES + 1);
    await expect(store.get("task", saved.fileId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("publishes only after rename and removes temporary data on a failed rename", async () => {
    const store = createLocalAttachmentStore(directory);
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      expect(await fs.readFile(source)).toEqual(Buffer.from("complete"));
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await store.list("task")).toEqual([]);
      throw new Error("SYNTHETIC_SECRET path credentials");
    });
    const error = await store.put("task", Buffer.from("complete")).catch(failure => failure);
    expect(error).toMatchObject({ code: "UNAVAILABLE", message: "Attachment storage unavailable" });
    expect(String(error)).not.toContain("SYNTHETIC_SECRET");
    expect(error).not.toHaveProperty("cause");
    expect(await fs.readdir(namespace())).toEqual([]);
  });

  it("removes a partial temporary file after a write failure", async () => {
    const store = createLocalAttachmentStore(directory);
    const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      vi.spyOn(handle, "writeFile").mockImplementation(async () => {
        await handle.write(Buffer.from("partial"));
        throw new Error("SYNTHETIC_SECRET");
      });
      return handle;
    });
    await expect(store.put("task", Buffer.from("complete"))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await fs.readdir(namespace())).toEqual([]);
  });

  it("fails safely for an unusable root and filesystem failures", async () => {
    await fs.writeFile(directory, "SYNTHETIC_SECRET");
    expect(() => createLocalAttachmentStore(directory)).toThrow("Attachment storage unavailable");
    await fs.unlink(directory);
    const store = createLocalAttachmentStore(directory);
    vi.spyOn(fs, "lstat").mockRejectedValue(new Error("SYNTHETIC_SECRET"));
    for (const action of [() => store.put("task", Buffer.from("x")), () => store.get("task", fileId),
      () => store.deleteOwned("task", fileId), () => store.list("task")]) {
      const error = await action().catch(failure => failure);
      expect(error).toMatchObject({ code: "UNAVAILABLE", message: "Attachment storage unavailable" });
      expect(JSON.stringify(error)).not.toContain("SYNTHETIC_SECRET");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("supports DB-aware orphan cleanup while ignoring temporary and foreign entries", async () => {
    const store = createLocalAttachmentStore(directory);
    expect(await store.list("task")).toEqual([]);
    const live = await store.put("task", Buffer.from("live"));
    const orphan = await store.put("task", Buffer.from("orphan"));
    const fresh = await store.put("task", Buffer.from("fresh"));
    const now = new Date();
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    await fs.utimes(join(namespace(), orphan.fileId), old, old);
    await fs.writeFile(join(namespace(), ".interrupted.tmp"), "partial");
    await fs.writeFile(join(namespace(), "foreign"), "foreign");
    const listed = await store.list("task");
    expect(listed.map(entry => entry.fileId).sort()).toEqual([live.fileId, orphan.fileId, fresh.fileId].sort());
    expect(listed.find(entry => entry.fileId === orphan.fileId)?.lastModified?.getTime()).toBeCloseTo(old.getTime(), -1);
    const result = await reconcileTaskOrphans(store, { taskId: "task", now, attachments: [
      { url: attachmentFileUrl("task", live.fileId), name: "live", size: 4, mime: "text/plain" },
    ] });
    expect(result).toEqual({ deleted: [orphan.fileId], kept: 2, failed: [] });
    expect(await store.get("task", orphan.fileId)).toBeNull();
    expect(await fs.readFile(join(namespace(), ".interrupted.tmp"), "utf8")).toBe("partial");
  });

  it("rejects symlinked task directories", async () => {
    const store = createLocalAttachmentStore(directory);
    const outside = join(temporary, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, join(directory, "attachments"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.put("task", Buffer.from("private"))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(store.get("task", fileId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
