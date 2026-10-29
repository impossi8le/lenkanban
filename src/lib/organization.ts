import { randomUUID } from "node:crypto";
import { Prisma, type Department, type PrismaClient, type ResponsibleGroup } from "@prisma/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { OrganizationDepartment, OrganizationGroup, OrganizationMutation, OrganizationGlobalRole } from "./organization-contract";
import type { OrganizationApplicantPolicy } from "./organization-contract";
import type { OrganizationGroupLeadership } from "./organization-contract";
import type { OrganizationGroupPrivilegeAssignment } from "./organization-contract";
import type { OrganizationPrivilegePermission, OrganizationPrivilegeProfile, OrganizationPrivilegeAssignment, OrganizationPrivilegeScope } from "./organization-contract";
import { emitAuthRevoked } from "@/socket/board-events";
import { DEFAULT_BOARD_COLUMNS } from "@/lib/request-board-columns";
import { decodeLifecycleColumnMap, lifecycleColumnFields, validateLifecycleColumnTargets, type LifecycleColumnMap } from "./task-request-columns";
import type { OrganizationProjectLifecycleColumns } from "./organization-command";
import type { OrganizationCreatedBoard } from "./organization-command";
import { decodeOrganizationApplicantPolicy, normalizeOrganizationApplicantPolicy, type OrganizationProjectApplicantPolicy } from "./organization-command";
import { decodePrivilegePermissions, decodePrivilegeProfileSettings, encodePrivilegeProfileSettings, normalizePrivilegeVisibility, normalizePrivilegePermissions, normalizePrivilegeScope, privilegeAssignmentId, groupPrivilegeAssignmentId, isOrganizationCreateMethod } from "./organization-command";
import {
  decodeOrganizationResult, normalizeOrganizationActor, ORGANIZATION_MAX_VERSION, ORGANIZATION_STATE_ID,
  organizationBoolean, organizationId, organizationName, organizationNullableId, organizationRequestHash,
  organizationResultTarget, organizationVersion, organizationGlobalRole,
  type OrganizationCommandActor, type OrganizationGroupMembership, type OrganizationMethod,
  type OrganizationProjectBinding, type OrganizationResult, type OrganizationTargetKind, type OrganizationUserDepartment, type OrganizationUserGlobalRole,
} from "./organization-command";

export type { OrganizationDepartment, OrganizationGroup, OrganizationMutation } from "./organization-contract";
type Actor = OrganizationCommandActor;
type DepartmentIdentity = Actor & { departmentId: string };
type GroupIdentity = Actor & { groupId: string };

export interface OrganizationService {
  setProjectLifecycleColumns(input: Actor & { projectId: string; lifecycleColumnMap: LifecycleColumnMap | null }): Promise<OrganizationMutation<OrganizationProjectLifecycleColumns>>;
  createBoard(input: Actor & { name: string; departmentId: string; responsibleGroupId: string | null }): Promise<OrganizationMutation<OrganizationCreatedBoard>>;
  createDepartment(input: Actor & { name: string; parentId?: string | null }): Promise<OrganizationMutation<OrganizationDepartment>>;
  renameDepartment(input: DepartmentIdentity & { name: string }): Promise<OrganizationMutation<OrganizationDepartment>>;
  moveDepartment(input: DepartmentIdentity & { parentId: string | null }): Promise<OrganizationMutation<OrganizationDepartment>>;
  setDepartmentArchived(input: DepartmentIdentity & { archived: boolean }): Promise<OrganizationMutation<OrganizationDepartment>>;
  setDepartmentLeader(input: DepartmentIdentity & { userId: string | null }): Promise<OrganizationMutation<OrganizationDepartment>>;
  assignUserDepartment(input: Actor & { userId: string; departmentId: string | null }): Promise<OrganizationMutation<OrganizationUserDepartment>>;
  createGroup(input: Actor & { name: string }): Promise<OrganizationMutation<OrganizationGroup>>;
  renameGroup(input: GroupIdentity & { name: string }): Promise<OrganizationMutation<OrganizationGroup>>;
  setGroupArchived(input: GroupIdentity & { archived: boolean }): Promise<OrganizationMutation<OrganizationGroup>>;
  setGroupMember(input: GroupIdentity & { userId: string; member: boolean }): Promise<OrganizationMutation<OrganizationGroupMembership>>;
  setGroupLeader(input: GroupIdentity & { userId: string | null }): Promise<OrganizationMutation<OrganizationGroupLeadership>>;
  bindProject(input: Actor & { projectId: string; departmentId: string | null; responsibleGroupId: string | null }): Promise<OrganizationMutation<OrganizationProjectBinding>>;
  setGlobalRole(input: Actor & { userId: string; globalRole: OrganizationGlobalRole }): Promise<OrganizationMutation<OrganizationUserGlobalRole>>;
  setProjectApplicantPolicy(input: Actor & { projectId: string; policy: OrganizationApplicantPolicy | null }): Promise<OrganizationMutation<OrganizationProjectApplicantPolicy>>;
  createPrivilegeProfile(input: Actor & { name: string; permissions: readonly OrganizationPrivilegePermission[]; visibility?: 'own' | 'board' }): Promise<OrganizationMutation<OrganizationPrivilegeProfile>>;
  updatePrivilegeProfile(input: Actor & { profileId: string; name: string; permissions: readonly OrganizationPrivilegePermission[]; archived: boolean; visibility?: 'own' | 'board' }): Promise<OrganizationMutation<OrganizationPrivilegeProfile>>;
  setPrivilegeAssignment(input: Actor & { userId: string; profileId: string; scopeKind: OrganizationPrivilegeScope;
    departmentId: string | null; projectId: string | null; assigned: boolean }): Promise<OrganizationMutation<OrganizationPrivilegeAssignment>>;
  setGroupPrivilegeAssignment(input: Actor & { groupId: string; profileId: string; scopeKind: OrganizationPrivilegeScope;
    departmentId: string | null; projectId: string | null; assigned: boolean }): Promise<OrganizationMutation<OrganizationGroupPrivilegeAssignment>>;
}

