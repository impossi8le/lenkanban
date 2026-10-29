import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationReader } from '@/lib/organization-reader';
import { organizationApi, organizationLimit, organizationQuery } from '@/lib/organization-api';

export function GET(request: Request) {
  return organizationApi(request, '/api/admin/organization/roles', async actorId => {
    const query = organizationQuery(request, ['q', 'limit', 'cursor']);
    return apiSuccess(await createOrganizationReader(prisma).roles({ actorId, limit: organizationLimit(query),
      ...(query.has('q') ? { q: query.get('q')! } : {}),
      ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}) }));
  });
}
