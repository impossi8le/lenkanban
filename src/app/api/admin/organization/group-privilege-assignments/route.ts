import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationReader } from '@/lib/organization-reader';
import { createOrganizationService } from '@/lib/organization';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { organizationApi, organizationId, organizationJson, organizationLimit, organizationQuery, groupPrivilegeAssignmentBody } from '@/lib/organization-api';

export const dynamic = 'force-dynamic';
const route = '/api/admin/organization/group-privilege-assignments';
export function GET(request: Request) {
  return organizationApi(request, route, async actorId => {
    const params = organizationQuery(request, ['groupId', 'cursor', 'limit']);
    const groupId = organizationId.safeParse(params.get('groupId'));
    if (!groupId.success) throw new ValidationError();
    return apiSuccess(await createOrganizationReader(prisma).groupPrivilegeAssignments({ actorId, groupId: groupId.data,
      limit: organizationLimit(params), ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}) }));
  });
}
export function POST(request: Request) {
  return organizationApi(request, route, async actorId => {
    organizationQuery(request, []);
    const parsed = groupPrivilegeAssignmentBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    if (parsed.data.assigned) {
      const delegation = await createOrganizationReader(prisma).privilegeDelegationCheck({ actorId,
        profileId: parsed.data.profileId, scopeKind: parsed.data.scopeKind,
        departmentId: parsed.data.departmentId, projectId: parsed.data.projectId });
      if (!delegation.allowed) throw new ForbiddenError('Privilege delegation exceeds the granted scope');
    }
    return apiSuccess(await createOrganizationService(prisma).setGroupPrivilegeAssignment({ actorId, ...parsed.data }));
  }, true);
}
