import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { markRequestQueueSeen } from "@/lib/request-queue-unseen";
import { requireTrustedMutationOrigin } from "@/lib/mutation-origin";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { readTelemetryJson, TelemetryHttpError } from "@/lib/telemetry/http";
import { withApiLogging } from "@/middleware/api-logger";
import { emitRequestQueueSeenInvalidation } from "@/socket/request-queue-events";
import { apiBadRequest, apiError, apiForbidden, apiInternalError, apiNotFound, apiSuccess, apiUnauthorized, apiValidationError } from "@/lib/api-response";

export const dynamic = "force-dynamic";
const seenSchema = z.object({
  queueEpoch: z.number().int().positive().max(2147483647),
  expectedActorId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();
const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };

/** Explicit visible-card receipt; GET and notification mark-read never call it. */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiLogging(request, async (logged, trace) => {
    try {
      const actor = await requireApiUser(logged);
      trace.actorId = actor.id;
      requireTrustedMutationOrigin(logged);
      const parsed = seenSchema.safeParse(await readTelemetryJson(logged, { maxBytes: 2048 }));
      if (!parsed.success) return noStore(apiValidationError(parsed.error));
      if (parsed.data.expectedActorId !== actor.id) return noStore(apiForbidden("Учётная запись изменилась. Обновите карточку."));
      try { await rateLimitOrThrowKey("tasks:update", actor.id); }
      catch (error) { return noStore(rateLimitErrorResponse(error)); }
      const result = await markRequestQueueSeen(prisma, {
        actorId: actor.id, expectedActorId: parsed.data.expectedActorId,
        taskId: (await context.params).id, queueEpoch: parsed.data.queueEpoch,
      });
      if (result.changed) {
        // The core transaction has committed. Delivery failure cannot revoke its
        // receipt, and no network operation occurs inside the transaction.
        try { await emitRequestQueueSeenInvalidation(actor.id); } catch { /* Re-fetch repairs delivery failures. */ }
      }
      return noStore(apiSuccess(result));
    } catch (error) {
      if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
      if (error instanceof BadRequestError) return noStore(apiBadRequest("Недопустимое подтверждение просмотра"));
      if (error instanceof ForbiddenError) return noStore(apiForbidden());
      if (error instanceof NotFoundError) return noStore(apiNotFound());
      if (error instanceof TelemetryHttpError) return noStore(apiError("INVALID_QUEUE_VIEW", "Не удалось прочитать подтверждение просмотра", undefined, error.status));
      return noStore(apiInternalError("Не удалось подтвердить просмотр обращения"));
    }
  }, { route: "/api/tasks/:id/queue-seen" });
}
