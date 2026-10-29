import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { ValidationError } from '@/lib/errors';
import { personDepartmentBody, organizationApi, organizationId, organizationJson } from '@/lib/organization-api';

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return organizationApi(request, '/api/admin/organization/people/:id', async actorId => {
    const id = organizationId.safeParse((await context.params).id);
    if (!id.success) throw new ValidationError();
    const parsed = personDepartmentBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).assignUserDepartment({ actorId, userId: id.data, ...parsed.data }));
  }, true);
}
