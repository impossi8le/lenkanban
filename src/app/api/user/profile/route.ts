import { prisma } from "@/lib/prisma";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { z } from "zod";
import {
  apiSuccess,
  apiUnauthorized,
  apiInvalidJson,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export async function PATCH(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    const parsed = updateProfileSchema.parse(json);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: parsed.name,
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        globalRole: true,
      },
    });

    return apiSuccess(updatedUser);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось обновить профиль");
  }
}
