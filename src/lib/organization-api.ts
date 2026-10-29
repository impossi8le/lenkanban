import type { RequestLogContext } from './request-context';
import { apiBadRequest, apiConflict, apiError, apiForbidden, apiInternalError, apiNotFound, apiUnauthorized } from './api-response';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from './errors';
import { requireApiUser } from './require-api-user';
import { withApiLogging } from '@/middleware/api-logger';
import { apiLogger } from './logger';
import { readTelemetryJson, TelemetryHttpError } from './telemetry/http';
import { ORGANIZATION_MAX_VERSION, ORGANIZATION_PRIVILEGE_PERMISSIONS } from './organization-contract';
import { z } from 'zod';
import { requireTrustedMutationOrigin } from './mutation-origin';

export const organizationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const organizationCommandMeta = {
  operationId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(ORGANIZATION_MAX_VERSION),
};
export const departmentCreateBody = z.object({ name: z.string().trim().min(1).max(120), parentId: organizationId.nullable(), ...organizationCommandMeta }).strict();
export const organizationBoardCreateBody = z.object({
  name: z.string().trim().min(1).max(120), departmentId: organizationId,
  responsibleGroupId: organizationId.nullable(), ...organizationCommandMeta,
}).strict();
export const departmentUpdateBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename'), name: z.string().trim().min(1).max(120), ...organizationCommandMeta }).strict(),
  z.object({ kind: z.literal('move'), parentId: organizationId.nullable(), ...organizationCommandMeta }).strict(),
  z.object({ kind: z.literal('archive'), archived: z.boolean(), ...organizationCommandMeta }).strict(),
  z.object({ kind: z.literal('leader'), leaderId: organizationId.nullable(), ...organizationCommandMeta }).strict(),
]);
export const personDepartmentBody = z.object({ departmentId: organizationId.nullable(), ...organizationCommandMeta }).strict();
export const projectBindingBody = z.object({ departmentId: organizationId.nullable(), responsibleGroupId: organizationId.nullable(), ...organizationCommandMeta }).strict();
const applicantPolicy = z.object({
  allEmployees: z.boolean(), userIds: z.array(organizationId).max(20),
  departmentIds: z.array(organizationId).max(20), groupIds: z.array(organizationId).max(20),
}).strict().refine(value => !value.allEmployees || value.userIds.length + value.departmentIds.length + value.groupIds.length === 0);
export const projectApplicantPolicyBody = z.object({ policy: applicantPolicy.nullable(), ...organizationCommandMeta }).strict();
export const globalRoleBody = z.object({ globalRole: z.enum(['USER', 'ADMIN']), ...organizationCommandMeta }).strict();
export const groupCreateBody = z.object({ name: z.string().trim().min(1).max(120), ...organizationCommandMeta }).strict();
export const groupUpdateBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename'), name: z.string().trim().min(1).max(120), ...organizationCommandMeta }).strict(),
  z.object({ kind: z.literal('archive'), archived: z.boolean(), ...organizationCommandMeta }).strict(),
]);
export const groupMemberBody = z.object({ userId: organizationId, member: z.boolean(), ...organizationCommandMeta }).strict();
const privilegeProfileFields = {
  name: z.string().trim().min(1).max(120),
  permissions: z.array(z.enum(ORGANIZATION_PRIVILEGE_PERMISSIONS)).max(ORGANIZATION_PRIVILEGE_PERMISSIONS.length),
};
export const privilegeProfileCreateBody = z.object({ ...privilegeProfileFields, ...organizationCommandMeta }).strict();
export const privilegeProfileUpdateBody = z.object({ ...privilegeProfileFields, archived: z.boolean(), ...organizationCommandMeta }).strict();
export const privilegeAssignmentBody = z.object({
  userId: organizationId, profileId: organizationId,
  scopeKind: z.enum(['organization', 'department', 'board']),
  departmentId: organizationId.nullable(), projectId: organizationId.nullable(), assigned: z.boolean(),
  ...organizationCommandMeta,
}).strict().refine(value => value.scopeKind === 'organization'
  ? value.departmentId === null && value.projectId === null
  : value.scopeKind === 'department' ? value.departmentId !== null && value.projectId === null
    : value.departmentId === null && value.projectId !== null);

export const groupPrivilegeAssignmentBody = z.object({
  groupId: organizationId, profileId: organizationId,
  scopeKind: z.enum(['organization', 'department', 'board']),
  departmentId: organizationId.nullable(), projectId: organizationId.nullable(), assigned: z.boolean(),
  ...organizationCommandMeta,
}).strict().refine(value => value.scopeKind === 'organization'
  ? value.departmentId === null && value.projectId === null
  : value.scopeKind === 'department' ? value.departmentId !== null && value.projectId === null
    : value.departmentId === null && value.projectId !== null);

function noStore(response: Response) { response.headers.set('Cache-Control', 'no-store'); return response; }

/** Reuse the existing bounded16KiB/5s JSON transport reader; no collector/config dependency. */
export async function organizationJson(request: Request): Promise<unknown> { return readTelemetryJson(request); }

export function organizationQuery(request: Request, allowed: readonly string[]): URLSearchParams {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1 || !params.get(key)) throw new ValidationError('Invalid organization query');
  }
  return params;
}
export function organizationLimit(params: URLSearchParams): number {
  const value = params.get('limit');
  if (value === null) return 50;
  if (!/^[0-9]{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new ValidationError('Invalid organization limit');
  return Number(value);
}

export function organizationApi(request: Request, route: string,
  handler: (actorId: string, context: RequestLogContext) => Promise<Response>, mutation = false): Promise<Response> {
  return withApiLogging(request, async (_request, context) => {
    try {
      const actor = await requireApiUser(request);
      context.actorId = actor.id;
      if (actor.globalRole !== 'ADMIN') return noStore(apiForbidden());
      if (mutation) requireTrustedMutationOrigin(request);
      return noStore(await handler(actor.id, context));
    } catch (error) {
      if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
      if (error instanceof ForbiddenError) return noStore(apiForbidden());
      if (error instanceof NotFoundError) return noStore(apiNotFound());
      if (error instanceof ConflictError) return noStore(apiConflict('Organization changed or command conflicts; reload before a new action'));
      if (error instanceof ValidationError) return noStore(apiBadRequest('Invalid organization request'));
      if (error instanceof TelemetryHttpError) return noStore(apiError('INVALID_REQUEST', 'Organization request rejected', undefined, error.status));
      try { apiLogger.error({ ...context, event: 'organization.request.failed', err: error }); }
      catch { /* Never log raw fallback data. */ }
      return noStore(apiInternalError('Organization request failed'));
    }
  }, { route });
}
