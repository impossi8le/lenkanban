import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import {
  apiSuccess, apiError, apiUnauthorized, apiNotFound, apiInternalError, apiInvalidJson, apiValidationError,
} from "@/lib/api-response";
import { NotFoundError } from "@/lib/errors";
import { TaskCommandError } from "@/lib/task-command";
import { apiLogger } from "@/lib/logger";
import {
  AttachmentAlreadyExistsError, AttachmentStorageError, MAX_ATTACHMENT_BYTES,
} from "@/lib/attachments/storage";
import { AttachmentUploadError } from "@/lib/attachments/upload-validation";
import { AttachmentBodyError, readBoundedJsonBody } from "@/lib/attachments/http";
import { AttachmentBusyError } from "@/lib/attachments/decode-gate";
import { createAttachmentStore, readAttachmentRuntimeConfig } from "@/lib/attachments/runtime";
import { readUploadTokenSecret, UploadTokenError } from "@/lib/attachments/upload-token";
import {
  AttachmentUploadMismatchError, presignChatUpload, stageChatUpload,
} from "@/lib/attachments/chat-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const presignSchema = z.object({
  taskId: z.string().trim().min(1).max(128),
  filename: z.string().trim().min(1).max(200),
  mime: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
}).strict();

function unavailable(message = "Загрузка файлов недоступна") {
  return apiError("ATTACHMENTS_UNAVAILABLE", message, undefined, 503);
}

function tokenFailure(error: UploadTokenError) {
  return apiError(
    error.code === "EXPIRED" ? "UPLOAD_TOKEN_EXPIRED" : "UPLOAD_TOKEN_INVALID",
    error.code === "EXPIRED" ? "Ссылка загрузки истекла" : "Ссылка загрузки недействительна",
    undefined,
    422,
  );
}

function bodyFailure(error: AttachmentBodyError) {
  if (error.code === "TOO_LARGE") {
    return apiError("PAYLOAD_TOO_LARGE", "Файл превышает допустимый размер", undefined, 413);
  }
  if (error.code === "DEADLINE") {
    return apiError("UPLOAD_TIMEOUT", "Загрузка не завершена вовремя", undefined, 408);
  }
  return apiError("INVALID_UPLOAD", "Некорректная загрузка файла", undefined, 400);
}

function uploadFailure(error: unknown) {
  if (error instanceof AttachmentBodyError) return bodyFailure(error);
  if (error instanceof AttachmentBusyError) {
    return apiError("ATTACHMENTS_BUSY", "Хранилище файлов перегружено, повторите позже", undefined, 503);
  }
  if (error instanceof UploadTokenError) return tokenFailure(error);
  if (error instanceof AttachmentUploadMismatchError) {
    return apiError("UPLOAD_MISMATCH", "Размер файла не совпадает с заявленным", undefined, 422);
  }
  if (error instanceof AttachmentUploadError) {
    return apiError("VALIDATION_ERROR", "Недопустимый формат или размер файла", undefined, 422);
  }
  if (error instanceof UnauthorizedError) return apiUnauthorized();
  if (error instanceof NotFoundError) return apiNotFound("Задача не найдена");
  if (error instanceof TaskCommandError) {
    return apiError(error.code, "Task attachment mutation rejected; refresh before a new action", undefined, 409);
  }
  if (error instanceof AttachmentAlreadyExistsError) {
    return apiError("UPLOAD_ALREADY_COMPLETED", "Файл уже загружен", undefined, 409);
  }
  if (error instanceof AttachmentStorageError) {
    try { apiLogger.warn({ event: "attachments.presign.storage.failed", route: "/api/uploads/presign" }); }
    catch { /* Diagnostics cannot replace the safe response. */ }
    return unavailable("Хранилище файлов недоступно");
  }
  return apiInternalError("Не удалось загрузить файл");
}

/** Issues a server-keyed upload capability for a chat attachment. */
export async function POST(request: Request) {
  const config = readAttachmentRuntimeConfig(process.env);
  if (!config.enabled) return unavailable();
  const secret = readUploadTokenSecret(process.env);
  if (!secret) return unavailable("Загрузка вложений не настроена");

  let user;
  try {
    // Authentication and the per-actor quota run before a single body byte.
    user = await requireApiUser(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось подготовить загрузку файла");
  }
  try {
    await rateLimitOrThrowKey("uploads:presign", user.id);
  } catch (error) {
    return rateLimitErrorResponse(error);
  }

  let json: unknown;
  try {
    json = await readBoundedJsonBody(request);
  } catch (error) {
    if (error instanceof AttachmentBodyError && error.code === "MALFORMED") return apiInvalidJson();
    if (error instanceof AttachmentBodyError) return bodyFailure(error);
    return apiInternalError("Не удалось подготовить загрузку файла");
  }
  const parsed = presignSchema.safeParse(json);
  if (!parsed.success) return apiValidationError(parsed.error);

  try {
    const result = await presignChatUpload({
      actor: { id: user.id, globalRole: user.globalRole },
      database: prisma,
      taskId: parsed.data.taskId,
      filename: parsed.data.filename,
      mime: parsed.data.mime,
      size: parsed.data.size,
      secret,
    });
    return apiSuccess(result, undefined, 201);
  } catch (error) {
    return uploadFailure(error);
  }
}

/**
 * Server-mediated PUT for adapters without presigned URLs. The signed token in
 * the header binds task, actor, key, name, MIME and size; no client key is read.
 */
export async function PUT(request: Request) {
  const config = readAttachmentRuntimeConfig(process.env);
  if (!config.enabled) return unavailable();
  const secret = readUploadTokenSecret(process.env);
  if (!secret) return unavailable("Загрузка вложений не настроена");

  let user;
  try {
    // Authentication happens before any body byte is read.
    user = await requireApiUser(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось загрузить файл");
  }

  try {
    await rateLimitOrThrowKey("uploads:presign", user.id);
  } catch (error) {
    return rateLimitErrorResponse(error);
  }

  let store;
  try {
    store = createAttachmentStore(config);
  } catch {
    return unavailable("Хранилище файлов недоступно");
  }

  try {
    const result = await stageChatUpload({
      request,
      token: request.headers.get("x-attachment-upload-token"),
      actor: { id: user.id, globalRole: user.globalRole },
      database: prisma,
      store,
      secret,
    });
    return apiSuccess(result, undefined, 201);
  } catch (error) {
    return uploadFailure(error);
  }
}
