import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationReader } from '@/lib/organization-reader';
import { ValidationError } from '@/lib/errors';
import { organizationApi, organizationId, organizationQuery } from '@/lib/organization-api';

export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return organizationApi(request, '/api/admin/organization/privilege-preview', async actorId => {
    const params = organizationQuery(request, ['userId', 'projectId']);
    const userId = organizationId.safeParse(params.get('userId'));
    const projectId = organizationId.safeParse(params.get('projectId'));
    if (!userId.success || !projectId.success) throw new ValidationError();
    return apiSuccess(await createOrganizationReader(prisma).privilegePreview({ actorId, userId: userId.data, projectId: projectId.data }));
  });
}
