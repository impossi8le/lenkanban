import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { createOrganizationReader } from '@/lib/organization-reader';
import { ValidationError } from '@/lib/errors';
import { organizationApi, organizationId, organizationJson, organizationQuery, organizationCommandMeta } from '@/lib/organization-api';

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ ...organizationCommandMeta, userId: organizationId.nullable() }).strict();
export function GET(request: Request, context: Context) {
  return organizationApi(request, '/api/admin/organization/groups/:id/leader', async actorId => {
    organizationQuery(request, []);
    const id = organizationId.safeParse((await context.params).id);
    if (!id.success) throw new ValidationError();
    return apiSuccess(await createOrganizationReader(prisma).groupLeadership({ actorId, groupId: id.data }));
  });
}
export function PUT(request: Request, context: Context) {
  return organizationApi(request, '/api/admin/organization/groups/:id/leader', async actorId => {
    organizationQuery(request, []);
    const id = organizationId.safeParse((await context.params).id);
    if (!id.success) throw new ValidationError();
    const body = schema.safeParse(await organizationJson(request));
    if (!body.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).setGroupLeader({ actorId, groupId: id.data, ...body.data }));
  }, true);
}
