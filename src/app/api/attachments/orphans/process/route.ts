import { prisma } from "@/lib/prisma";
import {
  apiSuccess, apiError, apiUnauthorized, apiInternalError,
} from "@/lib/api-response";
import { apiLogger } from "@/lib/logger";
import { withApiLogging } from "@/middleware/api-logger";
import type { RequestLogContext } from "@/lib/request-context";
import { hasConfiguredServiceSecret, isServiceBearerAuthorized } from "@/lib/service-auth";
import { AttachmentStorageError } from "@/lib/attachments/storage";
import { createAttachmentStore, readAttachmentRuntimeConfig } from "@/lib/attachments/runtime";
import { ORPHAN_GRACE_MS, iterateOrphanTaskBatches, reconcileTaskOrphans } from "@/lib/attachments/orphans";
import { parseStoredAttachments } from "@/lib/attachments/task-port";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One invocation handles a bounded batch; the scheduler decides the cadence. */
const ORPHAN_BATCH_SIZE = 25;

export function POST(request: Request) {
  return withApiLogging(request, processOrphans, { route: "/api/attachments/orphans/process" });
}

/**
 * One-shot, service-authenticated orphan reconciliation.
 *
 * Deliberately not a setInterval in instrumentation: with several replicas that
 * would run parallel sweeps. Each task is reconciled against its *current*
 * committed attachments, so a live file is never deleted, and objects younger
 * than the grace period are kept even when unreferenced (an upload may still be
 * finalizing).
 */
async function processOrphans(request: Request, context: RequestLogContext) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!hasConfiguredServiceSecret(cronSecret)) {
      return apiError("SERVICE_UNAVAILABLE", "Attachment orphan processor is not configured", undefined, 503);
    }
    if (!isServiceBearerAuthorized(request.headers.get("authorization"), cronSecret)) {
      return apiUnauthorized();
    }

    const config = readAttachmentRuntimeConfig(process.env);
    if (!config.enabled) {
      return apiError("ATTACHMENTS_UNAVAILABLE", "Attachment storage is not configured", undefined, 503);
    }

    let store;
    try {
      store = createAttachmentStore(config);
    } catch {
      return apiError("ATTACHMENTS_UNAVAILABLE", "Attachment storage is unavailable", undefined, 503);
    }

    const now = new Date();
    const after = new URL(request.url).searchParams.get("after") ?? undefined;
    // One bounded page per invocation: the scheduler advances `after` so every
    // task is eventually swept, including ones that were never recently updated.
    let candidates: Array<{ id: string; attachments: unknown }> = [];
    for await (const batch of iterateOrphanTaskBatches(prisma, ORPHAN_BATCH_SIZE, after)) {
      candidates = batch;
      break;
    }
    const nextAfter = candidates.length === ORPHAN_BATCH_SIZE
      ? candidates[candidates.length - 1].id
      : null;

    const results: Array<{
      taskId: string;
      success: boolean;
      deleted?: number;
      kept?: number;
      failed?: number;
    }> = [];

    for (const candidate of candidates) {
      try {
        const result = await reconcileTaskOrphans(store, {
          taskId: candidate.id,
          attachments: parseStoredAttachments(candidate.attachments),
          now,
          graceMs: ORPHAN_GRACE_MS,
        });
        results.push({
          taskId: candidate.id,
          success: true,
          deleted: result.deleted.length,
          kept: result.kept,
          failed: result.failed.length,
        });
      } catch (error) {
        apiLogger.error({
          ...context,
          taskId: candidate.id,
          event: "job.failed",
          operation: "attachments.orphans.process",
          ...(error instanceof AttachmentStorageError ? { errorCode: error.code } : {}),
          err: error,
        });
        results.push({ taskId: candidate.id, success: false });
      }
    }

    return apiSuccess({
      scanned: results.length,
      nextAfter,
      deleted: results.reduce((sum, entry) => sum + (entry.deleted ?? 0), 0),
      failed: results.filter(entry => entry.success === false).length,
      results,
    });
  } catch (error) {
    apiLogger.error({ ...context, event: "attachments.orphans.process.failed", err: error });
    return apiInternalError("Ошибка обработки вложений");
  }
}
