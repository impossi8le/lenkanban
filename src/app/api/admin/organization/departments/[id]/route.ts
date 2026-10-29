import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { ValidationError } from '@/lib/errors';
import { departmentUpdateBody, organizationApi, organizationId, organizationJson } from '@/lib/organization-api';

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return organizationApi(request, '/api/admin/organization/departments/:id', async actorId => {
    const id = organizationId.safeParse((await context.params).id);
    if (!id.success) throw new ValidationError();
    const parsed = departmentUpdateBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    const { kind, ...command } = parsed.data;
    const service = createOrganizationService(prisma);
    const common = { actorId, departmentId: id.data, operationId: command.operationId, expectedVersion: command.expectedVersion };
    if (kind === 'rename' && 'name' in command) return apiSuccess(await service.renameDepartment({ ...common, name: command.name }));
    if (kind === 'move' && 'parentId' in command) return apiSuccess(await service.moveDepartment({ ...common, parentId: command.parentId }));
    if (kind === 'archive' && 'archived' in command) return apiSuccess(await service.setDepartmentArchived({ ...common, archived: command.archived }));
    if (kind === 'leader' && 'leaderId' in command) return apiSuccess(await service.setDepartmentLeader({ ...common, userId: command.leaderId }));
    throw new ValidationError();
  }, true);
}
