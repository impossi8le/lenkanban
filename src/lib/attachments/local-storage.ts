import { randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AttachmentAlreadyExistsError, AttachmentStorageError, MAX_ATTACHMENT_BYTES, objectKey, taskPrefix,
  type ListableAttachmentStore, type OwnedObject,
} from "./storage";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Private server storage. The directory must never be served as public/static content. */
export function createLocalAttachmentStore(directory: string): ListableAttachmentStore {
  if (!directory || !isAbsolute(directory) || directory.includes("\0")) {
    throw new AttachmentStorageError("INVALID_INPUT");
  }
  const root = resolve(directory);
  try {
    // Initialize when the adapter starts, before accepting any storage operation.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  } catch {
    throw new AttachmentStorageError("UNAVAILABLE");
  }

  async function taskDirectory(taskId: string, create = false): Promise<string> {
    const segments = taskPrefix(taskId).split("/").filter(Boolean);
    let path = root;
    // Check each component before descending; never follow a task-directory symlink.
    for (const segment of segments) {
      path = join(path, segment);
      if (create) {
        try { await fs.mkdir(path, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const stat = await fs.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    return path;
  }

  return {
    async put(taskId, bytes) {
      const fileId = randomUUID();
      objectKey(taskId, fileId);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentStorageError("INVALID_INPUT");
      }
      const body = Buffer.from(bytes);
      let temporary: string | undefined;
      try {
        const path = await taskDirectory(taskId, true);
        const candidate = join(path, `.${fileId}.${randomUUID()}.tmp`);
        const handle = await fs.open(candidate, "wx", 0o600);
        temporary = candidate;
        try {
          await handle.writeFile(body);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Same-directory rename publishes only a complete, closed file.
        await fs.rename(candidate, join(path, fileId));
        temporary = undefined;
        return { fileId, size: body.length };
      } catch {
        throw new AttachmentStorageError("UNAVAILABLE");
      } finally {
        if (temporary) {
          try { await fs.unlink(temporary); } catch { /* Preserve the safe original failure. */ }
        }
      }
    },

    async putWithId(taskId, fileId, bytes) {
      objectKey(taskId, fileId);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentStorageError("INVALID_INPUT");
      }
      const body = Buffer.from(bytes);
      let temporary: string | undefined;
      try {
        const path = await taskDirectory(taskId, true);
        const candidate = join(path, `.${fileId}.${randomUUID()}.tmp`);
        const handle = await fs.open(candidate, "wx", 0o600);
        temporary = candidate;
        try {
          await handle.writeFile(body);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // A hard link publishes the complete inode without replacing an existing
        // key; a second upload attempt fails with EEXIST instead of overwriting.
        try {
          await fs.link(candidate, join(path, fileId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AttachmentAlreadyExistsError();
          throw error;
        }
        try { await fs.unlink(candidate); } catch { /* A stray .tmp is never listed. */ }
        temporary = undefined;
        return { fileId, size: body.length };
      } catch (error) {
        if (error instanceof AttachmentAlreadyExistsError) throw error;
        throw new AttachmentStorageError("UNAVAILABLE");
      } finally {
        if (temporary) {
          try { await fs.unlink(temporary); } catch { /* Preserve the safe original failure. */ }
        }
      }
    },

    async get(taskId, fileId) {
      objectKey(taskId, fileId);
      try {
        const path = join(await taskDirectory(taskId), fileId);
        const stat = await fs.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > MAX_ATTACHMENT_BYTES) throw new Error();
          // Bounded even if another process changes a file while it is being read.
          const buffer = Buffer.alloc(opened.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length !== opened.size) throw new Error();
          return buffer.subarray(0, length);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (missing(error)) return null;
        throw new AttachmentStorageError("UNAVAILABLE");
      }
    },

    async deleteOwned(taskId, fileId) {
      objectKey(taskId, fileId);
      try {
        await fs.unlink(join(await taskDirectory(taskId), fileId));
      } catch (error) {
        if (!missing(error)) throw new AttachmentStorageError("UNAVAILABLE");
      }
    },

    async list(taskId) {
      taskPrefix(taskId);
      const found: OwnedObject[] = [];
      try {
        const path = await taskDirectory(taskId);
        const entries = await fs.opendir(path);
        let scanned = 0;
        for await (const entry of entries) {
          if (++scanned > 5000) break;
          try { objectKey(taskId, entry.name); } catch { continue; }
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          try {
            const stat = await fs.lstat(join(path, entry.name));
            if (stat.isFile() && !stat.isSymbolicLink()) {
              found.push({ fileId: entry.name, lastModified: stat.mtime });
            }
          } catch (error) { if (!missing(error)) throw error; }
        }
        return found;
      } catch (error) {
        if (missing(error)) return found;
        throw new AttachmentStorageError("UNAVAILABLE");
      }
    },
  };
}
