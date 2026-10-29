import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationReader } from '@/lib/organization-reader';
import { createOrganizationService } from '@/lib/organization';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { organizationApi, organizationId, organizationJson, organizationLimit, organizationQuery, privilegeAssignmentBody } from '@/lib/organization-api';

export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return organizationApi(request, '/api/admin/organization/privilege-assignments', async actorId => {
    const params = organizationQuery(request, ['userId', 'cursor', 'limit']);
    const userId = organizationId.safeParse(params.get('userId'));
    if (!userId.success) throw new ValidationError();
    return apiSuccess(await createOrganizationReader(prisma).privilegeAssignments({ actorId, userId: userId.data,
      limit: organizationLimit(params), ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}) }));
  });
}
export function POST(request: Request) {
  return organizationApi(request, '/api/admin/organization/privilege-assignments', async actorId => {
    organizationQuery(request, []);
    const parsed = privilegeAssignmentBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    if (parsed.data.assigned) {
      // A grant may never exceed the actor's own permissions or leave their
      // scope. Revocation stays possible so an accidental grant is reversible.
      const delegation = await createOrganizationReader(prisma).privilegeDelegationCheck({ actorId,
        profileId: parsed.data.profileId, scopeKind: parsed.data.scopeKind,
        departmentId: parsed.data.departmentId, projectId: parsed.data.projectId });
      if (!delegation.allowed) throw new ForbiddenError('Privilege delegation exceeds the granted scope');
    }
    return apiSuccess(await createOrganizationService(prisma).setPrivilegeAssignment({ actorId, ...parsed.data }));
  }, true);
}
