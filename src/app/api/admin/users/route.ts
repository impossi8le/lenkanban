import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiNotFound,
  apiUnauthorized,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";
import {
  decodeUsersCursor,
  encodeUsersCursor,
  usersKeysetFilter,
} from "./cursor";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().max(200).optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().max(512).optional(),
});

function invalidCursorError() {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: ["cursor"], message: "Invalid cursor" },
  ]);
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiUser(request);
    if (actor.globalRole !== "ADMIN") return apiNotFound();

    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) return apiValidationError(parsed.error);

    const { q, take, cursor: rawCursor } = parsed.data;
    const cursor = rawCursor ? decodeUsersCursor(rawCursor) : null;
    if (rawCursor && !cursor) return apiValidationError(invalidCursorError());

    const query = q?.trim().toLowerCase() ?? "";

    const where = {
      ...(query
        ? {
            OR: [
              { email: { contains: query, mode: "insensitive" as const } },
              { name: { contains: query, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(cursor ? { AND: [usersKeysetFilter(cursor)] } : {}),
    };

    const rows = await prisma.user.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        email: true,
        name: true,
        globalRole: true,
        createdAt: true,
        _count: {
          select: {
            projects: true,
            projectMemberships: true,
            apiTokens: true,
          },
        },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeUsersCursor(last) : null;

    return apiSuccess({ items, nextCursor });
  } catch (e) {
    if (e instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось загрузить пользователей");
  }
}
