import { prisma } from "@/lib/prisma";
import { requestDirectionDiscoveryWhere } from "@/lib/request-direction-discovery";
import { getProjectReadWhere } from "@/lib/project-access";
import { resolveRequestDirections } from "@/lib/request-direction-options";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { apiSuccess, apiUnauthorized, apiInternalError } from "@/lib/api-response";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const boards = await prisma.project.findMany({ where: requestDirectionDiscoveryWhere(user, await getProjectReadWhere(user)), select: { id: true, name: true }, orderBy: { updatedAt: "desc" }, take: 40 });
    return apiSuccess(await resolveRequestDirections(user, boards));
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось загрузить доступные направления");
  }
}
