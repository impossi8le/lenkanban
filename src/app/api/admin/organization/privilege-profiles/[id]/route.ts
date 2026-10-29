import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { ValidationError } from '@/lib/errors';
import { z } from 'zod';
import { organizationApi, organizationId, organizationJson, organizationQuery, privilegeProfileUpdateBody } from '@/lib/organization-api';

export const dynamic = 'force-dynamic';
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return organizationApi(request, '/api/admin/organization/privilege-profiles/:id', async actorId => {
    const id = organizationId.safeParse((await context.params).id);
    if (!id.success) throw new ValidationError();
    organizationQuery(request, []);
    const parsed = privilegeProfileUpdateBody.extend({ visibility: z.enum(['own', 'board']).optional() }).safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).updatePrivilegeProfile({ actorId, profileId: id.data, ...parsed.data }));
  }, true);
}
