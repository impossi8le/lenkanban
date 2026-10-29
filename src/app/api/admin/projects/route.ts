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
  decodeProjectsCursor,
  encodeProjectsCursor,
  projectsKeysetFilter,
} from "./cursor";

export const dynamic = "force-dynamic";

const querySchema = z.object({
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

    const { take, cursor: rawCursor } = parsed.data;
    const cursor = rawCursor ? decodeProjectsCursor(rawCursor) : null;
    if (rawCursor && !cursor) return apiValidationError(invalidCursorError());

    const where = cursor ? { AND: [projectsKeysetFilter(cursor)] } : {};

    const rows = await prisma.project.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        owner: { select: { id: true, email: true, name: true, globalRole: true } },
        _count: {
          select: {
            tasks: true,
            members: true,
          },
        },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeProjectsCursor(last) : null;

    return apiSuccess({ items, nextCursor });
  } catch (e) {
    if (e instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось загрузить проекты");
  }
}
