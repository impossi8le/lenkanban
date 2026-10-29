import { prisma } from "@/lib/prisma";
import type { Prisma, User } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { projectReadPredicate, evaluateProjectAccess, type ProjectAccessEvaluation } from "@/lib/access-policy";
import { hasActiveResponsibleGroupMembership, taskReadPredicate, taskWritePredicate } from "@/lib/access-policy";
import { hasRolePermission, loadRoleGrants, type RoleGrant, type RoleGrantDatabase } from "./role-grants";
import { evaluateProjectApplicantPolicy } from "@/lib/access-policy";
import { decodeOrganizationApplicantPolicy } from "@/lib/organization-command";

/**
 * OWN is mandatory on every persisted board, independent of environment config.
 * Read the board IDs through the supplied database and constrain the result to
 * that snapshot: the legacy branch of taskReadPredicate must never grant access
 * to a board created concurrently after this lookup. Database failures propagate.
 * Data cleanup must resolve null creators explicitly (never infer ownership),
 * reconcile multiple legacy assignees with an audited human choice, backfill the
 * canonical TaskRequest author/executor and enforce one executor atomically.
 * Do not create request markers until lifecycle writers/channels support them.
 * The legacy null creator stays unowned (eligible executors/admin may review it); never make
 * every employee its author. Null creators and ambiguous assignments stay denied.
 * TaskRequest.executorId is the sole executor for marked requests. Legacy
 * TaskAssignee rows grant read only when exactly one user is assigned. Resolve
 * multi-assignment explicitly, retaining the old values in restricted audit.
 * Removing an executor preserves author's/watcher's independent read rights.
 * Foreign task reads require explicit execution permission and current staff;
 * Remaining non-admin legacy writers are deliberately denied on OWN boards;
 * this is read integration, not permission to bypass lifecycle capabilities.
 * No result cache: removing an assignment/watcher takes effect on the next read.
 */
export async function getTaskReadWhere(
  user: Pick<User, "id" | "globalRole">,
  filters: Prisma.TaskWhereInput = {},
  database: Pick<Prisma.TransactionClient, "project" | "scopedPrivilegeAssignment"> & RoleGrantDatabase = prisma,
  scope?: Readonly<{ projectId: string; roleGrants?: readonly RoleGrant[] }>,
): Promise<Prisma.TaskWhereInput> {
  // A scope only narrows rows; it is never a read grant. Keep it separate from
  // caller filters so conflicting filters cannot overwrite this restriction.
  const scopedFilters: Prisma.TaskWhereInput = scope
    ? { AND: [filters, { projectId: scope.projectId }] } : filters;
  if (user.globalRole === "ADMIN") return scopedFilters;
  // Capture boards through the same client as the eventual task query.
  const canReadBoards = typeof database.project?.findMany === "function";
  const stored = canReadBoards
    ? (await database.project.findMany({ ...(scope ? { where: { id: scope.projectId } } : {}), select: { id: true } })).map(board => board.id)
    : [];
  const configured = (process.env.LENKANBAN_OWN_TASK_PROJECT_IDS ?? "")
    .split(",").map(id => id.trim()).filter(id => Boolean(id) && (!scope || id === scope.projectId));
  const boards = [...new Set([...configured, ...stored])];
  // A real empty snapshot is deny-all. Narrow injected clients still use OWN.
  if (canReadBoards && boards.length === 0) return { AND: [{ projectId: { in: [] } }, scopedFilters] };
  const scopes: Prisma.ProjectWhereInput[] = [];
  const commonScopes: Prisma.ProjectWhereInput[] = [];
  const grants = scope?.roleGrants ?? await loadRoleGrants(database, [user.id]);
  for (const grant of grants) {
    if (grant.userId === user.id && !grant.profileArchived && grant.visibility === "board" && grant.scopeKind === "board" && grant.projectId && grant.departmentId === null && grant.permissions.includes("request.read.common")) commonScopes.push({ id: grant.projectId });
    if (grant.userId !== user.id || grant.profileArchived || !grant.permissions.includes("request.execute")) continue;
    if (grant.scopeKind === "organization" && grant.projectId === null && grant.departmentId === null) scopes.push({});
    if (grant.scopeKind === "board" && grant.projectId && grant.departmentId === null) scopes.push({ id: grant.projectId });
    if (grant.scopeKind === "department" && grant.departmentId && grant.projectId === null) {
      scopes.push({ departmentId: grant.departmentId, department: { is: { archivedAt: null } } });
    }
  }
  const predicate = taskReadPredicate(user, boards, scopes, true, commonScopes);
  return { AND: [predicate, ...(canReadBoards ? [{ projectId: { in: boards } }] : []), scopedFilters] };
}

