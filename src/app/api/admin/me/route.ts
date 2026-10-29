import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiNotFound,
  apiUnauthorized,
  apiInternalError
} from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);

    return apiSuccess({
      id: user.id,
      email: user.email,
      name: user.name,
      globalRole: user.globalRole,
    });
  } catch (e) {
    if (e instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось загрузить данные пользователя");
  }
}
