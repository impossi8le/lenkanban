import { prisma } from '@/lib/prisma';
import { apiSuccess } from '@/lib/api-response';
import { createOrganizationService } from '@/lib/organization';
import { createOrganizationReader } from '@/lib/organization-reader';
import { ValidationError } from '@/lib/errors';
import { organizationApi, organizationId, organizationJson, organizationQuery, projectApplicantPolicyBody } from '@/lib/organization-api';

export const dynamic = 'force-dynamic';

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return organizationApi(request, '/api/admin/organization/projects/:id/applicants', async actorId => {
    const id = organizationId.safeParse((await context.params).id);
    if (!id.success) throw new ValidationError();
    const params = organizationQuery(request, ['userId']);
    const userId = params.get('userId');
    if (userId !== null && !organizationId.safeParse(userId).success) throw new ValidationError();
    return apiSuccess(await createOrganizationReader(prisma).projectApplicants({ actorId, projectId: id.data,
      ...(userId !== null ? { userId } : {}) }));
  });
}

export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return organizationApi(request, '/api/admin/organization/projects/:id/applicants', async actorId => {
    const id = organizationId.safeParse((await context.params).id);
    if (!id.success) throw new ValidationError();
    // Reject unrelated or duplicate query fields as well as body extras.
    organizationQuery(request, []);
    const parsed = projectApplicantPolicyBody.safeParse(await organizationJson(request));
    if (!parsed.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).setProjectApplicantPolicy({ actorId, projectId: id.data, ...parsed.data }));
  }, true);
}
