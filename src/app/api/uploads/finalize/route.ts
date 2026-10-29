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
import { AttachmentStorageError } from "@/lib/attachments/storage";
import { AttachmentUploadError } from "@/lib/attachments/upload-validation";
import { AttachmentBodyError, readBoundedJsonBody } from "@/lib/attachments/http";
import { AttachmentBusyError } from "@/lib/attachments/decode-gate";
import { AttachmentQuotaError } from "@/lib/attachments/append";
import { createAttachmentStore, readAttachmentRuntimeConfig } from "@/lib/attachments/runtime";
import { readUploadTokenSecret, UploadTokenError } from "@/lib/attachments/upload-token";
import { AttachmentUploadMismatchError, finalizeChatUpload } from "@/lib/attachments/chat-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const finalizeSchema = z.object({
  taskId: z.string().trim().min(1).max(128),
  token: z.string().min(1).max(4096),
}).strict();

function unavailable(message = "Загрузка файлов недоступна") {
  return apiError("ATTACHMENTS_UNAVAILABLE", message, undefined, 503);
}

function finalizeFailure(error: unknown) {
  if (error instanceof AttachmentBodyError) {
    if (error.code === "TOO_LARGE") {
      return apiError("PAYLOAD_TOO_LARGE", "Файл превышает допустимый размер", undefined, 413);
    }
    if (error.code === "DEADLINE") {
      return apiError("UPLOAD_TIMEOUT", "Загрузка не завершена вовремя", undefined, 408);
    }
    return apiError("INVALID_UPLOAD", "Некорректная загрузка файла", undefined, 400);
  }
  if (error instanceof AttachmentBusyError) {
    return apiError("ATTACHMENTS_BUSY", "Хранилище файлов перегружено, повторите позже", undefined, 503);
  }
  if (error instanceof AttachmentQuotaError) {
    return apiError("ATTACHMENT_QUOTA_EXCEEDED", "Достигнут лимит вложений задачи", undefined, 409);
  }
  if (error instanceof UploadTokenError) {
    return apiError(
      error.code === "EXPIRED" ? "UPLOAD_TOKEN_EXPIRED" : "UPLOAD_TOKEN_INVALID",
      error.code === "EXPIRED" ? "Ссылка загрузки истекла" : "Ссылка загрузки недействительна",
      undefined,
      422,
    );
  }
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
  if (error instanceof AttachmentStorageError) {
    try { apiLogger.warn({ event: "attachments.finalize.storage.failed", route: "/api/uploads/finalize" }); }
    catch { /* Diagnostics cannot replace the safe response. */ }
    return unavailable("Хранилище файлов недоступно");
  }
  return apiInternalError("Не удалось прикрепить файл");
}

/**
 * Binds a staged object to the task. Fresh access and the marker guard are
 * repeated inside the append transaction; a revoked actor gets no commit and no
 * Activity. A repeated finalize returns the same attachment without a second
 * append.
 */
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
    return apiInternalError("Не удалось прикрепить файл");
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
    if (error instanceof AttachmentBodyError) {
      if (error.code === "TOO_LARGE") {
        return apiError("PAYLOAD_TOO_LARGE", "Файл превышает допустимый размер", undefined, 413);
      }
      if (error.code === "DEADLINE") {
        return apiError("UPLOAD_TIMEOUT", "Загрузка не завершена вовремя", undefined, 408);
      }
    }
    return apiInternalError("Не удалось прикрепить файл");
  }
  const parsed = finalizeSchema.safeParse(json);
  if (!parsed.success) return apiValidationError(parsed.error);

  let store;
  try {
    store = createAttachmentStore(config);
  } catch {
    return unavailable("Хранилище файлов недоступно");
  }

  try {
    const result = await finalizeChatUpload({
      token: parsed.data.token,
      taskId: parsed.data.taskId,
      actor: { id: user.id, globalRole: user.globalRole },
      database: prisma,
      store,
      secret,
    });
    return apiSuccess(result, undefined, result.created ? 201 : 200);
  } catch (error) {
    return finalizeFailure(error);
  }
}
