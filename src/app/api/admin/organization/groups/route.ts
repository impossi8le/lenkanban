import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { createOrganizationReader } from '@/lib/organization-reader';
import { ValidationError } from '@/lib/errors';
import { groupCreateBody, organizationApi, organizationJson, organizationLimit, organizationQuery } from '@/lib/organization-api';

export function GET(request: Request) {
  return organizationApi(request, '/api/admin/organization/groups', async actorId => {
    const query = organizationQuery(request, ['archived', 'limit', 'cursor']);
    const archived = query.get('archived') ?? 'all';
    if (archived !== 'all' && archived !== 'active' && archived !== 'archived') throw new ValidationError();
    return apiSuccess(await createOrganizationReader(prisma).groups({ actorId, archived, limit: organizationLimit(query),
      ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}) }));
  });
}
export function POST(request: Request) {
  return organizationApi(request, '/api/admin/organization/groups', async actorId => {
    const parsed = groupCreateBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).createGroup({ actorId, ...parsed.data }), undefined, 201);
  }, true);
}
