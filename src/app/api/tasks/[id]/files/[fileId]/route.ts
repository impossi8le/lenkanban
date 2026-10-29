import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { apiError, apiUnauthorized, apiNotFound, apiInternalError } from "@/lib/api-response";
import { AttachmentStorageError } from "@/lib/attachments/storage";
import { attachmentDownloadHeaders } from "@/lib/attachments/http";
import { createAttachmentStore, readAttachmentRuntimeConfig } from "@/lib/attachments/runtime";
import { attachmentBelongsToTask, readTaskAttachmentAccess } from "@/lib/attachments/task-port";
import { apiLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every refusal that is not an explicit unauthenticated request looks the same. */
function denied() {
  return apiNotFound("Файл не найден");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const config = readAttachmentRuntimeConfig(process.env);
  if (!config.enabled) {
    return apiError("ATTACHMENTS_UNAVAILABLE", "Файлы недоступны", undefined, 503);
  }

  let user;
  try {
    user = await requireApiUser(request);
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось получить файл");
  }

  const { id, fileId } = await params;
  if (!TASK_ID.test(id) || !FILE_ID.test(fileId)) return denied();

  let store;
  try {
    store = createAttachmentStore(config);
  } catch {
    return apiError("ATTACHMENTS_UNAVAILABLE", "Файлы недоступны", undefined, 503);
  }

  try {
    // One read port for every board: a fresh actor, the shared task read
    // predicate and the shared marker evaluator run on every request. There is
    // no OWN-specific shortcut, so a marked task cannot be downloaded here while
    // every other read channel denies it. A hidden or stale link is never enough.
    // Description attachments are ordinary task content; message attachments are
    // deliberately absent from this projection and retain their own policy.
    const access = await readTaskAttachmentAccess(prisma, id, user.id);
    if (access.status !== "ok") return denied();

    const attachment = attachmentBelongsToTask(access.attachments, access.taskId, fileId);
    if (!attachment) return denied();

    const bytes = await store.get(access.taskId, fileId);
    if (!bytes) return denied();

    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: attachmentDownloadHeaders(attachment.name, bytes.byteLength),
    });
  } catch (error) {
    if (error instanceof AttachmentStorageError) {
      try { apiLogger.warn({ event: "attachments.download.storage.failed", route: "/api/tasks/:id/files/:fileId" }); }
      catch { /* Diagnostics cannot replace the safe response. */ }
      return apiError("ATTACHMENTS_UNAVAILABLE", "Хранилище файлов недоступно", undefined, 503);
    }
    return apiInternalError("Не удалось получить файл");
  }
}
