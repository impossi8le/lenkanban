import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireDbUser } from "@/lib/require-user";
import { requireTrustedMutationOrigin } from "@/lib/mutation-origin";
import { apiBadRequest, apiConflict, apiError, apiForbidden, apiInternalError, apiSuccess, apiUnauthorized } from "@/lib/api-response";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { isDayKey, MY_DAY_ACTOR_HEADER, MY_DAY_MAX_LENGTH, MY_DAY_SESSION_CHANGED } from "@/lib/my-day-contract";
import { createMyDayService, MyDayConflict } from "@/lib/my-day-service";
import { readTelemetryJson, TelemetryHttpError } from "@/lib/telemetry/http";
import { withApiLogging } from "@/middleware/api-logger";

export const dynamic = "force-dynamic";
const inputSchema = z.object({
  text: z.string().max(MY_DAY_MAX_LENGTH).refine(text => !text.includes("\0")),
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  operationId: z.uuid(),
}).strict();

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function handle(request: Request, write: boolean): Promise<Response> {
  return withApiLogging(request, async (_request, context) => {
    try {
      // Diary v1 is browser-session only; task-scoped bearer tokens grant no diary access.
      if (request.headers.has("authorization")) throw new ForbiddenError();
      const user = await requireDbUser(request);
      context.actorId = user.id;
      // This is a precondition, never an owner selector. Cookies may change in
      // another tab before this tab's asynchronous session refresh completes.
      if (request.headers.get(MY_DAY_ACTOR_HEADER) !== user.id) {
        return noStore(apiError(MY_DAY_SESSION_CHANGED, "Учётная запись изменилась. Откройте дневник заново.", undefined, 403));
      }
      if (write) requireTrustedMutationOrigin(request);
      const query = new URL(request.url).searchParams;
      const date = query.get("date");
      if ([...query.keys()].some(key => key !== "date") || query.getAll("date").length !== 1 || !isDayKey(date)) {
        throw new BadRequestError("Выберите корректную дату.");
      }
      const service = createMyDayService(prisma);
      if (!write) return noStore(apiSuccess(await service.read(user.id, date)));
      const input = inputSchema.safeParse(await readTelemetryJson(request, { maxBytes: 256 * 1024 }));
      if (!input.success) throw new BadRequestError("Проверьте текст и повторите сохранение.");
      return noStore(apiSuccess(await service.save(user.id, date, input.data)));
    } catch (error) {
      // Fixed copy only: JSON fields, rejected input and SQL errors never reach diagnostics.
      if (error instanceof UnauthorizedError) return noStore(apiUnauthorized("Войдите в систему, чтобы открыть дневник."));
      if (error instanceof ForbiddenError) return noStore(apiForbidden("Нет доступа к дневнику."));
      if (error instanceof MyDayConflict) return noStore(apiConflict(error.message, { current: error.current }));
      if (error instanceof BadRequestError) return noStore(apiBadRequest(error.message));
      if (error instanceof TelemetryHttpError) return noStore(apiError("INVALID_DIARY_BODY", "Не удалось прочитать запись. Проверьте размер текста и повторите.", undefined, error.status));
      return noStore(apiInternalError("Не удалось сохранить или загрузить дневник. Повторите попытку."));
    }
  }, { route: "/api/my-day" });
}

export function GET(request: Request) { return handle(request, false); }
export function PUT(request: Request) { return handle(request, true); }
