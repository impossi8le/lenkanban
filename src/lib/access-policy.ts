import type { OrganizationApplicantPreview } from "./organization-contract";
import type { Prisma } from "@prisma/client";
import { taskAudienceReadPredicate, taskWatcherReadPredicate } from "./task-audience";
import type { OrganizationPrivilegePermission, OrganizationPrivilegeScope, OrganizationScopedDecision } from "./organization-contract";

/** No wildcard/default activation: rollout is an explicit server-side board allowlist. */
export function ownTaskProjectIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = value.split(",").map(id => id.trim());
  if (ids.some(id => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new Error("INVALID_OWN_TASK_POLICY");
  return [...new Set(ids)];
}

function activeResponsibleGroupWhere(userId: string): Prisma.ProjectWhereInput {
  return { departmentId: null, responsibleGroup: { is: { archivedAt: null, members: { some: { userId } } } } };
}

/** Board discovery/read only. Task rows and all writes use separate predicates. */
export function projectReadPredicate(actor: LegacyProjectActor): Prisma.ProjectWhereInput {
  if (actor.globalRole === "ADMIN") return {};
  return { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }, activeResponsibleGroupWhere(actor.id), { department: { is: { archivedAt: null } } }] };
}

/** Only persisted bounded relation facts; a bare group ID or client metadata is insufficient. */
export function hasActiveResponsibleGroupMembership(group: {
  archivedAt: Date | null;
  members: readonly { userId: string }[];
} | null | undefined, userId: string): boolean {
  return group?.archivedAt === null && group.members.some(member => member.userId === userId);
}

/** Relational form of requestStaffWhere: a department binding wins.
 * The relation predicates also require an active account at query time. */
export function requestExecutorStaffProjectPredicate(userId: string): Prisma.ProjectWhereInput {
  return { OR: [
    { department: { is: { archivedAt: null, employees: { some: { id: userId, isBlocked: false, blockedAt: null } } } } },
    { departmentId: null, responsibleGroup: { is: { archivedAt: null, members: {
      some: { userId, user: { isBlocked: false, blockedAt: null } },
    } } } },
  ] };
}

/** Global task visibility: personal participation OR actual board execution.
 * Supplied scopes represent freshly resolved explicit request.execute grants.
 * Board ownership, membership, leadership and read profiles never replace them.
 * The legacy arguments remain for callers; OWN applies to every stored board.
 */
export function taskReadPredicate(
  actor: LegacyProjectActor,
  _ownProjectIds: readonly string[],
  executorProjectWhere: readonly Prisma.ProjectWhereInput[] = [],
  _mandatoryOwn?: boolean,
  commonReadProjectWhere: readonly Prisma.ProjectWhereInput[] = [],
): Prisma.TaskWhereInput {
  // Retain the fourth argument for existing callers; it no longer selects a policy.
  void _mandatoryOwn;
  if (actor.globalRole === "ADMIN") return {};
  const submitted: Prisma.TaskWhereInput = { OR: [
    { request: { is: null } },
    { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } },
  ] };
  return { AND: [
    { OR: [
      { request: { is: { contractVersion: 1, authorId: actor.id, deletedAt: null } } },
      { request: { is: { contractVersion: 1, executorId: actor.id, deletedAt: null, state: { not: "DRAFT" } } } },
      { request: { is: null }, createdById: actor.id },
      { request: { is: null }, assignees: { some: { userId: actor.id }, none: { userId: { not: actor.id } } } },
      taskWatcherReadPredicate(actor),
      ...commonReadProjectWhere.map((project): Prisma.TaskWhereInput => ({ project, request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null, audienceUserIds: { isEmpty: true } } } })),
      ...executorProjectWhere.map(project => ({ AND: [submitted, { project: { AND: [
        project, requestExecutorStaffProjectPredicate(actor.id),
      ] } }] })),
    ] },
    taskAudienceReadPredicate(actor),
  ] };
}

/** Legacy field/deletion authority is narrower than reading. Marked requests
 * use lifecycle commands; observers, project membership and scoped reads cannot
 * authorize these mutations. */
export function taskWritePredicate(actor: LegacyProjectActor): Prisma.TaskWhereInput {
  if (actor.globalRole === "ADMIN") return {};
  return { request: { is: null }, OR: [
    { createdById: actor.id },
    { assignees: { some: { userId: actor.id }, none: { userId: { not: actor.id } } } },
  ] };
}

/** Server-established legacy facts only; this evaluator does not refresh identity. */
export type LegacyProjectActor = Readonly<{
  id: string;
  globalRole: "USER" | "ADMIN";
}>;

export type LegacyProjectFacts = Readonly<{
  ownerId: string;
  membershipRole: "MEMBER" | "PROJECT_ADMIN" | null;
}>;

export type LegacyProjectAccessSource =
  | "global_admin"
  | "project_owner"
  | "project_admin"
  | "project_member"
  | "no_project_access";

export type LegacyProjectAccessDecision = Readonly<{
  allowed: boolean;
  source: LegacyProjectAccessSource;
}>;

export type LegacyProjectAccessEvaluation = Readonly<{
  canRead: LegacyProjectAccessDecision;
  canWrite: LegacyProjectAccessDecision;
  canManageMembers: LegacyProjectAccessDecision;
}>;

export type ProjectAccessEvaluation = Readonly<{
  canRead: Readonly<{ allowed: boolean; source: LegacyProjectAccessSource | "responsible_group_read" }>;
  canWrite: Readonly<{ allowed: boolean; source: LegacyProjectAccessSource | "own_write_restricted" }>;
  canManageMembers: LegacyProjectAccessDecision;
}>;