type MutationPlan<T extends OrganizationResult> = {
  before: T | null;
} & ({ changed: true; write: () => Promise<T> } | { changed: false; result: T });

function departmentDto(row: Department): OrganizationDepartment {
  return { id: row.id, name: row.name, parentId: row.parentId, leaderId: row.leaderId, archived: row.archivedAt !== null };
}
function groupDto(row: ResponsibleGroup): OrganizationGroup {
  return { id: row.id, name: row.name, archived: row.archivedAt !== null };
}
async function department(tx: Prisma.TransactionClient, id: string): Promise<Department> {
  const row = await tx.department.findUnique({ where: { id } });
  if (!row) throw new NotFoundError();
  return row;
}
async function group(tx: Prisma.TransactionClient, id: string): Promise<ResponsibleGroup> {
  const row = await tx.responsibleGroup.findUnique({ where: { id } });
  if (!row) throw new NotFoundError();
  return row;
}
function requireActive(row: { archivedAt: Date | null }): void {
  if (row.archivedAt !== null) throw new ConflictError("Organization resource is archived");
}
async function requireUser(tx: Prisma.TransactionClient, id: string): Promise<void> {
  if (!await tx.user.findUnique({ where: { id }, select: { id: true } })) throw new NotFoundError();
}

/** Bounded ancestry inspection happens only after the common topology lock. */
async function inspectAncestry(
  tx: Prisma.TransactionClient, startId: string | null, options: { forbiddenId?: string; active?: boolean } = {},
): Promise<void> {
  const seen = new Set<string>();
  let cursor = startId;
  while (cursor !== null) {
    if (cursor === options.forbiddenId || seen.has(cursor) || seen.size >= 1000) {
      throw new ConflictError("Invalid department hierarchy");
    }
    seen.add(cursor);
    const row = await department(tx, cursor);
    if (options.active) requireActive(row);
    cursor = row.parentId;
  }
}

function resultMatchesCommand(
  method: OrganizationMethod, targetId: string | null, payload: Prisma.InputJsonObject, result: OrganizationResult,
): boolean {
  if (targetId !== null && organizationResultTarget(result) !== targetId) return false;
  switch (method) {
    case "createBoard":
      return "responsibleGroupId" in result && result.departmentId === payload.departmentId
        && result.responsibleGroupId === payload.responsibleGroupId;
    case "createDepartment":
      return "parentId" in result && result.name === payload.name && result.parentId === payload.parentId
        && result.leaderId === null && !result.archived;
    case "renameDepartment":
    case "renameGroup":
      return "name" in result && result.name === payload.name;
    case "moveDepartment":
      return "parentId" in result && result.parentId === payload.parentId;
    case "setDepartmentArchived":
    case "setGroupArchived":
      return "archived" in result && result.archived === payload.archived;
    case "setDepartmentLeader":
    case "setGroupLeader":
      return "leaderId" in result && result.leaderId === payload.userId;
    case "assignUserDepartment":
      return "primaryDepartmentId" in result && result.primaryDepartmentId === payload.departmentId;
    case "createGroup":
      return "archived" in result && "name" in result && result.name === payload.name && !result.archived;
    case "setGroupMember":
      return "member" in result && result.userId === payload.userId && result.member === payload.member;
    case "bindProject":
      return "responsibleGroupId" in result && result.departmentId === payload.departmentId
        && result.responsibleGroupId === payload.responsibleGroupId;
    case "setGlobalRole":
      return "globalRole" in result && result.globalRole === payload.globalRole;
    case "setProjectApplicantPolicy":
      return "policy" in result && JSON.stringify(result.policy) === JSON.stringify(payload.policy);
    case "setProjectLifecycleColumns":
      return "lifecycleColumnMap" in result && JSON.stringify(result.lifecycleColumnMap) === JSON.stringify(payload.lifecycleColumnMap);
    case "createPrivilegeProfile":
    case "updatePrivilegeProfile":
      return "permissions" in result && result.name === payload.name
        && JSON.stringify(result.permissions) === JSON.stringify(payload.permissions)
        && result.visibility === (payload.visibility ?? 'board')
        && result.archived === (method === "createPrivilegeProfile" ? false : payload.archived);
    case "setPrivilegeAssignment":
      return "assigned" in result && "userId" in result && result.userId === payload.userId && result.profileId === payload.profileId
        && result.scopeKind === payload.scopeKind && result.departmentId === payload.departmentId
        && result.projectId === payload.projectId && result.assigned === payload.assigned;
    case "setGroupPrivilegeAssignment":
      return "assigned" in result && "groupId" in result && result.groupId === payload.groupId && result.profileId === payload.profileId
        && result.scopeKind === payload.scopeKind && result.departmentId === payload.departmentId
        && result.projectId === payload.projectId && result.assigned === payload.assigned;
  }
}

