import {deliverNotifications} from "@/lib/notifications";
import {emitRequestQueueInvalidation} from "@/socket/request-queue-events";
import type { PrismaClient, Prisma } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { NotFoundError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { prepareTaskAttachmentWrite } from "./write-access";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { emitTaskUpdated } from "@/socket/board-events";
import { appendTaskAttachments } from "./append";
import { withDecodeSlot } from "./decode-gate";
import { readBoundedBody, UPLOAD_BODY_DEADLINE_MS } from "./http";
import {
  AttachmentAlreadyExistsError, AttachmentStorageError, MAX_ATTACHMENT_BYTES, type PrivateAttachmentStore,
} from "./storage";
import {
  attachmentBelongsToTask, attachmentFileUrl, filterTaskAttachmentsForReader, parseStoredAttachments, toPublicAttachmentDTOs, type StoredAttachment,
} from "./task-port";
import {
  createUploadToken, UPLOAD_TOKEN_TTL_MS, UploadTokenError, verifyUploadToken,
  type UploadTokenPayload,
} from "./upload-token";
import {
  validateAttachmentDescriptor, validateAttachmentUpload,
} from "./upload-validation";

export type ChatUploadDatabase = Pick<PrismaClient, "$transaction" | "task">;
export type ChatUploadActor = { id: string; globalRole: "USER" | "ADMIN" };

const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export type PresignChatUploadInput = {
  actor: ChatUploadActor;
  database: ChatUploadDatabase;
  taskId: string;
  filename: unknown;
  mime: unknown;
  size: unknown;
  secret: string;
  now?: Date;
};

export type PresignChatUploadResult = {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  token: string;
  expiresAt: string;
  name: string;
  size: number;
  mime: string;
};

/**
 * Issues a one-object upload capability. No client key, bucket or URL is read:
 * the server picks the canonical UUIDv4 and binds task, actor and metadata into
 * the signed token. The capability is checked again at PUT and at finalize.
 */
export async function presignChatUpload({
  actor, database, taskId, filename, mime, size, secret, now,
}: PresignChatUploadInput): Promise<PresignChatUploadResult> {
  if (!TASK_ID.test(taskId)) throw new NotFoundError();
  const descriptor = validateAttachmentDescriptor(filename, mime, size);

  const task = await database.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!task) throw new NotFoundError();
  await database.$transaction(async tx => {
    await prepareTaskAttachmentWrite({
      tx, actorId: actor.id, taskId, expectedProjectId: task.projectId,
    });
  });

  const issuedAt = now ?? new Date();
  const payload: UploadTokenPayload = {
    v: 1,
    taskId,
    actorId: actor.id,
    fileId: randomUUID(),
    name: descriptor.name,
    mime: descriptor.mime,
    size: descriptor.size,
    nonce: randomBytes(24).toString("hex"),
    expiresAt: issuedAt.getTime() + UPLOAD_TOKEN_TTL_MS,
  };
  const token = createUploadToken(secret, payload);

  return {
    // Server-mediated PUT for every adapter: local disk has no presigned URLs and
    // the S3 adapter deliberately has no public/signed-URL path in this slice.
    uploadUrl: "/api/uploads/presign",
    method: "PUT",
    headers: {
      "Content-Type": descriptor.mime,
      "X-Attachment-Upload-Token": token,
    },
    token,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    name: descriptor.name,
    size: descriptor.size,
    mime: descriptor.mime,
  };
}

export type StageChatUploadInput = {
  request: Request;
  token: unknown;
  actor: ChatUploadActor;
  database: ChatUploadDatabase;
  store: PrivateAttachmentStore;
  secret: string;
  now?: Date;
};

export type StageChatUploadResult = { uploaded: true; expiresAt: string };

/**
 * Writes the body to the server-derived staging key. Authentication and the
 * fresh write/marker guard run before a single body byte is read. The object is
 * not downloadable: downloads require exact membership in Task.attachments,
 * which only finalize creates. A repeated PUT cannot replace validated bytes
 * because the store refuses to overwrite an existing key.
 */
export async function stageChatUpload({
  request, token, actor, database, store, secret, now,
}: StageChatUploadInput): Promise<StageChatUploadResult> {
  const payload = verifyUploadToken(token, secret, now ?? new Date());
  if (payload.actorId !== actor.id) throw new UploadTokenError("INVALID");

  const task = await database.task.findUnique({
    where: { id: payload.taskId },
    select: { projectId: true, attachments: true },
  });
  if (!task) throw new NotFoundError();
  await database.$transaction(async tx => {
    await prepareTaskAttachmentWrite({
      tx, actorId: actor.id, taskId: payload.taskId, expectedProjectId: task.projectId,
    });
  });

  // A finalized object is already committed metadata. Its capability is spent:
  // no further PUT is accepted for this key, even if the object were removed.
  if (attachmentBelongsToTask(parseStoredAttachments(task.attachments), payload.taskId, payload.fileId)) {
    throw new AttachmentAlreadyExistsError();
  }

  const putWithId = store.putWithId?.bind(store);
  if (!putWithId) throw new AttachmentStorageError("UNAVAILABLE");

  const body = await readBoundedBody(request, MAX_ATTACHMENT_BYTES, UPLOAD_BODY_DEADLINE_MS);
  if (body.byteLength !== payload.size) throw new AttachmentUploadMismatchError();

  // Reuse the shared signature/format validator on the actual bytes, not only
  // on the declared MIME. A corrupted or mislabeled body is rejected here.
  await withDecodeSlot(() =>
    validateAttachmentUpload(new File([body as unknown as BlobPart], payload.name, { type: payload.mime })));

  await putWithId(payload.taskId, payload.fileId, body);
  return { uploaded: true, expiresAt: new Date(payload.expiresAt).toISOString() };
}

