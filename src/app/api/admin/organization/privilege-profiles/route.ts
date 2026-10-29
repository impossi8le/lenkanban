import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationReader } from '@/lib/organization-reader';
import { createOrganizationService } from '@/lib/organization';
import { ValidationError } from '@/lib/errors';
import { ORGANIZATION_PRIVILEGE_MATRIX } from '@/lib/organization-contract';
import { z } from 'zod';
import { organizationApi, organizationJson, organizationLimit, organizationQuery, privilegeProfileCreateBody } from '@/lib/organization-api';

export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return organizationApi(request, '/api/admin/organization/privilege-profiles', async actorId => {
    const params = organizationQuery(request, ['archived', 'cursor', 'limit']);
    const archived = params.get('archived') ?? 'all';
    if (archived !== 'all' && archived !== 'active' && archived !== 'archived') throw new ValidationError();
    const page = await createOrganizationReader(prisma).privilegeProfiles({ actorId, archived,
      limit: organizationLimit(params), ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}) });
    return apiSuccess({ ...page, matrix: ORGANIZATION_PRIVILEGE_MATRIX });
  });
}
export function POST(request: Request) {
  return organizationApi(request, '/api/admin/organization/privilege-profiles', async actorId => {
    organizationQuery(request, []);
    const parsed = privilegeProfileCreateBody.extend({ visibility: z.enum(['own', 'board']).optional() }).safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).createPrivilegeProfile({ actorId, ...parsed.data }));
  }, true);
}
