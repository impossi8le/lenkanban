import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { ValidationError } from '@/lib/errors';
import { groupUpdateBody, organizationApi, organizationId, organizationJson } from '@/lib/organization-api';

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return organizationApi(request, '/api/admin/organization/groups/:id', async actorId => {
    const groupId = organizationId.safeParse((await context.params).id);
    if (!groupId.success) throw new ValidationError();
    const parsed = groupUpdateBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    const { operationId, expectedVersion } = parsed.data;
    const input = { actorId, groupId: groupId.data, operationId, expectedVersion };
    const service = createOrganizationService(prisma);
    return apiSuccess(parsed.data.kind === 'rename'
      ? await service.renameGroup({ ...input, name: parsed.data.name })
      : await service.setGroupArchived({ ...input, archived: parsed.data.archived }));
  }, true);
}
