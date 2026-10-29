import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTaskReadWhere } from "@/lib/project-access";
import { getProjectReadWhere } from "@/lib/project-access";
import { apiLogger } from "@/lib/logger";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isGlobalAdmin } from "@/lib/require-user";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiForbidden,
  apiBadRequest,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";
import { ValidationError, ForbiddenError, ConflictError, NotFoundError } from "@/lib/errors";
import {
  boardCreationSchema,
  createAuditedBoard,
  parseBoardAccessProfile,
} from "./board-creation";

const BOARD_PAGE_LIMIT = 100;
const BOARD_DEFAULT_PAGE_SIZE = 50;
const BOARD_CURSOR = /^[A-Za-z0-9_-]{1,128}$/;

type BoardPagination =
  | { mode: "legacy" }
  | { mode: "page"; limit: number; after: string | null }
  | { mode: "invalid"; message: string };

/**
 * Legacy clients call `GET /api/projects` (optionally `?search=`) and still get
 * the previous unbounded array. `limit`/`cursor` opt into the stable `id asc`
 * cursor page used by bounded readers such as MCP; the cursor is the last id of
 * the previous page and is only compared with `gt`.
 */
function parseBoardPagination(searchParams: URLSearchParams): BoardPagination {
  const rawLimit = searchParams.get("limit");
  const rawCursor = searchParams.get("cursor");
  if (rawLimit === null && rawCursor === null) return { mode: "legacy" };

  let limit = BOARD_DEFAULT_PAGE_SIZE;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) return { mode: "invalid", message: "Некорректный лимит" };
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BOARD_PAGE_LIMIT) {
      return { mode: "invalid", message: "Некорректный лимит" };
    }
  }
  if (rawCursor !== null && !BOARD_CURSOR.test(rawCursor)) {
    return { mode: "invalid", message: "Некорректный курсор" };
  }
  return { mode: "page", limit, after: rawCursor };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search");
  const navigation = searchParams.get("view") === "navigation";
  const pagination = parseBoardPagination(searchParams);
  if (pagination.mode === "invalid") {
    return apiBadRequest(pagination.message);
  }

  if (navigation && pagination.mode === "page") {
    return apiBadRequest("Навигационный список не поддерживает пагинацию");
  }

  try {
    const user = await requireApiUser(request);

    const baseWhere: Prisma.ProjectWhereInput = await getProjectReadWhere(user);

    const whereClause: Prisma.ProjectWhereInput = search
      ? {
          AND: [
            baseWhere,
            { name: { contains: search, mode: "insensitive" as const } }
          ]
        }
      : baseWhere;

    // Menus need only public labels of readable boards, not task counts or owners.
    if (navigation) {
      const projects = await prisma.project.findMany({
        where: whereClause,
        select: { id: true, name: true },
        orderBy: { updatedAt: "desc" },
        take: search ? 5 : undefined,
      });
      return apiSuccess(projects);
    }

    const include = {
      owner: { select: { id: true, name: true, email: true, avatarUrl: true, globalRole: true } },
      _count: {
        select: { tasks: { where: await getTaskReadWhere(user) } },
      },
    };

    if (pagination.mode === "page") {
      const pageWhere: Prisma.ProjectWhereInput = pagination.after
        ? { AND: [whereClause, { id: { gt: pagination.after } }] }
        : whereClause;
      const rows = await prisma.project.findMany({
        where: pageWhere,
        include,
        orderBy: { id: "asc" },
        take: pagination.limit + 1, // exact sentinel: one extra row proves hasMore
      });
      const items = rows.slice(0, pagination.limit);
      const hasMore = rows.length > pagination.limit;
      return apiSuccess({
        items,
        nextCursor: hasMore ? items[items.length - 1].id : null,
        hasMore,
      });
    }

    const projects = await prisma.project.findMany({
      where: whereClause,
      include,
      orderBy: { updatedAt: "desc" },
      take: search ? 5 : undefined, // Limit search results
    });

    return apiSuccess(projects);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить проекты");
  }
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    if (!isGlobalAdmin(user)) {
      return apiForbidden("Создавать доски могут только глобальные администраторы");
    }

    const parsed = boardCreationSchema.safeParse(json);
    if (!parsed.success) {
      if (parsed.error.issues.some(issue => issue.path[0] === "departmentId")) {
        return apiBadRequest("Укажите подразделение-владельца доски: непустой ID длиной до 128 символов");
      }
      return apiBadRequest("Некорректные данные проекта");
    }

    let accessProfile;
    try {
      accessProfile = parseBoardAccessProfile(parsed.data.accessProfile);
    } catch {
      return apiBadRequest("Некорректный профиль доступа");
    }

    try {
      await rateLimitOrThrowKey("projects:create", user.id);
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 429) {
        return rateLimitErrorResponse(error);
      }
      throw error;
    }

    const project = await createAuditedBoard({
      actorId: user.id,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      departmentId: parsed.data.departmentId,
      accessProfile,
      operationId: parsed.data.operationId,
    });

    return apiSuccess(project, undefined, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof ConflictError) return apiError("CONFLICT", "Конфликт команды создания доски", undefined, 409);
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      return apiBadRequest("Проверьте подразделение доски и профиль доступа: подразделение должно существовать и быть активным");
    }
    try {
      apiLogger.error({ event: "project.create.failed", route: "/api/projects" });
    } catch { /* Diagnostics must not replace the safe response. */ }
    return apiInternalError("Не удалось создать проект");
  }
}
