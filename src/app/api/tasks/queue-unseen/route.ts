import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { readRequestQueueUnseenCounts } from "@/lib/request-queue-unseen";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { withApiLogging } from "@/middleware/api-logger";
import { apiBadRequest, apiForbidden, apiInternalError, apiNotFound, apiSuccess, apiUnauthorized } from "@/lib/api-response";

export const dynamic = "force-dynamic";
const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };

/** Counts are computed from the current actor's fresh read and execution policy. */
export function GET(request: Request) {
  return withApiLogging(request, async (logged, trace) => {
    try {
      const actor = await requireApiUser(logged);
      trace.actorId = actor.id;
      if ([...new URL(logged.url).searchParams.keys()].length > 0) return noStore(apiBadRequest("Параметры счётчика не поддерживаются"));
      try { await rateLimitOrThrowKey("tasks:list", actor.id); }
      catch (error) { return noStore(rateLimitErrorResponse(error)); }
      return noStore(apiSuccess(await readRequestQueueUnseenCounts(prisma, actor.id)));
    } catch (error) {
      if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
      if (error instanceof BadRequestError) return noStore(apiBadRequest("Недопустимые параметры счётчика"));
      if (error instanceof ForbiddenError) return noStore(apiForbidden());
      if (error instanceof NotFoundError) return noStore(apiNotFound());
      return noStore(apiInternalError("Не удалось загрузить непросмотренные обращения"));
    }
  }, { route: "/api/tasks/queue-unseen" });
}
