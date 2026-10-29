import { Prisma, type Department, type PrismaClient, type OrganizationOperation } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';
import {
  ORGANIZATION_MAX_VERSION, type OrganizationDepartment, type OrganizationDepartmentPage,
  type OrganizationGroup, type OrganizationGroupPage, type OrganizationGroupMemberPage,
  type OrganizationPerson, type OrganizationPeoplePage,
  type OrganizationProject, type OrganizationProjectPage,
  type OrganizationRoleUser, type OrganizationRolePage,
} from './organization-contract';
import { validCorrelationId } from './telemetry-sanitize';
import { decodeOrganizationResult, isOrganizationMethod, organizationResultTarget } from './organization-command';
import { decodeOrganizationApplicantPolicy } from './organization-command';
import { evaluateProjectApplicantPolicy, evaluateLegacyProjectAccess, evaluateProjectAccess, evaluateScopedPrivileges, hasActiveResponsibleGroupMembership, matchesScopedPrivilegeScope, ownTaskProjectIds } from './access-policy';
import { delegationActor, evaluatePrivilegeDelegation, evaluatePrivilegeMatrix } from './organization-access-explanation';
import type { OrganizationProjectApplicants } from './organization-contract';
import type { OrganizationGroupLeadership } from './organization-contract';
import type { OrganizationPrivilegeProfile, OrganizationPrivilegeAssignment, OrganizationPrivilegeProfilePage,
  OrganizationPrivilegeAssignmentPage, OrganizationPrivilegePreview, OrganizationPrivilegePermission,
  OrganizationPrivilegeScope } from './organization-contract';
import { decodePrivilegePermissions, isOrganizationCreateMethod, normalizePrivilegeScope } from './organization-command';
import { loadRoleGrants } from './role-grants';
import type { OrganizationGroupPrivilegeAssignment, OrganizationGroupPrivilegeAssignmentPage } from './organization-contract';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const validVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= ORGANIZATION_MAX_VERSION;
function identifier(value: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new ValidationError('Invalid organization identifier');
  return value;
}
function dto(row: Department): OrganizationDepartment {
  return { id: row.id, name: row.name, parentId: row.parentId, leaderId: row.leaderId, archived: row.archivedAt !== null };
}
function decodeCursor(value: string): Record<string, unknown> {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw Error();
    const result: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error();
    return result as Record<string, unknown>;
  } catch { throw new ValidationError('Invalid organization cursor'); }
}
function encodeCursor(value: object): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

const personSelection = { id: true, name: true, primaryDepartmentId: true } as const;
function personDto(row: { id: string; name: string | null; primaryDepartmentId: string | null }): OrganizationPerson {
  const displayName = typeof row.name === 'string' ? row.name.trim().slice(0, 120) : '';
  return { id: row.id, displayName: displayName || null, primaryDepartmentId: row.primaryDepartmentId };
}
function groupDto(row: { id: string; name: string; archivedAt: Date | null }): OrganizationGroup {
  return { id: row.id, name: row.name, archived: row.archivedAt !== null };
}
function privilegeProfileDto(row: { id: string; name: string; permissions: unknown; archivedAt: Date | null }): OrganizationPrivilegeProfile {
  return decodeOrganizationResult('updatePrivilegeProfile', {
    id: row.id, name: row.name, permissions: row.permissions, archived: row.archivedAt !== null,
  }) as OrganizationPrivilegeProfile;
}
function privilegeAssignmentDto(row: { id: string; userId: string; profileId: string; scopeKind: string;
  departmentId: string | null; projectId: string | null }): OrganizationPrivilegeAssignment {
  return decodeOrganizationResult('setPrivilegeAssignment', { id: row.id, userId: row.userId,
    profileId: row.profileId, scopeKind: row.scopeKind, departmentId: row.departmentId,
    projectId: row.projectId, assigned: true }) as OrganizationPrivilegeAssignment;
}
function groupPrivilegeAssignmentDto(row: { id: string; groupId: string; profileId: string; scopeKind: string;
  departmentId: string | null; projectId: string | null }): OrganizationGroupPrivilegeAssignment {
  return decodeOrganizationResult('setGroupPrivilegeAssignment', { id: row.id, groupId: row.groupId,
    profileId: row.profileId, scopeKind: row.scopeKind, departmentId: row.departmentId,
    projectId: row.projectId, assigned: true }) as OrganizationGroupPrivilegeAssignment;
}
function assignmentNames(row: { profile?: { name?: string }; department?: { name: string } | null; project?: { name: string } | null }) {
  const label = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 120) : undefined;
  return { ...(label(row.profile?.name) ? { profileName: label(row.profile?.name)! } : {}),
    ...(label(row.department?.name) ? { departmentName: label(row.department?.name)! } : {}),
    ...(label(row.project?.name) ? { projectName: label(row.project?.name)! } : {}) };
}
function listLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('Invalid organization list');
  return limit;
}
async function listVersion(tx: Prisma.TransactionClient, cursor: Record<string, unknown> | null): Promise<number> {
  const state = await tx.organizationState.findUnique({ where: { id: 'organization' } });
  const version = state?.version ?? 0;
  if (!validVersion(version)) throw new ConflictError('Invalid organization version');
  if (cursor && cursor.version !== version) throw new ConflictError('Organization changed; reload the list');
  return version;
}

