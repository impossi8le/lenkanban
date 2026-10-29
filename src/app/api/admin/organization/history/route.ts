import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationReader } from '@/lib/organization-reader';
import { organizationApi, organizationLimit, organizationQuery } from '@/lib/organization-api';

export function GET(request: Request) {
  return organizationApi(request, '/api/admin/organization/history', async actorId => {
    const query = organizationQuery(request, ['targetId', 'cursor', 'limit']);
    return apiSuccess(await createOrganizationReader(prisma).history({ actorId, limit: organizationLimit(query),
      ...(query.has('targetId') ? { targetId: query.get('targetId')! } : {}),
      ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}) }));
  });
}