export class AttachmentUploadMismatchError extends Error {
  readonly code = "UPLOAD_MISMATCH";
  constructor() {
    super("Uploaded bytes do not match the declared size");
    this.name = "AttachmentUploadMismatchError";
  }
}

export type FinalizeChatUploadInput = {
  token: unknown;
  taskId: string;
  actor: ChatUploadActor;
  database: ChatUploadDatabase;
  store: PrivateAttachmentStore;
  secret: string;
  now?: Date;
};

export type FinalizeChatUploadResult = {
  attachment: StoredAttachment;
  created: boolean;
};

/**
 * Re-validates the stored bytes, then appends metadata through the shared atomic
 * writer. The guard is repeated inside the commit transaction, so access revoked
 * after presign or after the PUT prevents both the append and its Activity.
 * Repeating finalize for the same URL is idempotent: no second append, no second
 * Activity. Two different uploads are appended independently.
 */
export async function finalizeChatUpload({
  token, taskId, actor, database, store, secret, now,
}: FinalizeChatUploadInput): Promise<FinalizeChatUploadResult> {
  const payload = verifyUploadToken(token, secret, now ?? new Date());
  if (payload.actorId !== actor.id || payload.taskId !== taskId) throw new UploadTokenError("INVALID");

  const task = await database.task.findUnique({
    where: { id: payload.taskId },
    select: { projectId: true },
  });
  if (!task) throw new NotFoundError();

  // Fresh access is rechecked before deciding that this upload is already done:
  // a revoked actor must not learn anything or receive a stored DTO.
  const readCompleted = async (tx: Prisma.TransactionClient): Promise<StoredAttachment | null> => {
    const current = await tx.task.findUnique({ where: { id: payload.taskId }, select: { attachments: true } });
    if (!current) throw new NotFoundError();
    const attachments = parseStoredAttachments(current.attachments);
    if (!attachmentBelongsToTask(attachments, payload.taskId, payload.fileId)) return null;
    // Admission holds the Task/User locks. Never trust stale caller role claims
    // or return a public-looking duplicate of an inherited internal URL.
    const freshActor = await tx.user.findUnique({ where: { id: actor.id }, select: { id: true, globalRole: true } });
    if (!freshActor) throw new NotFoundError();
    const visible = await filterTaskAttachmentsForReader(tx, freshActor, task.projectId, attachments);
    const matching = attachmentBelongsToTask(visible, payload.taskId, payload.fileId);
    if (!matching) throw new NotFoundError();
    return matching;
  };
  const completed = await database.$transaction(async tx => {
    await prepareTaskAttachmentWrite({
      tx, actorId: actor.id, taskId: payload.taskId, expectedProjectId: task.projectId,
    });
    return readCompleted(tx);
  });

  // Completed replay uses only current admitted/visible metadata; no object decode.
  if (completed) return { attachment: toPublicAttachmentDTOs([completed])[0], created: false };

  const bytes = await store.get(payload.taskId, payload.fileId);
  if (!bytes) throw new UploadTokenError("INVALID");
  if (bytes.byteLength !== payload.size) throw new AttachmentUploadMismatchError();
  const validated = await withDecodeSlot(() => validateAttachmentUpload(
    new File([bytes as unknown as BlobPart], payload.name, { type: payload.mime }),
  ));

  const attachment: StoredAttachment = {
    url: attachmentFileUrl(payload.taskId, payload.fileId),
    name: validated.name,
    size: bytes.byteLength,
    mime: validated.mime,
  };

  const result = await database.$transaction(async tx => {
    const appended = await appendTaskAttachments(tx, {
      taskId: payload.taskId, actorId: actor.id, expectedProjectId: task.projectId, attachments: [attachment], discussionDraft:true,
    });
    // Another finalize may have won after preflight. Its metadata/audience wins,
    // not this request's locally constructed public DTO.
    const committed = appended.added.length > 0 ? attachment : await readCompleted(tx);
    if (!committed) throw new NotFoundError();
    return { ...appended, attachment: committed };
  });

  if(result.notifications?.length)deliverNotifications(result.notifications);
  if(result.queueRecipientIds)await emitRequestQueueInvalidation({taskId:payload.taskId,projectId:result.projectId,previousRecipientIds:result.queueRecipientIds});
  const created = result.added.length > 0;
  if (created) {
    try {
      const fullTask = await loadTaskWithRelations(payload.taskId);
      if (fullTask?.project.id === result.projectId) await emitTaskUpdated(result.projectId, fullTask);
    } catch (error) {
      try {
        apiLogger.warn({ event: "attachments.chat.realtime.failed", route: "/api/uploads/finalize", err: error });
      } catch {
        // Diagnostics cannot replace committed success.
      }
    }
  }

  return { attachment: toPublicAttachmentDTOs([result.attachment])[0], created };
}