/** Reads share the mutation protocol; version, rows, and role are one snapshot. */
export function createOrganizationReader(database: Pick<PrismaClient, '$transaction'>) {
  const read = <T>(actorId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>) => {
    identifier(actorId);
    return database.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${'organization-topology-v1'}, 0))::text AS locked`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      const actor = await tx.user.findUnique({ where: { id: actorId }, select: { globalRole: true } });
      if (!actor) throw new NotFoundError();
      if (actor.globalRole !== 'ADMIN') throw new ForbiddenError();
      return operation(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  };
  return {
    groupLeadership(input: { actorId: string; groupId: string }): Promise<{ result: OrganizationGroupLeadership; version: number }> {
      const groupId = identifier(input.groupId);
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, null);
        const row = await tx.responsibleGroup.findUnique({ where: { id: groupId }, select: { id: true, leaderId: true } });
        if (!row) throw new NotFoundError();
        const result = decodeOrganizationResult('setGroupLeader', row) as OrganizationGroupLeadership;
        return { result, version };
      });
    },
    privilegeProfiles(input: { actorId: string; archived?: 'all' | 'active' | 'archived'; cursor?: string; limit?: number }): Promise<OrganizationPrivilegeProfilePage> {
      const archived = input.archived ?? 'all', limit = listLimit(input.limit);
      if (!['all', 'active', 'archived'].includes(archived)) throw new ValidationError('Invalid organization list');
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'archived,id,kind,version'
        || cursor.kind !== 'privilegeProfiles' || cursor.archived !== archived
        || typeof cursor.id !== 'string' || !idPattern.test(cursor.id) || !validVersion(cursor.version))) {
        throw new ValidationError('Invalid organization cursor');
      }
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        const rows = await tx.privilegeProfile.findMany({ where: {
          ...(archived === 'active' ? { archivedAt: null } : archived === 'archived' ? { archivedAt: { not: null } } : {}),
          ...(cursor ? { id: { gt: cursor.id as string } } : {}),
        }, select: { id: true, name: true, permissions: true, archivedAt: true }, orderBy: { id: 'asc' }, take: limit + 1 });
        const items = rows.slice(0, limit).map(privilegeProfileDto), last = items.at(-1);
        return { items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'privilegeProfiles', id: last.id, archived, version }) : null };
      });
    },
    privilegeAssignments(input: { actorId: string; userId: string; cursor?: string; limit?: number }): Promise<OrganizationPrivilegeAssignmentPage> {
      const userId = identifier(input.userId), limit = listLimit(input.limit);
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'id,kind,userId,version'
        || cursor.kind !== 'privilegeAssignments' || cursor.userId !== userId
        || typeof cursor.id !== 'string' || !idPattern.test(cursor.id) || !validVersion(cursor.version))) {
        throw new ValidationError('Invalid organization cursor');
      }
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        if (!await tx.user.findUnique({ where: { id: userId }, select: { id: true } })) throw new NotFoundError();
        const rows = await tx.scopedPrivilegeAssignment.findMany({ where: { userId,
          ...(cursor ? { id: { gt: cursor.id as string } } : {}) },
          select: { id: true, userId: true, profileId: true, scopeKind: true, departmentId: true, projectId: true,
            profile: { select: { name: true } }, department: { select: { name: true } }, project: { select: { name: true } } },
          orderBy: { id: 'asc' }, take: limit + 1 });
        const items = rows.slice(0, limit).map(row => ({ ...privilegeAssignmentDto(row), ...assignmentNames(row) })), last = items.at(-1);
        return { items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'privilegeAssignments', id: last.id, userId, version }) : null };
      });
    },
    groupPrivilegeAssignments(input: { actorId: string; groupId: string; cursor?: string; limit?: number }): Promise<OrganizationGroupPrivilegeAssignmentPage> {
      const groupId = identifier(input.groupId), limit = listLimit(input.limit);
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'groupId,id,kind,version'
        || cursor.kind !== 'groupPrivilegeAssignments' || cursor.groupId !== groupId
        || typeof cursor.id !== 'string' || !idPattern.test(cursor.id) || !validVersion(cursor.version))) {
        throw new ValidationError('Invalid organization cursor');
      }
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        if (!await tx.responsibleGroup.findUnique({ where: { id: groupId }, select: { id: true } })) throw new NotFoundError();
        const rows = await tx.groupPrivilegeAssignment.findMany({ where: { groupId,
          ...(cursor ? { id: { gt: cursor.id as string } } : {}) },
          select: { id: true, groupId: true, profileId: true, scopeKind: true, departmentId: true, projectId: true,
            profile: { select: { name: true } }, department: { select: { name: true } }, project: { select: { name: true } } },
          orderBy: { id: 'asc' }, take: limit + 1 });
        const items = rows.slice(0, limit).map(row => ({ ...groupPrivilegeAssignmentDto(row), ...assignmentNames(row) })), last = items.at(-1);
        return { items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'groupPrivilegeAssignments', id: last.id, groupId, version }) : null };
      });
    },
    privilegePreview(input: { actorId: string; userId: string; projectId: string }): Promise<OrganizationPrivilegePreview> {
      const userId = identifier(input.userId), projectId = identifier(input.projectId);
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, null);
        const user = await tx.user.findUnique({ where: { id: userId }, select: {
          id: true, name: true, globalRole: true, primaryDepartment: { select: { id: true, archivedAt: true } },
        } });
        if (!user) throw new NotFoundError();
        const project = await tx.project.findUnique({ where: { id: projectId }, select: {
          id: true, name: true, ownerId: true, departmentId: true,
          department: { select: { id: true, archivedAt: true } },
          members: { where: { userId }, select: { role: true }, take: 1 },
          responsibleGroup: { select: { archivedAt: true, members: { where: { userId }, select: { userId: true }, take: 1 } } },
          applicantPolicyConfig: { select: { policy: true } },
        } });
        if (!project) throw new NotFoundError();
        if (project.applicantPolicyConfig?.policy === null) throw new ConflictError('Invalid saved project applicant policy');
        const policy = project.applicantPolicyConfig === null ? null : decodeOrganizationApplicantPolicy(project.applicantPolicyConfig.policy);
        const grants = await loadRoleGrants(tx, [userId], { explain: true });
        const memberships = policy === null || policy.groupIds.length === 0 ? []
          : await tx.responsibleGroupMember.findMany({ where: { userId, groupId: { in: policy.groupIds }, group: { archivedAt: null } },
            select: { groupId: true }, take: 20 });
        const legacy = evaluateLegacyProjectAccess(user, { ownerId: project.ownerId, membershipRole: project.members[0]?.role ?? null });
        const ownBoard = ownTaskProjectIds(process.env.LENKANBAN_OWN_TASK_PROJECT_IDS).includes(projectId);
        const activeDepartmentId = project.department?.archivedAt === null ? project.department.id : null;
        const scoped = evaluateScopedPrivileges({ globalAdmin: user.globalRole === 'ADMIN', projectId, activeDepartmentId }, grants);
        return {
          project: { id: project.id, displayName: project.name.trim().slice(0, 120) || null, departmentId: project.departmentId },
          subject: { id: user.id, displayName: user.name?.trim().slice(0, 120) || null },
          legacy: { canRead: legacy.canRead.allowed, canWrite: legacy.canWrite.allowed, canManageMembers: legacy.canManageMembers.allowed },
          applicant: evaluateProjectApplicantPolicy(policy, { userId,
            activePrimaryDepartmentId: user.primaryDepartment?.archivedAt === null ? user.primaryDepartment.id : null,
            activeGroupIds: memberships.map(membership => membership.groupId) }),
          scoped,
          effective: {
            project: evaluateProjectAccess(user, { ownerId: project.ownerId, membershipRole: project.members[0]?.role ?? null }, ownBoard,
              hasActiveResponsibleGroupMembership(project.responsibleGroup, userId)),
            taskReadPolicy: 'personal_or_executor',
            scopedRequestReadApplied: false,
            taskAndDiscussionAccess: 'requires_resource_check',
            matrix: evaluatePrivilegeMatrix({ globalAdmin: user.globalRole === 'ADMIN', projectId, activeDepartmentId }, grants),
            assignmentSources: grants.map(grant => ({
              source: grant.source, groupId: grant.groupId,
              assignmentId: grant.id, profileId: grant.profileId, scopeKind: grant.scopeKind,
              departmentId: grant.departmentId, projectId: grant.projectId, permissions: [...grant.permissions],
              reason: grant.profileArchived ? 'profile_archived' as const
                : matchesScopedPrivilegeScope({ projectId, activeDepartmentId }, grant)
                  ? 'matching' as const : 'outside_scope' as const,
            })),
          },
          version,
        };
      });
    },
    /** Server-side delegation bound for one prospective assignment. It never
     * creates a grant: it only proves the actor already holds the profile's
     * permissions inside the requested scope. Global ADMIN is unrestricted. */
    privilegeDelegationCheck(input: { actorId: string; profileId: string; scopeKind: OrganizationPrivilegeScope;
      departmentId: string | null; projectId: string | null }): Promise<{
        allowed: boolean; reason: 'allowed' | 'not_admin' | 'missing_grant_permission' | 'exceeds_permissions' | 'outside_scope';
        deniedPermissions: readonly OrganizationPrivilegePermission[];
      }> {
      const profileId = identifier(input.profileId);
      const scope = normalizePrivilegeScope(input.scopeKind, input.departmentId, input.projectId);
      return read(input.actorId, async tx => {
        const profile = await tx.privilegeProfile.findUnique({ where: { id: profileId },
          select: { id: true, permissions: true, archivedAt: true } });
        if (!profile) throw new NotFoundError();
        const requested = decodePrivilegePermissions(profile.permissions);
        const actor = await tx.user.findUnique({ where: { id: input.actorId }, select: { globalRole: true } });
        if (!actor) throw new NotFoundError();
        const grants = await loadRoleGrants(tx, [input.actorId], { explain: true });
        const globalAdmin = actor.globalRole === 'ADMIN';
        const effective = evaluatePrivilegeMatrix({ globalAdmin,
          projectId: scope.projectId ?? '', activeDepartmentId: scope.departmentId }, grants);
        const permissions = effective.actions.filter(action => action.allowed).map(action => action.action);
        return evaluatePrivilegeDelegation(delegationActor(globalAdmin, permissions, grants), scope, requested);
      });
    },
    projectApplicants(input: { actorId: string; projectId: string; userId?: string }): Promise<OrganizationProjectApplicants> {
      const projectId = identifier(input.projectId);
      const userId = input.userId === undefined ? undefined : identifier(input.userId);
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, null);
        const project = await tx.project.findUnique({ where: { id: projectId },
          select: { id: true, name: true, applicantPolicyConfig: { select: { policy: true } } } });
        if (!project) throw new NotFoundError();
        if (project.applicantPolicyConfig?.policy === null) throw new ConflictError('Invalid saved project applicant policy');
        const policy = project.applicantPolicyConfig === null ? null
          : decodeOrganizationApplicantPolicy(project.applicantPolicyConfig.policy);
        let preview: OrganizationProjectApplicants['preview'] = null;
        if (userId !== undefined) {
          const user = await tx.user.findUnique({ where: { id: userId }, select: {
            id: true, primaryDepartment: { select: { id: true, archivedAt: true } },
          } });
          if (!user) throw new NotFoundError();
          const memberships = policy === null || policy.groupIds.length === 0 ? []
            : await tx.responsibleGroupMember.findMany({ where: { userId, groupId: { in: policy.groupIds }, group: { archivedAt: null } },
              select: { groupId: true }, take: 20 });
          preview = { userId, ...evaluateProjectApplicantPolicy(policy, {
            userId, activePrimaryDepartmentId: user.primaryDepartment?.archivedAt === null ? user.primaryDepartment.id : null,
            activeGroupIds: memberships.map(membership => membership.groupId),
          }) };
        }
        return { project: { id: project.id, displayName: project.name.trim().slice(0, 120) || null }, policy, preview, version };
      });
    },
    roles(input: { actorId: string; q?: string; cursor?: string; limit?: number }): Promise<OrganizationRolePage> {
      if (input.q !== undefined && typeof input.q !== 'string') throw new ValidationError('Invalid organization search');
      const q = (input.q ?? '').trim().toLowerCase();
      if (q.length > 128) throw new ValidationError('Invalid organization search');
      const limit = listLimit(input.limit);
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'id,kind,q,version'
        || cursor.kind !== 'roles' || cursor.q !== q || typeof cursor.id !== 'string'
        || !idPattern.test(cursor.id) || !validVersion(cursor.version))) throw new ValidationError('Invalid organization cursor');
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        const rows = await tx.user.findMany({
          where: {
            ...(q ? { OR: [ { name: { contains: q, mode: 'insensitive' as const } }, { id: { contains: q, mode: 'insensitive' as const } } ] } : {}),
            ...(cursor ? { id: { gt: cursor.id as string } } : {}),
          },
          select: { id: true, name: true, globalRole: true }, orderBy: { id: 'asc' }, take: limit + 1,
        });
        const items: OrganizationRoleUser[] = rows.slice(0, limit).map(row => ({ id: row.id,
          displayName: row.name?.trim().slice(0, 120) || null, globalRole: row.globalRole }));
        const last = items.at(-1);
        return { items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'roles', id: last.id, q, version }) : null };
      });
    },
    projects(input: {
      actorId: string; q?: string; cursor?: string; limit?: number;
    }): Promise<OrganizationProjectPage> {
      if (input.q !== undefined && typeof input.q !== 'string') throw new ValidationError('Invalid organization search');
      const q = (input.q ?? '').trim().toLowerCase();
      if (q.length > 128) throw new ValidationError('Invalid organization search');
      const limit = listLimit(input.limit);
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'id,kind,q,version'
        || cursor.kind !== 'projects' || cursor.q !== q
        || typeof cursor.id !== 'string' || !idPattern.test(cursor.id) || !validVersion(cursor.version))) {
        throw new ValidationError('Invalid organization cursor');
      }
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        const rows = await tx.project.findMany({
          where: {
            ...(q ? { OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { id: { contains: q, mode: 'insensitive' as const } },
            ] } : {}),
            ...(cursor ? { id: { gt: cursor.id as string } } : {}),
          },
          select: { id: true, name: true, departmentId: true, responsibleGroupId: true },
          orderBy: { id: 'asc' }, take: limit + 1,
        });
        const items: OrganizationProject[] = rows.slice(0, limit).map(row => ({
          id: row.id, displayName: row.name.trim().slice(0, 120) || null,
          departmentId: row.departmentId, responsibleGroupId: row.responsibleGroupId,
        }));
        const last = items.at(-1);
        return { items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'projects', id: last.id, q, version }) : null };
      });
    },
    groups(input: {
      actorId: string; archived?: 'all' | 'active' | 'archived'; cursor?: string; limit?: number;
    }): Promise<OrganizationGroupPage> {
      const archived = input.archived ?? 'all';
      if (!['all', 'active', 'archived'].includes(archived)) throw new ValidationError('Invalid organization list');
      const limit = listLimit(input.limit);
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'archived,id,kind,version'
        || cursor.kind !== 'groups' || typeof cursor.id !== 'string' || !idPattern.test(cursor.id)
        || cursor.archived !== archived || !validVersion(cursor.version))) {
        throw new ValidationError('Invalid organization cursor');
      }
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        const rows = await tx.responsibleGroup.findMany({
          where: {
            ...(archived === 'active' ? { archivedAt: null } : archived === 'archived' ? { archivedAt: { not: null } } : {}),
            ...(cursor ? { id: { gt: cursor.id as string } } : {}),
          },
          select: { id: true, name: true, archivedAt: true },
          orderBy: { id: 'asc' }, take: limit + 1,
        });
        const items = rows.slice(0, limit).map(groupDto);
        const last = items.at(-1);
        return { items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'groups', id: last.id, archived, version }) : null };
      });
    },
    members(input: {
      actorId: string; groupId: string; cursor?: string; limit?: number;
    }): Promise<OrganizationGroupMemberPage> {
      const groupId = identifier(input.groupId);
      const limit = listLimit(input.limit);
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'groupId,id,kind,version'
        || cursor.kind !== 'members' || cursor.groupId !== groupId
        || typeof cursor.id !== 'string' || !idPattern.test(cursor.id) || !validVersion(cursor.version))) {
        throw new ValidationError('Invalid organization cursor');
      }
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        const group = await tx.responsibleGroup.findUnique({ where: { id: groupId },
          select: { id: true, name: true, archivedAt: true } });
        if (!group) throw new NotFoundError();
        const rows = await tx.responsibleGroupMember.findMany({
          where: { groupId, ...(cursor ? { userId: { gt: cursor.id as string } } : {}) },
          orderBy: { userId: 'asc' }, take: limit + 1,
          include: { user: { select: personSelection } },
        });
        const items = rows.slice(0, limit).map(row => personDto(row.user));
        const last = items.at(-1);
        return { group: groupDto(group), items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'members', id: last.id, groupId, version }) : null };
      });
    },
    people(input: {
      actorId: string; q?: string; cursor?: string; limit?: number;
    }): Promise<OrganizationPeoplePage> {
      if (input.q !== undefined && typeof input.q !== 'string') throw new ValidationError('Invalid organization search');
      const q = (input.q ?? '').trim().toLowerCase();
      if (q.length > 128) throw new ValidationError('Invalid organization search');
      const limit = listLimit(input.limit);
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'id,kind,q,version'
        || cursor.kind !== 'people' || cursor.q !== q
        || typeof cursor.id !== 'string' || !idPattern.test(cursor.id) || !validVersion(cursor.version))) {
        throw new ValidationError('Invalid organization cursor');
      }
      return read(input.actorId, async tx => {
        const version = await listVersion(tx, cursor);
        const rows = await tx.user.findMany({
          where: {
            ...(q ? { OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { id: { contains: q, mode: 'insensitive' as const } },
            ] } : {}),
            ...(cursor ? { id: { gt: cursor.id as string } } : {}),
          },
          select: personSelection, orderBy: { id: 'asc' }, take: limit + 1,
        });
        const items = rows.slice(0, limit).map(personDto);
        const last = items.at(-1);
        return { items, version, nextCursor: rows.length > limit && last
          ? encodeCursor({ kind: 'people', id: last.id, q, version }) : null };
      });
    },
    departments(input: { actorId: string; parentId?: string | null; archived?: 'all' | 'active' | 'archived'; cursor?: string; limit?: number }): Promise<OrganizationDepartmentPage> {
      const parentId = input.parentId == null ? null : identifier(input.parentId);
      const archived = input.archived ?? 'all';
      const limit = input.limit ?? 50;
      if (!['all', 'active', 'archived'].includes(archived) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('Invalid organization list');
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'archived,id,parentId,version' || typeof cursor.id !== 'string' || !idPattern.test(cursor.id)
        || cursor.parentId !== parentId || cursor.archived !== archived || !validVersion(cursor.version))) throw new ValidationError('Invalid organization cursor');
      return read(input.actorId, async tx => {
        const state = await tx.organizationState.findUnique({ where: { id: 'organization' } });
        const version = state?.version ?? 0;
        if (!validVersion(version)) throw new ConflictError('Invalid organization version');
        if (cursor && cursor.version !== version) throw new ConflictError('Organization changed; reload the list');
        const parent = parentId === null ? null : await tx.department.findUnique({ where: { id: parentId } });
        if (parentId !== null && !parent) throw new NotFoundError();
        const rows = await tx.department.findMany({ where: { parentId,
          ...(archived === 'active' ? { archivedAt: null } : archived === 'archived' ? { archivedAt: { not: null } } : {}),
          ...(cursor ? { id: { gt: cursor.id as string } } : {}) }, orderBy: { id: 'asc' }, take: limit + 1 });
        const items = rows.slice(0, limit).map(dto);
        const last = items.at(-1);
        return { items, parent: parent ? dto(parent) : null, version,
          nextCursor: rows.length > limit && last ? encodeCursor({ id: last.id, parentId, archived, version }) : null };
      });
    },
    history(input: { actorId: string; targetId?: string; cursor?: string; limit?: number }) {
      const targetId = input.targetId === undefined ? undefined : identifier(input.targetId);
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('Invalid organization history limit');
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (cursor && (Object.keys(cursor).sort().join(',') !== 'id,targetId,time' || cursor.targetId !== (targetId ?? null)
        || typeof cursor.id !== 'string' || !idPattern.test(cursor.id) || typeof cursor.time !== 'string'
        || !Number.isFinite(Date.parse(cursor.time)) || new Date(cursor.time).toISOString() !== cursor.time)) throw new ValidationError('Invalid organization history cursor');
      return read(input.actorId, async tx => {
        const rows = await tx.organizationOperation.findMany({ where: {
          ...(targetId ? { targetKind: 'department', targetId } : {}),
          ...(cursor ? { OR: [{ committedAt: { lt: new Date(cursor.time as string) } },
            { committedAt: new Date(cursor.time as string), id: { lt: cursor.id as string } }] } : {}) },
          orderBy: [{ committedAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
        const scanned = rows.slice(0, limit);
        const last = scanned.at(-1);
        return { items: scanned.map(safeOrganizationHistory).filter(row => row !== null),
          nextCursor: rows.length > limit && last ? encodeCursor({ id: last.id, time: last.committedAt.toISOString(), targetId: targetId ?? null }) : null };
      });
    },
  };
}

export function safeOrganizationHistory(row: OrganizationOperation) {
  try {
    if (!isOrganizationMethod(row.operation) || !idPattern.test(row.id) || !idPattern.test(row.actorId)
      || !validCorrelationId(row.operationId) || !idPattern.test(row.targetId) || !validVersion(row.expectedVersion)
      || !validVersion(row.committedVersion) || typeof row.changed !== 'boolean' || !Number.isFinite(row.committedAt.getTime())) return null;
    const result = decodeOrganizationResult(row.operation, row.after);
    const creates = isOrganizationCreateMethod(row.operation);
    if (creates !== (row.before === null)) return null;
    const before = row.before === null && creates
      ? null : decodeOrganizationResult(row.operation, row.before);
    const targetKind = row.operation === 'setGroupPrivilegeAssignment' ? 'groupPrivilegeAssignment'
      : row.operation === 'setPrivilegeAssignment' ? 'privilegeAssignment'
      : row.operation === 'createPrivilegeProfile' || row.operation === 'updatePrivilegeProfile' ? 'profile'
      : row.operation.includes('Department') && row.operation !== 'assignUserDepartment' ? 'department'
      : row.operation.includes('Group') ? 'group' : row.operation === 'assignUserDepartment' || row.operation === 'setGlobalRole' ? 'user' : 'project';
    if (row.targetKind !== targetKind || organizationResultTarget(result) !== row.targetId
      || (before !== null && organizationResultTarget(before) !== row.targetId)
      || (before !== null && 'member' in before && 'member' in result && before.userId !== result.userId)
      || row.changed === (JSON.stringify(before) === JSON.stringify(result))
      || row.committedVersion !== row.expectedVersion + (row.changed ? 1 : 0)) return null;
    return { id: row.id, actorId: row.actorId, operationId: row.operationId, operation: row.operation,
      targetKind, targetId: row.targetId, version: row.committedVersion, changed: row.changed,
      before, after: result, committedAt: row.committedAt.toISOString() };
  } catch { return null; }
}