export async function requireTaskRead(
  user: Pick<User, "id" | "globalRole">,
  taskId: string,
  database: Pick<Prisma.TransactionClient, "project" | "task" | "scopedPrivilegeAssignment"> & RoleGrantDatabase = prisma,
) {
  const task = await database.task.findFirst({
    where: await getTaskReadWhere(user, { id: taskId }, database),
    select: { id: true, projectId: true },
  });
  if (!task) throw new NotFoundError();
  return task;
}

/** Caller holds the Task lock and supplies its freshly loaded actor. */
export async function requireTaskWrite(
  user: Pick<User, "id" | "globalRole">,
  taskId: string,
  projectId: string,
  database: Pick<Prisma.TransactionClient, "task"> = prisma,
) {
  if (user.globalRole === "ADMIN") return;
  const task = await database.task.findFirst({
    where: { AND: [taskWritePredicate(user), { id: taskId, projectId }] },
    select: { id: true },
  });
  if (!task) throw new NotFoundError();
}

export type ProjectAccess = {
  projectId: string;
  canRead: boolean;
  canWrite: boolean;
  canManageMembers: boolean;
};

/** Submission is a separate capability: it never grants task read or mutation. */
export async function getProjectCreateAccess(
  user: Pick<User, "id" | "globalRole">,
  projectId: string,
  database: Pick<Prisma.TransactionClient, "project" | "user" | "responsibleGroupMember"> = prisma,
): Promise<{ projectId: string; canCreate: boolean }> {
  const project = await database.project.findUnique({
    where: { id: projectId },
    select: {
      ownerId: true,
      members: { where: { userId: user.id }, select: { role: true }, take: 1 },
      applicantPolicyConfig: { select: { policy: true } },
      department: { select: { id: true, archivedAt: true } },
    },
  });
  if (!project) return { projectId, canCreate: false };
  // Any active employee may submit to any active department. This is only a
  // creation capability: task reading, taking work and management stay separate.
  if (project.department) {
    if (project.department.archivedAt !== null) return { projectId, canCreate: false };
    const subject = await database.user.findUnique({
      where: { id: user.id }, select: { id: true, isBlocked: true, blockedAt: true },
    });
    return { projectId, canCreate: Boolean(subject && subject.id === user.id && subject.isBlocked === false && subject.blockedAt === null) };
  }
  // Legacy boards with no department keep their existing configured applicant
  // policy or, when unconfigured, their owner/member submission boundary.
  if (project.applicantPolicyConfig === null) return { projectId, canCreate: evaluateProjectAccess(user, {
    ownerId: project.ownerId,
    membershipRole: project.members[0]?.role ?? null,
  }, false).canWrite.allowed };
  const policy = decodeOrganizationApplicantPolicy(project.applicantPolicyConfig.policy);
  if (policy === null) throw new ConflictError("Invalid saved project applicant policy");
  const subject = await database.user.findUnique({
    where: { id: user.id },
    select: { id: true, primaryDepartment: { select: { id: true, archivedAt: true } } },
  });
  if (!subject) return { projectId, canCreate: false };
  const memberships = policy.groupIds.length === 0 ? []
    : await database.responsibleGroupMember.findMany({
      where: { userId: subject.id, groupId: { in: policy.groupIds }, group: { archivedAt: null } },
      select: { groupId: true }, take: 20,
    });
  return { projectId, canCreate: evaluateProjectApplicantPolicy(policy, {
    userId: subject.id,
    activePrimaryDepartmentId: subject.primaryDepartment?.archivedAt === null ? subject.primaryDepartment.id : null,
    activeGroupIds: memberships.map(membership => membership.groupId),
  }).allowed === true };
}

export async function requireProjectCreate(
  user: Pick<User, "id" | "globalRole">,
  projectId: string,
  database: Pick<Prisma.TransactionClient, "project" | "user" | "responsibleGroupMember"> = prisma,
) {
  const access = await getProjectCreateAccess(user, projectId, database);
  if (!access.canCreate) throw new NotFoundError();
  return access;
}

