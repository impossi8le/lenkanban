import { AttachmentStorageError, type ListableAttachmentStore } from "./storage";
import { attachmentBelongsToTask, type StoredAttachment } from "./task-port";

/** Objects younger than this are never deleted: an upload may still be committing. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

type OrphanTask = { id: string; attachments: unknown };
type OrphanTaskDatabase = {
  task: {
    findMany(query: {
      where: { id?: { gt: string } };
      orderBy: { id: "asc" };
      take: number;
      select: { id: true; attachments: true };
    }): Promise<OrphanTask[]>;
  };
};

/**
 * Full sweep in bounded pages. ID is stable while updatedAt is not; a range
 * cursor also keeps working if the last task in the previous page is removed.
 * No deletedAt filter: soft-deleted tasks still own storage namespaces.
 * The service-authenticated processor must consume this iterator instead of
 * selecting only the latest 25 tasks.
 */
export async function* iterateOrphanTaskBatches(
  database: OrphanTaskDatabase,
  batchSize = 25,
  startAfter?: string,
): AsyncGenerator<OrphanTask[]> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new AttachmentStorageError("INVALID_INPUT");
  }
  let after: string | undefined = startAfter;
  while (true) {
    const batch = await database.task.findMany({
      where: after === undefined ? {} : { id: { gt: after } },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, attachments: true },
    });
    if (batch.length === 0) return;
    yield batch;
    after = batch[batch.length - 1].id;
    if (batch.length < batchSize) return;
  }
}

export type OrphanReconcileInput = {
  taskId: string;
  attachments: readonly StoredAttachment[];
  /** Injected clock; the caller decides the reference time. */
  now: Date;
  graceMs?: number;
};

export type OrphanReconcileResult = {
  deleted: string[];
  kept: number;
  failed: string[];
};

/**
 * DB-aware orphan reconciliation for one task namespace.
 *
 * Only objects that are absent from the *current committed* attachment array and
 * older than the grace period are removed. Objects referenced by metadata, fresh
 * objects and keys that are not canonical for this task are always kept. This is
 * deliberately not a prefix-wide TTL cleanup: that would delete live files.
 *
 * A storage listing failure aborts the run; nothing is deleted from an unknown
 * inventory. Deletion failures are reported per object and never retried here.
 */
export async function reconcileTaskOrphans(
  store: ListableAttachmentStore,
  { taskId, attachments, now, graceMs = ORPHAN_GRACE_MS }: OrphanReconcileInput,
): Promise<OrphanReconcileResult> {
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)
    || !(now instanceof Date) || Number.isNaN(now.getTime())
    || !Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new AttachmentStorageError("INVALID_INPUT");
  }
  const objects = await store.list(taskId);
  const result: OrphanReconcileResult = { deleted: [], kept: 0, failed: [] };

  for (const object of objects) {
    if (attachmentBelongsToTask(attachments, taskId, object.fileId)) {
      result.kept++;
      continue;
    }
    // An unknown age is not proof of an orphan.
    if (!object.lastModified || now.getTime() - object.lastModified.getTime() < graceMs) {
      result.kept++;
      continue;
    }
    try {
      await store.deleteOwned(taskId, object.fileId);
      result.deleted.push(object.fileId);
    } catch {
      result.failed.push(object.fileId);
    }
  }
  return result;
}
