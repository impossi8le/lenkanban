import { prisma } from '@/lib/prisma';
import { apiBadRequest, apiSuccess } from '@/lib/api-response';
import { organizationApi, organizationBoardCreateBody, organizationJson, organizationQuery } from '@/lib/organization-api';
import { createOrganizationService } from '@/lib/organization';

export function POST(request: Request) {
  return organizationApi(request, '/api/organization/projects', async actorId => {
    organizationQuery(request, []);
    const body = organizationBoardCreateBody.safeParse(await organizationJson(request));
    if (!body.success) return apiBadRequest('Invalid organization request');
    return apiSuccess(await createOrganizationService(prisma).createBoard({ ...body.data, actorId }));
  }, true);
}
