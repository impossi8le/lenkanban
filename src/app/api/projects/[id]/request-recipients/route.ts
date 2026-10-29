import { getProjectRequestStaffWhere } from "@/lib/project-request-execution-policy";
import { prisma } from "@/lib/prisma";
import { getProjectCreateAccess } from "@/lib/project-access";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { apiSuccess, apiUnauthorized, apiNotFound, apiInternalError } from "@/lib/api-response";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;
    if (!(await getProjectCreateAccess(user, id)).canCreate) return apiNotFound("Направление недоступно");
    const staff = await getProjectRequestStaffWhere(id);
    const recipients = staff === null ? [] : await prisma.user.findMany({
      where: staff, select: { id: true, name: true }, orderBy: { id: "asc" },
    });
    return apiSuccess({ recipients });
  } catch (error) {
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    return apiInternalError("Не удалось загрузить сотрудников отдела");
  }
}
