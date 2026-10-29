import type { Prisma } from "@prisma/client";
import { getTaskReadWhere } from "@/lib/project-access";
import { decodeStoredTaskRequest } from "@/lib/task-request-marker-lifecycle";
import { canActorReadInternal, loadProjectDiscussionFacts } from "@/app/api/tasks/[id]/messages/discussion-access";

/** Server-owned visibility is inherited from the message and retained on the file. */
export type StoredAttachment = {
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
  isInternal?: boolean;
  /** Server-only staging ownership. Empty string represents malformed persisted ownership. */
  pendingMessageAuthorId?: string;
};

export type AttachmentReadDatabase = Pick<Prisma.TransactionClient, "user" | "project" | "task" | "taskRequest" | "scopedPrivilegeAssignment" | "$queryRaw" | "$executeRaw">;

export type AttachmentReadResult =
  | { status: "ok"; taskId: string; projectId: string; attachments: StoredAttachment[] }
  | { status: "denied"; code: string }
  | { status: "missing" };

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function attachmentFileUrl(taskId: string, fileId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/files/${fileId}`;
}

/** Exact canonical server URL for this task; returns null for anything else. */
export function parseAttachmentFileUrl(url: unknown, taskId: string): string | null {
  if (typeof url !== "string") return null;
  const prefix = `/api/tasks/${encodeURIComponent(taskId)}/files/`;
  if (!url.startsWith(prefix)) return null;
  const fileId = url.slice(prefix.length);
  return FILE_ID.test(fileId) ? fileId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStoredAttachments(value: unknown): StoredAttachment[] {
  if (!Array.isArray(value)) return [];
  const result: StoredAttachment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { url, name, size, mime, width, height } = entry;
    if (typeof url !== "string" || typeof name !== "string"
      || typeof size !== "number" || typeof mime !== "string") continue;
    result.push({
      url, name, size, mime,
      ...(typeof width === "number" ? { width } : {}),
      ...(typeof height === "number" ? { height } : {}),
      // Invalid persisted visibility must fail closed, never become public.
      ...(entry.isInternal !== undefined ? { isInternal: entry.isInternal !== false } : {}),
      ...(entry.pendingMessageAuthorId !== undefined ? { pendingMessageAuthorId:
        typeof entry.pendingMessageAuthorId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(entry.pendingMessageAuthorId)
          ? entry.pendingMessageAuthorId : "" } : {}),
    });
  }
  return result;
}

/** Exact server-format membership; no prefix, substring or URL decoding matching. */
export function attachmentBelongsToTask(attachments: readonly StoredAttachment[], taskId: string, fileId: string): StoredAttachment | null {
  const expected = attachmentFileUrl(taskId, fileId);
  for (const attachment of attachments) {
    if (attachment.url === expected) return attachment;
  }
  return null;
}

/**
 * Read port for authenticated downloads. It adds no new rights matrix: the
 * existing fresh actor lookup and common task read predicate decide. A valid
 * lifecycle marker does not deny a read; malformed/deleted markers fail closed.
 * Marker and metadata are selected together, without the legacy mutation guard.
 */
export async function readTaskAttachmentAccess(
  database: AttachmentReadDatabase,
  taskId: string,
  actorId: string,
): Promise<AttachmentReadResult> {
  const actor = await database.user.findUnique({
    where: { id: actorId },
    select: { id: true, globalRole: true },
  });
  if (!actor) return { status: "missing" };

  // Resolve visibility in the metadata query on every request. Project membership
  // alone cannot authorize an OWN task, and an old URL is never a read grant.
  const task = await database.task.findFirst({
    where: await getTaskReadWhere(actor, { id: taskId }, database),
    select: { id: true, projectId: true, attachments: true, request: { select: {
      taskId: true, contractVersion: true, state: true, authorId: true, executorId: true,
      needsInfoSince: true, pausedTotalMs: true, deletedAt: true,
    } } },
  });
  if (!task) return { status: "missing" };

  if (task.request !== null) {
    // Match the lifecycle read projection; never infer a marker from Task.status.
    const { deletedAt, ...fields } = task.request;
    const decoded = decodeStoredTaskRequest(fields, taskId);
    if (!decoded.valid || decoded.marker === null) return { status: "denied", code: "INVALID_REQUEST_MARKER" };
    if (deletedAt !== null) return { status: "missing" };
  }

  const attachments = await filterTaskAttachmentsForReader(
    database, actor, task.projectId, parseStoredAttachments(task.attachments),
  );

  return {
    status: "ok",
    taskId: task.id,
    projectId: task.projectId,
    attachments,
  };
}

/** Public attachment presentation: the server-owned visibility flag never leaves the API. */
export function toPublicAttachmentDTOs(
  attachments: readonly StoredAttachment[],
): Array<Omit<StoredAttachment, "isInternal" | "pendingMessageAuthorId">> {
  return attachments.map(attachment => ({
    url: attachment.url,
    name: attachment.name,
    size: attachment.size,
    mime: attachment.mime,
    ...(attachment.width !== undefined ? { width: attachment.width } : {}),
    ...(attachment.height !== undefined ? { height: attachment.height } : {}),
  }));
}

/**
 * Fail-closed projection for a reader whose internal access is not known.
 * A URL classified as internal is removed with every duplicate, so public
 * metadata cannot be used to infer an inherited restricted file.
 */
export function publicTaskAttachmentDTOs(value: unknown): Array<Omit<StoredAttachment, "isInternal" | "pendingMessageAuthorId">> {
  const stored = parseStoredAttachments(value);
  const internalUrls = new Set(stored.filter(attachment => attachment.isInternal || attachment.pendingMessageAuthorId !== undefined).map(attachment => attachment.url));
  return toPublicAttachmentDTOs(stored.filter(attachment => !internalUrls.has(attachment.url)));
}

/** Server projection for BezNal only. Legacy fallback may observe only files
 * safe for every task reader, never uploader-private or internal-only staging.
 */
export function effectiveBeznalPhase(rawStoredPhase: unknown, rawTaskAttachments: unknown): "WAITING" | "INVOICED" {
  if (rawStoredPhase === "WAITING" || rawStoredPhase === "INVOICED") return rawStoredPhase;
  if (rawStoredPhase !== null && rawStoredPhase !== undefined) return "WAITING";
  return publicTaskAttachmentDTOs(rawTaskAttachments).length ? "INVOICED" : "WAITING";
}

/** Shared fresh actor-aware projection for task read/mutation responses. */
export async function readVisibleTaskAttachments(
  database: AttachmentReadDatabase,
  actor: { id: string; globalRole: "USER" | "ADMIN" },
  projectId: string,
  value: unknown,
): Promise<Array<Omit<StoredAttachment, "isInternal" | "pendingMessageAuthorId">> | undefined> {
  if (value === undefined || value === null) return undefined;
  return toPublicAttachmentDTOs(await filterTaskAttachmentsForReader(
    database, actor, projectId, parseStoredAttachments(value),
  ));
}

/** Shared file visibility for downloads and lifecycle metadata projections. */
export async function filterTaskAttachmentsForReader(
  database: AttachmentReadDatabase,
  actor: { id: string; globalRole: "USER" | "ADMIN" },
  projectId: string,
  attachments: StoredAttachment[],
): Promise<StoredAttachment[]> {
  // Staging belongs only to its uploader, even when another actor can read the
  // internal discussion. Conflicting duplicate ownership hides the whole URL.
  const otherPendingUrls = new Set(attachments.filter(attachment => attachment.pendingMessageAuthorId !== undefined
    && attachment.pendingMessageAuthorId !== actor.id).map(attachment => attachment.url));
  const actorAttachments = attachments.filter(attachment => !otherPendingUrls.has(attachment.url));
  const internalUrls = new Set(attachments.filter(attachment => attachment.isInternal).map(attachment => attachment.url));
  const internalVisible = internalUrls.size > 0
    && await canActorReadInternal(database, actor, await loadProjectDiscussionFacts(database, projectId));

  // Duplicate public metadata must not expose an inherited internal file.
  return internalVisible ? actorAttachments : actorAttachments.filter(attachment => !internalUrls.has(attachment.url));
}