/** Mandatory versioned commands and durable receipts; no unaudited mutation
 * path, global database fallback, project grants or network side effects. */
export function createOrganizationService(database: Pick<PrismaClient, "$transaction">): OrganizationService {
  const mutate = <T extends OrganizationResult>(
    rawActor: Actor, method: OrganizationMethod, targetKind: OrganizationTargetKind,
    targetId: string | null, payload: Prisma.InputJsonObject,
    prepare: (tx: Prisma.TransactionClient) => Promise<MutationPlan<T>>,
  ): Promise<OrganizationMutation<T>> => {
    const actor = normalizeOrganizationActor(rawActor);
    const requestHash = organizationRequestHash(method, targetId, payload, actor.expectedVersion);
    const decode = (value: unknown): T => decodeOrganizationResult(method, value) as T;
    const revokedUserIds = new Set<string>();
    return database.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"organization-topology-v1"}, 0))::text AS locked`;
      // Match lifecycle Project→User ordering before fresh authorization/replay.
      if (method === "setProjectLifecycleColumns") {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${targetId} FOR UPDATE`;
      }
      if (method === "setGroupPrivilegeAssignment" && typeof payload.projectId === 'string') {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${payload.projectId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.actorId} FOR SHARE`;
      const current = await tx.user.findUnique({ where: { id: actor.actorId }, select: { id: true, globalRole: true } });
      if (!current) throw new NotFoundError();
      if (current.globalRole !== "ADMIN") throw new ForbiddenError();

      const receipt = await tx.organizationOperation.findUnique({
        where: { actorId_operationId: { actorId: actor.actorId, operationId: actor.operationId } },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw new ConflictError("Organization operation ID already used");
        const result = decode(receipt.result);
        const after = decode(receipt.after);
        const creates = isOrganizationCreateMethod(method);
        const before = receipt.before === null ? null : decode(receipt.before);
        const sameSnapshot = (a: OrganizationResult | null, b: OrganizationResult) => JSON.stringify(a) === JSON.stringify(b);
        const validVersion = Number.isInteger(receipt.committedVersion) && receipt.committedVersion >= 0
          && receipt.committedVersion <= ORGANIZATION_MAX_VERSION
          && receipt.committedVersion === actor.expectedVersion + (receipt.changed ? 1 : 0);
        if (receipt.actorId !== actor.actorId || receipt.operationId !== actor.operationId
          || receipt.operation !== method || receipt.targetKind !== targetKind
          || receipt.targetId !== organizationResultTarget(result) || receipt.expectedVersion !== actor.expectedVersion
          || typeof receipt.changed !== "boolean" || !validVersion
          || !sameSnapshot(after, result) || creates !== (before === null)
          || (before !== null && organizationResultTarget(before) !== receipt.targetId)
          || ("member" in result && before !== null && (!('member' in before) || before.userId !== result.userId))
          || receipt.changed === sameSnapshot(before, result)
          || !resultMatchesCommand(method, targetId, payload, result)) {
          throw new ConflictError("Invalid saved organization operation");
        }
        // Return the historical command result, never reapply over later edits.
        return { result, version: receipt.committedVersion, replayed: true };
      }

      const state = await tx.organizationState.upsert({
        where: { id: ORGANIZATION_STATE_ID }, create: { id: ORGANIZATION_STATE_ID, version: 0 }, update: {},
      });
      const version = organizationVersion(state.version);
      if (version !== actor.expectedVersion) throw new ConflictError("Organization version conflict");
      const plan = await prepare(tx);
      const before = plan.before === null ? null : decode(plan.before);
      if (plan.changed && version === ORGANIZATION_MAX_VERSION) throw new ConflictError("Organization version exhausted");
      // Capture recipients while the topology lock still protects membership.
      // Only after commit do clients drop their open authority-bearing views.
      if (plan.changed) {
        if ((method === 'setPrivilegeAssignment' && payload.assigned === false)
          || (method === 'setGroupMember' && payload.member === false)) {
          revokedUserIds.add(organizationId(payload.userId));
        }
        if ((method === 'setGroupArchived' && payload.archived === true)
          || (method === 'setGroupPrivilegeAssignment' && payload.assigned === false)) {
          const groupId = method === 'setGroupArchived' ? organizationId(targetId) : organizationId(payload.groupId);
          const members = await tx.responsibleGroupMember.findMany({ where: { groupId }, select: { userId: true } });
          for (const member of members) revokedUserIds.add(member.userId);
        }
        if (method === 'updatePrivilegeProfile' && before !== null && 'permissions' in before
          && (JSON.stringify(before.permissions) !== JSON.stringify(payload.permissions)
            || before.archived !== payload.archived || before.visibility !== (payload.visibility ?? 'board'))) {
          const personal = await tx.scopedPrivilegeAssignment.findMany({ where: { profileId: organizationId(targetId) }, select: { userId: true } });
          const grouped = await tx.groupPrivilegeAssignment.findMany({ where: { profileId: organizationId(targetId) },
            select: { group: { select: { members: { select: { userId: true } } } } } });
          for (const row of personal) revokedUserIds.add(row.userId);
          for (const row of grouped) for (const member of row.group.members) revokedUserIds.add(member.userId);
        }
      }
      const result = decode(plan.changed ? await plan.write() : plan.result);
      if (!resultMatchesCommand(method, targetId, payload, result)) throw new ConflictError("Invalid organization mutation result");
      const committedVersion = version + (plan.changed ? 1 : 0);
      if (plan.changed) {
        await tx.organizationState.update({ where: { id: ORGANIZATION_STATE_ID }, data: { version: committedVersion } });
      }
      await tx.organizationOperation.create({
        data: {
          actorId: actor.actorId, operationId: actor.operationId, operation: method, targetKind,
          targetId: organizationResultTarget(result), requestHash, expectedVersion: version, committedVersion,
          changed: plan.changed, before: before === null ? Prisma.JsonNull : { ...before },
          after: { ...result }, result: { ...result },
        },
      });
      return { result, version: committedVersion, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }).then(result => {
      if (!result.replayed) for (const userId of revokedUserIds) emitAuthRevoked(userId, 'organization-privileges-changed');
      return result;
    });
  };

  return {
    setProjectLifecycleColumns(input) {
      const projectId = organizationId(input.projectId);
      let lifecycleColumnMap: LifecycleColumnMap | null;
      try { lifecycleColumnMap = decodeLifecycleColumnMap(input.lifecycleColumnMap); }
      catch { throw new ValidationError("Invalid lifecycle columns"); }
      return mutate<OrganizationProjectLifecycleColumns>(input, "setProjectLifecycleColumns", "project", projectId, { lifecycleColumnMap }, async tx => {
        const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, lifecycleColumnMap: true } });
        if (!project) throw new NotFoundError();
        const before = { id: projectId, lifecycleColumnMap: decodeLifecycleColumnMap(project.lifecycleColumnMap) };
        const result = { id: projectId, lifecycleColumnMap };
        if (JSON.stringify(before.lifecycleColumnMap) === JSON.stringify(lifecycleColumnMap)) return { before, changed: false, result };
        // A legacy marked board must be recoverable through its first explicit
        // configuration. This writes no task/marker and performs no backfill.
        if (before.lifecycleColumnMap !== null && await tx.taskRequest.count({ where: { task: { projectId } } })) throw new ConflictError("Lifecycle columns are locked while requests exist");
        if (lifecycleColumnMap) {
          const columns = [];
          for (const id of lifecycleColumnFields.map(key => lifecycleColumnMap[key]).sort()) {
            columns.push(...await tx.$queryRaw<{ id: string; projectId: string; workflowKey: string }[]>`SELECT "id", "projectId", "workflowKey" FROM "ProjectColumn" WHERE "id" = ${id} AND "projectId" = ${projectId} FOR UPDATE`);
          }
          try { validateLifecycleColumnTargets(lifecycleColumnMap, columns, projectId); }
          catch { throw new ValidationError("Invalid lifecycle columns"); }
        }
        return { before, changed: true, write: async () => {
          await tx.project.update({ where: { id: projectId }, data: { lifecycleColumnMap: lifecycleColumnMap ?? Prisma.DbNull } });
          return result;
        } };
      });
    },
    createBoard(input) {
      const actor = normalizeOrganizationActor(input);
      const name = organizationName(input.name), departmentId = organizationId(input.departmentId);
      const responsibleGroupId = organizationNullableId(input.responsibleGroupId);
      return mutate<OrganizationCreatedBoard>(actor, "createBoard", "project", null,
        { name, departmentId, responsibleGroupId }, async tx => {
          await inspectAncestry(tx, departmentId, { active: true });
          if (responsibleGroupId !== null) requireActive(await group(tx, responsibleGroupId));
          const columns = DEFAULT_BOARD_COLUMNS.map(column=>({...column,id:randomUUID()}));
          const columnId = (key:string) => columns.find(column=>column.workflowKey===key)!.id;
          const lifecycleColumnMap = {contractVersion:1,submittedColumnId:columnId('TODO'),inProgressColumnId:columnId('IN_PROGRESS'),needsInfoColumnId:columnId('NEEDS_INFO'),completedColumnId:columnId('REVIEW'),closedColumnId:columnId('DONE')};
          return { before: null, changed: true, write: async () => tx.project.create({
            data: { name, ownerId: actor.actorId, departmentId, responsibleGroupId,lifecycleColumnMap,
              columns: { create: columns } },
            select: { id: true, departmentId: true, responsibleGroupId: true },
          }).then(row => ({ ...row, departmentId: organizationId(row.departmentId) })) };
        });
    },
    createPrivilegeProfile(input) {
      const name = organizationName(input.name), permissions = normalizePrivilegePermissions(input.permissions);
      const visibility = normalizePrivilegeVisibility(input.visibility);
      return mutate(input, "createPrivilegeProfile", "profile", null, { name, permissions, ...(visibility === 'own' ? { visibility } : {}) }, async tx => ({
        before: null, changed: true, write: async () => {
          const row = await tx.privilegeProfile.create({ data: { name, permissions: encodePrivilegeProfileSettings(permissions, visibility) },
            select: { id: true, name: true, permissions: true, archivedAt: true } });
          return { id: row.id, name: row.name, ...decodePrivilegeProfileSettings(row.permissions), archived: row.archivedAt !== null };
        },
      }));
    },
    updatePrivilegeProfile(input) {
      const profileId = organizationId(input.profileId), name = organizationName(input.name);
      const permissions = normalizePrivilegePermissions(input.permissions), archived = organizationBoolean(input.archived);
      const visibility = normalizePrivilegeVisibility(input.visibility);
      return mutate(input, "updatePrivilegeProfile", "profile", profileId, { name, permissions, archived, ...(visibility === 'own' ? { visibility } : {}) }, async tx => {
        const row = await tx.privilegeProfile.findUnique({ where: { id: profileId },
          select: { id: true, name: true, permissions: true, archivedAt: true } });
        if (!row) throw new NotFoundError();
        const before = decodeOrganizationResult("updatePrivilegeProfile", { id: row.id, name: row.name,
          permissions: row.permissions, archived: row.archivedAt !== null }) as OrganizationPrivilegeProfile;
        if (visibility === 'own' && (await tx.scopedPrivilegeAssignment.count({ where: { profileId, scopeKind: { not: 'board' } } }) > 0
          || await tx.groupPrivilegeAssignment.count({ where: { profileId, scopeKind: { not: 'board' } } }) > 0)) {
          throw new ValidationError('OWN visibility requires board scope');
        }
        const result = { id: profileId, name, permissions, visibility, archived };
        const changed = JSON.stringify(before) !== JSON.stringify(result);
        return !changed ? { before, changed: false, result } : { before, changed: true, write: async () => {
          await tx.privilegeProfile.update({ where: { id: profileId },
            data: { name, permissions: encodePrivilegeProfileSettings(permissions, visibility), archivedAt: archived ? row.archivedAt ?? new Date() : null }, select: { id: true } });
          return result;
        } };
      });
    },
    setGroupPrivilegeAssignment(input) {
      const groupId = organizationId(input.groupId), profileId = organizationId(input.profileId);
      const scope = normalizePrivilegeScope(input.scopeKind, input.departmentId, input.projectId);
      const assigned = organizationBoolean(input.assigned);
      const id = groupPrivilegeAssignmentId(groupId, profileId, scope.scopeKind, scope.departmentId, scope.projectId);
      const fields = { groupId, profileId, ...scope };
      return mutate<OrganizationGroupPrivilegeAssignment>(input, "setGroupPrivilegeAssignment", "groupPrivilegeAssignment", id,
        { ...fields, assigned }, async tx => {
          const targetGroup = await group(tx, groupId);
          if (assigned) requireActive(targetGroup);
          if (scope.projectId !== null && !await tx.project.findUnique({ where: { id: scope.projectId }, select: { id: true } })) {
            throw new NotFoundError();
          }
          const profile = await tx.privilegeProfile.findUnique({ where: { id: profileId },
            select: { id: true, archivedAt: true, permissions: true } });
          if (!profile) throw new NotFoundError();
          const settings = decodePrivilegeProfileSettings(profile.permissions);
          if (assigned) requireActive(profile);
          if (assigned && settings.visibility === 'own' && scope.scopeKind !== 'board') {
            throw new ValidationError('OWN visibility requires board scope');
          }
          if (scope.departmentId !== null) {
            const target = await department(tx, scope.departmentId);
            if (assigned) requireActive(target);
          }
          const existing = await tx.groupPrivilegeAssignment.findUnique({ where: { id } });
          const before = existing === null ? { id, ...fields, assigned: false }
            : decodeOrganizationResult("setGroupPrivilegeAssignment", { ...existing, assigned: true }) as OrganizationGroupPrivilegeAssignment;
          if (JSON.stringify({ ...before, assigned }) !== JSON.stringify({ id, ...fields, assigned })) {
            throw new ConflictError("Invalid saved group privilege assignment");
          }
          const result = { id, ...fields, assigned };
          if ((existing !== null) === assigned) return { before, changed: false, result };
          if (assigned && await tx.groupPrivilegeAssignment.count({ where: { groupId } }) >= 100) {
            throw new ConflictError("Group privilege assignment limit reached");
          }
          return { before, changed: true, write: async () => {
            if (assigned) await tx.groupPrivilegeAssignment.create({ data: { id, ...fields } });
            else await tx.groupPrivilegeAssignment.deleteMany({ where: { id } });
            return result;
          } };
        });
    },
    setPrivilegeAssignment(input) {
      const userId = organizationId(input.userId), profileId = organizationId(input.profileId);
      const scope = normalizePrivilegeScope(input.scopeKind, input.departmentId, input.projectId);
      const assigned = organizationBoolean(input.assigned);
      const id = privilegeAssignmentId(userId, profileId, scope.scopeKind, scope.departmentId, scope.projectId);
      const fields = { userId, profileId, ...scope };
      return mutate(input, "setPrivilegeAssignment", "privilegeAssignment", id, { ...fields, assigned }, async tx => {
        if (scope.projectId !== null) {
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${scope.projectId} FOR UPDATE`;
          if (!await tx.project.findUnique({ where: { id: scope.projectId }, select: { id: true } })) throw new NotFoundError();
        }
        await requireUser(tx, userId);
        const profile = await tx.privilegeProfile.findUnique({ where: { id: profileId },
          select: { id: true, archivedAt: true, permissions: true } });
        if (!profile) throw new NotFoundError();
        decodePrivilegePermissions(profile.permissions);
        if (assigned && decodePrivilegeProfileSettings(profile.permissions).visibility === 'own' && scope.scopeKind !== 'board') {
          throw new ValidationError('OWN visibility requires board scope');
        }
        if (assigned) requireActive(profile);
        if (scope.departmentId !== null) {
          const target = await department(tx, scope.departmentId);
          if (assigned) requireActive(target);
        }
        const existing = await tx.scopedPrivilegeAssignment.findUnique({ where: { id } });
        const before = existing === null ? { id, ...fields, assigned: false }
          : decodeOrganizationResult("setPrivilegeAssignment", { ...existing, assigned: true }) as OrganizationPrivilegeAssignment;
        if (JSON.stringify({ ...before, assigned }) !== JSON.stringify({ id, ...fields, assigned })) {
          throw new ConflictError("Invalid saved privilege assignment");
        }
        const result = { id, ...fields, assigned };
        if ((existing !== null) === assigned) return { before, changed: false, result };
        if (assigned && await tx.scopedPrivilegeAssignment.count({ where: { userId } }) >= 100) {
          throw new ConflictError("Privilege assignment limit reached");
        }
        return { before, changed: true, write: async () => {
          if (assigned) await tx.scopedPrivilegeAssignment.create({ data: { id, ...fields } });
          else await tx.scopedPrivilegeAssignment.deleteMany({ where: { id } });
          return result;
        } };
      });
    },
    setProjectApplicantPolicy(input) {
      const projectId = organizationId(input.projectId);
      const policy = normalizeOrganizationApplicantPolicy(input.policy);
      return mutate(input, "setProjectApplicantPolicy", "project", projectId, { policy }, async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
        const row = await tx.project.findUnique({ where: { id: projectId }, select: {
          id: true, applicantPolicyConfig: { select: { policy: true } },
        } });
        if (!row) throw new NotFoundError();
        if (row.applicantPolicyConfig?.policy === null) throw new ConflictError("Invalid saved project applicant policy");
        const before = { id: row.id, policy: row.applicantPolicyConfig === null ? null
          : decodeOrganizationApplicantPolicy(row.applicantPolicyConfig.policy) };
        if (policy !== null) {
          for (const userId of policy.userIds) await requireUser(tx, userId);
          for (const departmentId of policy.departmentIds) requireActive(await department(tx, departmentId));
          for (const groupId of policy.groupIds) requireActive(await group(tx, groupId));
        }
        const result = { id: projectId, policy };
        return JSON.stringify(before.policy) === JSON.stringify(policy)
          ? { before, changed: false, result }
          : { before, changed: true, write: async () => {
            if (policy === null) await tx.projectApplicantPolicy.deleteMany({ where: { projectId } });
            else await tx.projectApplicantPolicy.upsert({ where: { projectId },
              create: { projectId, policy }, update: { policy } });
            return result;
          } };
      });
    },
    setGlobalRole(input) {
      const actorId = organizationId(input.actorId), userId = organizationId(input.userId), globalRole = organizationGlobalRole(input.globalRole);
      let demoted = false;
      const mutation = mutate({ actorId, operationId: input.operationId, expectedVersion: input.expectedVersion }, "setGlobalRole", "user", userId, { globalRole }, async tx => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const before = await tx.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true } });
        if (!before) throw new NotFoundError();
        if (userId === actorId && globalRole !== "ADMIN") throw new ConflictError("Self demotion is forbidden");
        if (before.globalRole === globalRole) return { before, changed: false, result: before };
        if (before.globalRole === "ADMIN" && globalRole === "USER"
          && await tx.user.count({ where: { globalRole: "ADMIN" } }) <= 1) {
          throw new ConflictError("Last administrator is protected");
        }
        demoted = before.globalRole === "ADMIN" && globalRole === "USER";
        return { before, changed: true, write: async () => tx.user.update({
          where: { id: userId }, data: { globalRole }, select: { id: true, globalRole: true },
        }) };
      });
      // Only a committed, non-replayed demotion changes what the open socket may
      // read; force a fresh handshake instead of waiting for the next reconnect.
      return mutation.then(result => {
        if (demoted && !result.replayed) emitAuthRevoked(userId, "role-demoted");
        return result;
      });
    },
    createDepartment(input) {
      const name = organizationName(input.name);
      const parentId = input.parentId === undefined ? null : organizationNullableId(input.parentId);
      return mutate(input, "createDepartment", "department", null, { name, parentId }, async tx => {
        await inspectAncestry(tx, parentId, { active: true });
        return { before: null, changed: true,
          write: async () => departmentDto(await tx.department.create({ data: { name, parentId } })) };
      });
    },
    renameDepartment(input) {
      const id = organizationId(input.departmentId), name = organizationName(input.name);
      return mutate(input, "renameDepartment", "department", id, { name }, async tx => {
        const current = await department(tx, id);
        requireActive(current);
        const before = departmentDto(current);
        return current.name === name ? { before, changed: false, result: before } : { before, changed: true,
          write: async () => departmentDto(await tx.department.update({ where: { id }, data: { name } })) };
      });
    },
    moveDepartment(input) {
      const id = organizationId(input.departmentId), parentId = organizationNullableId(input.parentId);
      return mutate(input, "moveDepartment", "department", id, { parentId }, async tx => {
        const current = await department(tx, id);
        requireActive(current);
        await inspectAncestry(tx, id);
        await inspectAncestry(tx, parentId, { forbiddenId: id, active: true });
        const before = departmentDto(current);
        return current.parentId === parentId ? { before, changed: false, result: before } : { before, changed: true,
          write: async () => departmentDto(await tx.department.update({ where: { id }, data: { parentId } })) };
      });
    },
    setDepartmentArchived(input) {
      const id = organizationId(input.departmentId), archived = organizationBoolean(input.archived);
      return mutate(input, "setDepartmentArchived", "department", id, { archived }, async tx => {
        const current = await department(tx, id), before = departmentDto(current);
        if (before.archived === archived) return { before, changed: false, result: before };
        if (archived) {
          const [users, projects, activeChildren] = await Promise.all([
            tx.user.count({ where: { primaryDepartmentId: id } }), tx.project.count({ where: { departmentId: id } }),
            tx.department.count({ where: { parentId: id, archivedAt: null } }),
          ]);
          if (users || projects || activeChildren) throw new ConflictError("Department is still in use");
        } else {
          await inspectAncestry(tx, current.parentId, { forbiddenId: id, active: true });
        }
        return { before, changed: true, write: async () => departmentDto(await tx.department.update({
          where: { id }, data: { archivedAt: archived ? new Date() : null },
        })) };
      });
    },
    setDepartmentLeader(input) {
      const id = organizationId(input.departmentId), userId = organizationNullableId(input.userId);
      return mutate(input, "setDepartmentLeader", "department", id, { userId }, async tx => {
        const current = await department(tx, id), before = departmentDto(current);
        if (userId !== null) { requireActive(current); await requireUser(tx, userId); }
        return current.leaderId === userId ? { before, changed: false, result: before } : { before, changed: true,
          write: async () => departmentDto(await tx.department.update({ where: { id }, data: { leaderId: userId } })) };
      });
    },
    assignUserDepartment(input) {
      const userId = organizationId(input.userId), departmentId = organizationNullableId(input.departmentId);
      return mutate(input, "assignUserDepartment", "user", userId, { departmentId }, async tx => {
        const before = await tx.user.findUnique({ where: { id: userId }, select: { id: true, primaryDepartmentId: true } });
        if (!before) throw new NotFoundError();
        await inspectAncestry(tx, departmentId, { active: true });
        return before.primaryDepartmentId === departmentId ? { before, changed: false, result: before } : { before, changed: true,
          write: async () => tx.user.update({ where: { id: userId }, data: { primaryDepartmentId: departmentId },
            select: { id: true, primaryDepartmentId: true } }) };
      });
    },
    createGroup(input) {
      const name = organizationName(input.name);
      return mutate(input, "createGroup", "group", null, { name }, async tx => ({ before: null, changed: true,
        write: async () => groupDto(await tx.responsibleGroup.create({ data: { name } })) }));
    },
    renameGroup(input) {
      const id = organizationId(input.groupId), name = organizationName(input.name);
      return mutate(input, "renameGroup", "group", id, { name }, async tx => {
        const current = await group(tx, id), before = groupDto(current);
        requireActive(current);
        return current.name === name ? { before, changed: false, result: before } : { before, changed: true,
          write: async () => groupDto(await tx.responsibleGroup.update({ where: { id }, data: { name } })) };
      });
    },
    setGroupArchived(input) {
      const id = organizationId(input.groupId), archived = organizationBoolean(input.archived);
      return mutate(input, "setGroupArchived", "group", id, { archived }, async tx => {
        const current = await group(tx, id), before = groupDto(current);
        if (before.archived === archived) return { before, changed: false, result: before };
        if (archived && await tx.project.count({ where: { responsibleGroupId: id } })) {
          throw new ConflictError("Responsible group is still in use");
        }
        return { before, changed: true, write: async () => groupDto(await tx.responsibleGroup.update({
          where: { id }, data: { archivedAt: archived ? new Date() : null },
        })) };
      });
    },
    setGroupLeader(input) {
      const id = organizationId(input.groupId), userId = organizationNullableId(input.userId);
      return mutate<OrganizationGroupLeadership>(input, "setGroupLeader", "group", id, { userId }, async tx => {
        const current = await group(tx, id);
        const before = { id: current.id, leaderId: current.leaderId };
        if (userId !== null) {
          requireActive(current);
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
          const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, isBlocked: true, blockedAt: true } });
          if (!user) throw new NotFoundError();
          if (user.isBlocked !== false || user.blockedAt !== null) throw new ConflictError("Group leader account is inactive");
          if (!await tx.responsibleGroupMember.findUnique({ where: { groupId_userId: { groupId: id, userId } } })) {
            throw new ConflictError("Group leader must be a current member");
          }
        }
        return current.leaderId === userId ? { before, changed: false, result: before } : { before, changed: true,
          write: async () => tx.responsibleGroup.update({ where: { id }, data: { leaderId: userId }, select: { id: true, leaderId: true } }) };
      });
    },
    setGroupMember(input) {
      const groupId = organizationId(input.groupId), userId = organizationId(input.userId), member = organizationBoolean(input.member);
      return mutate(input, "setGroupMember", "group", groupId, { userId, member }, async tx => {
        const current = await group(tx, groupId);
        if (member) requireActive(current);
        await requireUser(tx, userId);
        const existing = await tx.responsibleGroupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
        const before = { groupId, userId, member: existing !== null };
        if (before.member === member) return { before, changed: false, result: before };
        return { before, changed: true, write: async () => {
          if (member) await tx.responsibleGroupMember.createMany({ data: [{ groupId, userId }], skipDuplicates: true });
          else await tx.responsibleGroupMember.deleteMany({ where: { groupId, userId } });
          return { groupId, userId, member };
        } };
      });
    },
    bindProject(input) {
      const projectId = organizationId(input.projectId), departmentId = organizationNullableId(input.departmentId);
      const responsibleGroupId = organizationNullableId(input.responsibleGroupId);
      return mutate(input, "bindProject", "project", projectId, { departmentId, responsibleGroupId }, async tx => {
        const before = await tx.project.findUnique({ where: { id: projectId },
          select: { id: true, departmentId: true, responsibleGroupId: true } });
        if (!before) throw new NotFoundError();
        await inspectAncestry(tx, departmentId, { active: true });
        if (responsibleGroupId !== null) requireActive(await group(tx, responsibleGroupId));
        return before.departmentId === departmentId && before.responsibleGroupId === responsibleGroupId
          ? { before, changed: false, result: before } : { before, changed: true,
            write: async () => tx.project.update({ where: { id: projectId }, data: { departmentId, responsibleGroupId },
              select: { id: true, departmentId: true, responsibleGroupId: true } }) };
      });
    },
  };
}