function toProjectAccess(projectId: string, evaluation: ProjectAccessEvaluation): ProjectAccess {
  return {
    projectId,
    canRead: evaluation.canRead.allowed,
    canWrite: evaluation.canWrite.allowed,
    canManageMembers: evaluation.canManageMembers.allowed,
  };
}

/** Read-only board discovery; resource rows and mutation permissions remain separate. */
export async function getProjectReadWhere(
  user: Pick<User, "id" | "globalRole">,
  database: Pick<Prisma.TransactionClient, "user"> & RoleGrantDatabase = prisma,
): Promise<Prisma.ProjectWhereInput> {
  const legacy = projectReadPredicate(user);
  if (user.globalRole === "ADMIN") return legacy;
  const grants = await loadRoleGrants(database, [user.id]);
  const scopes: Prisma.ProjectWhereInput[] = [];
  for (const grant of grants) {
    if (grant.visibility !== "board" || (!grant.permissions.includes("request.read") && !(grant.scopeKind === "board" && grant.permissions.includes("request.read.common")))) continue;
    if (grant.scopeKind === "organization") scopes.push({});
    if (grant.scopeKind === "board" && grant.projectId) scopes.push({ id: grant.projectId });
    if (grant.scopeKind === "department" && grant.departmentId) scopes.push({ departmentId: grant.departmentId, department: { is: { archivedAt: null } } });
  }
  if (!scopes.length) return legacy;
  const actor = await database.user.findUnique({ where: { id: user.id }, select: { id: true, isBlocked: true, blockedAt: true } });
  return actor && actor.id === user.id && actor.isBlocked === false && actor.blockedAt === null
    ? { OR: [legacy, ...scopes] } : legacy;
}

export async function getProjectAccess(
  user: Pick<User, "id" | "globalRole">,
  projectId: string,
  database: Pick<Prisma.TransactionClient, "project" | "user"> & RoleGrantDatabase = prisma,
): Promise<ProjectAccess> {
  // Global admins can do everything.
  if (user.globalRole === "ADMIN") {
    return toProjectAccess(projectId, evaluateProjectAccess(user, null, false));
  }

  const project = await database.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      department: { select: { id: true, archivedAt: true } },
      ownerId: true,
      members: {
        where: { userId: user.id },
        select: { role: true },
        take: 1,
      },
      responsibleGroup: {
        select: { archivedAt: true, members: { where: { userId: user.id }, select: { userId: true }, take: 1 } },
      },
    },
  });

  const access = toProjectAccess(projectId, evaluateProjectAccess(user, project ? {
    ownerId: project.ownerId,
    membershipRole: project.members[0]?.role ?? null,
  } : null, false, hasActiveResponsibleGroupMembership(project?.responsibleGroup, user.id)));
  if (!access.canRead && project) {
    const grants = (await loadRoleGrants(database, [user.id])).filter(grant => grant.visibility === "board");
    if (hasRolePermission(grants, user.id, "request.read", { projectId, activeDepartmentId: project.department?.archivedAt === null ? project.department.id : null }) || grants.some(grant => grant.scopeKind === "board" && grant.projectId === projectId && grant.permissions.includes("request.read.common"))) {
      const actor = await database.user.findUnique({ where: { id: user.id }, select: { id: true, isBlocked: true, blockedAt: true } });
      access.canRead = Boolean(actor && actor.id === user.id && actor.isBlocked === false && actor.blockedAt === null);
    }
  }
  if (!access.canRead && project?.department?.archivedAt === null) {
    const actor = await database.user.findUnique({ where: { id: user.id }, select: { id: true, isBlocked: true, blockedAt: true } });
    access.canRead = Boolean(actor && actor.id === user.id && actor.isBlocked === false && actor.blockedAt === null);
  }
  return access;
}

export async function requireProjectRead(user: Pick<User, "id" | "globalRole">, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.canRead) throw new NotFoundError();
  return access;
}

export async function requireProjectWrite(user: Pick<User, "id" | "globalRole">, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.canWrite) throw new NotFoundError();
  return access;
}

export async function requireProjectMemberAdmin(user: Pick<User, "id" | "globalRole">, projectId: string) {
  const access = await getProjectAccess(user, projectId);
  if (!access.canManageMembers) throw new NotFoundError();
  return access;
}
