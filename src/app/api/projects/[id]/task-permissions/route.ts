import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { requireProjectRead } from "@/lib/project-access";
import { getProjectStatusPolicy } from "@/lib/project-status-policy";
import { apiSuccess, apiUnauthorized, apiNotFound, apiInternalError } from "@/lib/api-response";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiUser(request);
    const { id } = await context.params;
    const access = await requireProjectRead(actor, id);
    const policy = await getProjectStatusPolicy(actor, id);
    const response = apiSuccess({ ...policy, canAssign: access.canWrite && (access.canManageMembers || policy.canChangeStatus) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    if (String(error).includes("NotFound")) return apiNotFound();
    return apiInternalError("Не удалось загрузить права действий");
  }
}
