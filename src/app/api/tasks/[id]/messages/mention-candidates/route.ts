import { withApiLogging } from "@/middleware/api-logger";
import type { RequestLogContext } from "@/lib/request-context";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { requireTaskRead } from "@/lib/project-access";
import { filterMentionReaders } from "@/lib/task-mentions";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { apiSuccess, apiUnauthorized, apiNotFound, apiError, apiInternalError } from "@/lib/api-response";

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiLogging(request, (logged, logContext) => candidates(logged, context, logContext), { route: "/api/tasks/:id/messages/mention-candidates" });
}

async function candidates(request: Request, { params }: { params: Promise<{ id: string }> }, logContext: RequestLogContext) {
  const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };
  try {
    const actor = await requireApiUser(request);
    logContext.actorId = actor.id;
    try { await rateLimitOrThrowKey("tasks:list", actor.id); }
    catch (error) { return noStore(rateLimitErrorResponse(error)); }
    const { id } = await params;
    const task = await requireTaskRead(actor, id);
    const query = z.object({ search: z.string().trim().max(200), visibility: z.enum(["PUBLIC", "INTERNAL"]) }).safeParse({
      search: new URL(request.url).searchParams.get("search") ?? "",
      visibility: new URL(request.url).searchParams.get("visibility") ?? "PUBLIC",
    });
    if (!query.success) return noStore(apiError("INVALID_MENTION_SEARCH", "Не удалось выполнить поиск сотрудников", undefined, 422));
    if (query.data.visibility === "INTERNAL") return noStore(apiError("MENTIONS_INTERNAL_UNSUPPORTED", "Упоминания во внутреннем сообщении пока недоступны", undefined, 422));
    const candidates = await prisma.user.findMany({
      where: { id: { not: actor.id }, isBlocked: false, blockedAt: null, name: { contains: query.data.search, mode: "insensitive" } },
      select: { id: true, name: true, globalRole: true, isBlocked: true, blockedAt: true, primaryDepartment: { select: { name: true } } },
      orderBy: [{ name: "asc" }, { id: "asc" }], take: 40,
    });
    const readers = new Set(await filterMentionReaders(prisma, id, task.projectId, candidates));
    return noStore(apiSuccess({ items: candidates.filter(user => readers.has(user.id)).slice(0, 20).map(user => ({
      id: user.id, name: user.name, ...(user.primaryDepartment ? { departmentName: user.primaryDepartment.name } : {}),
    })) }));
  } catch (error) {
    if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return noStore(apiNotFound("Обращение недоступно"));
    return noStore(apiInternalError("Не удалось загрузить доступных сотрудников"));
  }
}