/** Same coarse project boundary used by the adapter and ADMIN explanation.
 * Task relationships and scoped reads are evaluated separately, never as writes.
 */
export function evaluateProjectAccess(
  actor: LegacyProjectActor,
  project: LegacyProjectFacts | null,
  ownBoard: boolean,
  activeResponsibleGroupMember = false,
): ProjectAccessEvaluation {
  const legacy = evaluateLegacyProjectAccess(actor, project);
  return {
    ...legacy,
    canRead: !legacy.canRead.allowed && project !== null && activeResponsibleGroupMember
      ? { allowed: true, source: "responsible_group_read" }
      : legacy.canRead,
    canWrite: ownBoard && actor.globalRole !== "ADMIN" && legacy.canWrite.allowed
      ? { allowed: false, source: "own_write_restricted" }
      : legacy.canWrite,
  };
}

/** Organization metadata is deliberately absent from the legacy grant inputs. */
export function evaluateLegacyProjectAccess(
  actor: LegacyProjectActor,
  project: LegacyProjectFacts | null,
): LegacyProjectAccessEvaluation {
  let source: LegacyProjectAccessSource = "no_project_access";
  if (actor.globalRole === "ADMIN") source = "global_admin";
  else if (project?.ownerId === actor.id) source = "project_owner";
  else if (project?.membershipRole === "PROJECT_ADMIN") source = "project_admin";
  else if (project?.membershipRole === "MEMBER") source = "project_member";

  const canRead = source !== "no_project_access";
  return {
    canRead: { allowed: canRead, source },
    canWrite: { allowed: canRead, source },
    canManageMembers: { allowed: canRead && source !== "project_member", source },
  };
}

/** Prospective submission only; neither legacy access nor administrative override. */
export function evaluateProjectApplicantPolicy(
  policy: Readonly<{ allEmployees: boolean; userIds: readonly string[]; departmentIds: readonly string[]; groupIds: readonly string[] }> | null,
  facts: Readonly<{ userId: string; activePrimaryDepartmentId: string | null; activeGroupIds: readonly string[] }>,
): Pick<OrganizationApplicantPreview, "allowed" | "source"> {
  if (policy === null) return { allowed: null, source: "unconfigured" };
  if (policy.allEmployees) return { allowed: true, source: "all_employees" };
  if (policy.userIds.includes(facts.userId)) return { allowed: true, source: "explicit_user" };
  if (facts.activePrimaryDepartmentId !== null && policy.departmentIds.includes(facts.activePrimaryDepartmentId)) {
    return { allowed: true, source: "primary_department" };
  }
  if (facts.activeGroupIds.some(id => policy.groupIds.includes(id))) return { allowed: true, source: "responsible_group" };
  return { allowed: false, source: "not_in_policy" };
}

export type ScopedPrivilegeFacts = Readonly<{
  globalAdmin: boolean;
  projectId: string;
  activeDepartmentId: string | null;
}>;
export type ScopedPrivilegeGrant = Readonly<{
  id: string;
  profileId: string;
  scopeKind: OrganizationPrivilegeScope;
  departmentId: string | null;
  projectId: string | null;
  permissions: readonly OrganizationPrivilegePermission[];
  profileArchived: boolean;
}>;

/** Exact scope only: neither a department ancestor nor a person's title grants access. */
export function matchesScopedPrivilegeScope(
  facts: Pick<ScopedPrivilegeFacts, 'projectId' | 'activeDepartmentId'>,
  grant: Pick<ScopedPrivilegeGrant, 'scopeKind' | 'departmentId' | 'projectId'>,
): boolean {
  return (grant.scopeKind === "organization" && grant.departmentId === null && grant.projectId === null)
    || (grant.scopeKind === "department" && grant.projectId === null && facts.activeDepartmentId !== null && grant.departmentId === facts.activeDepartmentId)
    || (grant.scopeKind === "board" && grant.departmentId === null && grant.projectId === facts.projectId);
}

/** Only explicit supplied grants; no legacy rights, hierarchy or delegation. */
export function evaluateScopedPrivileges(facts: ScopedPrivilegeFacts, grants: readonly ScopedPrivilegeGrant[]): {
  requestRead: OrganizationScopedDecision; internalRead: OrganizationScopedDecision;
} {
  if (facts.globalAdmin) {
    return {
      requestRead: { allowed: true, source: "global_admin", assignmentIds: [] },
      internalRead: { allowed: true, source: "global_admin", assignmentIds: [] },
    };
  }
  const read = new Set<string>(), internal = new Set<string>();
  for (const grant of grants) {
    if (grant.profileArchived) continue;
    // Match the persisted scope CHECK and the task-read adapter. A malformed
    // broad scope must never become an organization-wide preview grant.
    const matches = matchesScopedPrivilegeScope(facts, grant);
    if (!matches) continue;
    if (grant.permissions.includes("request.read")) read.add(grant.id);
    if (grant.permissions.includes("request.internal.read")) internal.add(grant.id);
  }
  const readIds = [...read].sort(), internalIds = [...internal].sort();
  return {
    requestRead: { allowed: readIds.length > 0, source: readIds.length ? "assignment" : "none", assignmentIds: readIds },
    internalRead: { allowed: internalIds.length > 0 && readIds.length > 0,
      source: internalIds.length === 0 ? "none" : readIds.length > 0 ? "assignment" : "requires_request_read",
      assignmentIds: internalIds },
  };
}
