import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { createOrganizationReader } from '@/lib/organization-reader';
import { ValidationError } from '@/lib/errors';
import { groupMemberBody, organizationApi, organizationId, organizationJson, organizationLimit, organizationQuery } from '@/lib/organization-api';

type Context = { params: Promise<{ id: string }> };
export function GET(request: Request, context: Context) {
  return organizationApi(request, '/api/admin/organization/groups/:id/members', async actorId => {
    const groupId = organizationId.safeParse((await context.params).id);
    if (!groupId.success) throw new ValidationError();
    const query = organizationQuery(request, ['limit', 'cursor']);
    return apiSuccess(await createOrganizationReader(prisma).members({ actorId, groupId: groupId.data, limit: organizationLimit(query),
      ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}) }));
  });
}
export function POST(request: Request, context: Context) {
  return organizationApi(request, '/api/admin/organization/groups/:id/members', async actorId => {
    const groupId = organizationId.safeParse((await context.params).id);
    if (!groupId.success) throw new ValidationError();
    const parsed = groupMemberBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).setGroupMember({ actorId, groupId: groupId.data, ...parsed.data }));
  }, true);
}
