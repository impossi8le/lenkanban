import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { requireApiUser } from "@/lib/require-api-user";
import { z } from "zod";
import {
  apiSuccess,
  apiUnauthorized,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const searchSchema = z.object({
  q: z.string().optional(),
  take: z.coerce.number().min(1).max(100).optional().default(20),
});

export async function GET(request: Request) {
  try {
    const caller = await requireApiUser(request);

    const { searchParams } = new URL(request.url);
    const parsed = searchSchema.safeParse(Object.fromEntries(searchParams));

    if (!parsed.success) {
      return apiValidationError(parsed.error);
    }

    const { q, take } = parsed.data;

    // Build where clause for search
    const searchWhere: Prisma.UserWhereInput | undefined = q?.trim()
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" as const } },
            { name: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : undefined;

    // Directory membership is narrower than general board read access: only
    // shared project ownership/membership counts, not groups or scoped grants.
    const sharedProject: Prisma.ProjectWhereInput = {
      OR: [{ ownerId: caller.id }, { members: { some: { userId: caller.id } } }],
    };
    const circle: Prisma.UserWhereInput = {
      OR: [
        { id: caller.id },
        { projectMemberships: { some: { project: sharedProject } } },
        { projects: { some: sharedProject } },
      ],
    };
    const where = caller.globalRole === "ADMIN"
      ? searchWhere
      : searchWhere ? { AND: [circle, searchWhere] } : circle;

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
      },
      take,
      orderBy: { email: "asc" },
    });

    return apiSuccess(users.map(({ id, email, name, avatarUrl }) => ({
      id, email, name, avatarUrl,
    })));
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить пользователей");
  }
}
