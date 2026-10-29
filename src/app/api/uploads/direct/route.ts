import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { apiSuccess, apiError, apiUnauthorized, apiNotFound, apiInternalError } from "@/lib/api-response";
import { NotFoundError } from "@/lib/errors";
import { TaskCommandError } from "@/lib/task-command";
import { apiLogger } from "@/lib/logger";
import { AttachmentStorageError } from "@/lib/attachments/storage";
import { AttachmentUploadError } from "@/lib/attachments/upload-validation";
import { AttachmentBodyError } from "@/lib/attachments/http";
import { AttachmentQuotaError } from "@/lib/attachments/append";
import { AttachmentBusyError } from "@/lib/attachments/decode-gate";
import { createAttachmentStore, readAttachmentRuntimeConfig } from "@/lib/attachments/runtime";
import { directUpload } from "@/lib/attachments/direct-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unavailable() {
  return apiError("ATTACHMENTS_UNAVAILABLE", "Загрузка файлов недоступна", undefined, 503);
}

export async function POST(request: Request) {
  const config = readAttachmentRuntimeConfig(process.env);
  if (!config.enabled) return unavailable();

  let user;
  try {
    // Authentication happens before any body byte is read.
    user = await requireApiUser(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось загрузить файлы");
  }

  let store;
  try {
    store = createAttachmentStore(config);
  } catch {
    return unavailable();
  }

  try {
    const result = await directUpload(request, {
      actor: { id: user.id, globalRole: user.globalRole },
      database: prisma,
      store,
    });
    return apiSuccess({ uploaded: result.uploaded, count: result.count }, undefined, 201);
  } catch (error) {
    if (error instanceof AttachmentBodyError) {
      if (error.code === "TOO_LARGE") {
        return apiError("PAYLOAD_TOO_LARGE", "Файлы превышают допустимый размер", undefined, 413);
      }
      if (error.code === "DEADLINE") {
        return apiError("UPLOAD_TIMEOUT", "Загрузка не завершена вовремя", undefined, 408);
      }
      return apiError("INVALID_UPLOAD", "Некорректная загрузка файлов", undefined, 400);
    }
    if (error instanceof AttachmentBusyError) {
      return apiError("ATTACHMENTS_BUSY", "Хранилище файлов перегружено, повторите позже", undefined, 503);
    }
    if (error instanceof AttachmentQuotaError) {
      return apiError("ATTACHMENT_QUOTA_EXCEEDED", "Достигнут лимит вложений задачи", undefined, 409);
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
      try { apiLogger.warn({ event: "attachments.upload.storage.failed", route: "/api/uploads/direct" }); }
      catch { /* Diagnostics cannot replace the safe response. */ }
      return apiError("ATTACHMENTS_UNAVAILABLE", "Хранилище файлов недоступно", undefined, 503);
    }
    return apiInternalError("Не удалось загрузить файлы");
  }
}
