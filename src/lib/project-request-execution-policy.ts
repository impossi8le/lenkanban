import { loadRoleGrants, hasRolePermission, type RoleGrantDatabase } from "./role-grants";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

type ExecutionProject = {
  departmentId: string | null;
  department: { id: string; archivedAt: Date | null } | null;
  responsibleGroupId: string | null;
  responsibleGroup: { archivedAt: Date | null } | null;
};

/** Department binding wins over group membership, including archived departments. */
export function requestStaffWhere(project: ExecutionProject | null): Prisma.UserWhereInput | null {
  if (!project) return null;
  if (project.departmentId) return project.department?.archivedAt === null
    ? { primaryDepartmentId: project.departmentId, isBlocked: false, blockedAt: null } : null;
  return project.responsibleGroupId && project.responsibleGroup?.archivedAt === null
    ? { isBlocked: false, blockedAt: null, responsibleGroupMemberships: { some: { groupId: project.responsibleGroupId, group: { archivedAt: null } } } } : null;
}

export async function getProjectRequestStaffWhere(projectId: string,
  database: Pick<Prisma.TransactionClient, "project"> = prisma,
): Promise<Prisma.UserWhereInput | null> {
  return requestStaffWhere(await database.project.findUnique({ where: { id: projectId }, select: {
    departmentId: true, department: { select: { id: true, archivedAt: true } },
    responsibleGroupId: true, responsibleGroup: { select: { archivedAt: true } },
  } }));
}

/** Administration/leadership and observing never substitute for department staff. */
export function canExecuteRequest(facts: { hasDepartment: boolean; isDepartmentStaff: boolean; isGroupMember: boolean; hasExecutionPermission: boolean }): boolean {
  return facts.hasExecutionPermission && (facts.hasDepartment ? facts.isDepartmentStaff : facts.isGroupMember);
}

/** Presentation hint only. Commands recheck locked authority and task visibility. */
export async function getProjectRequestExecutionPolicy(actorId: string, projectId: string,
  database: Pick<Prisma.TransactionClient, "project" | "user"> & RoleGrantDatabase = prisma,
): Promise<{ canExecute: boolean }> {
  const project = await database.project.findUnique({ where: { id: projectId }, select: {
    departmentId: true, department: { select: { id: true, archivedAt: true } },
    responsibleGroupId: true, responsibleGroup: { select: { archivedAt: true } },
  } });
  const staff = requestStaffWhere(project);
  if (!staff || !await database.user.findFirst({ where: { AND: [{ id: actorId }, staff] }, select: { id: true } })) return { canExecute: false };
  return { canExecute: hasRolePermission(await loadRoleGrants(database, [actorId]), actorId, "request.execute", {
    projectId, activeDepartmentId: project?.department?.archivedAt === null ? project.department.id : null,
  }) };
}

type ExecutionDatabase = Pick<Prisma.TransactionClient, "project" | "user"> & RoleGrantDatabase;
const executionProjectSelect = {
  id: true, departmentId: true, department: { select: { id: true, archivedAt: true } },
  responsibleGroupId: true, responsibleGroup: { select: { archivedAt: true } },
} as const;

/** Fresh batch projection for one actor's queue; authority is never cached here. */
export async function getRequestExecutionProjectIds(actorId: string, projectIds: readonly string[] | undefined,
  database: ExecutionDatabase = prisma,
): Promise<string[]> {
  const projects = await database.project.findMany({
    ...(projectIds ? { where: { id: { in: [...new Set(projectIds)] } } } : {}), select: executionProjectSelect,
  });
  const active = projects.filter(project => requestStaffWhere(project) !== null);
  if (!active.length) return [];
  const actor = await database.user.findFirst({ where: { id: actorId, isBlocked: false, blockedAt: null }, select: {
    id: true, primaryDepartmentId: true,
    responsibleGroupMemberships: { where: { group: { archivedAt: null } }, select: { groupId: true } },
  } });
  if (!actor) return [];
  const memberships = new Set(actor.responsibleGroupMemberships.map(member => member.groupId));
  const grants = await loadRoleGrants(database, [actorId]);
  return active.filter(project => canExecuteRequest({
    hasDepartment: project.departmentId !== null,
    isDepartmentStaff: project.department?.archivedAt === null && actor.primaryDepartmentId === project.department.id,
    isGroupMember: project.responsibleGroupId !== null && memberships.has(project.responsibleGroupId),
    hasExecutionPermission: hasRolePermission(grants, actorId, "request.execute", {
      projectId: project.id, activeDepartmentId: project.department?.archivedAt === null ? project.department.id : null,
    }),
  })).map(project => project.id);
}

/** All active staff with a fresh execute grant, loaded in bounded batch queries. */
export async function getProjectRequestExecutorIds(projectId: string, database: ExecutionDatabase = prisma): Promise<string[]> {
  const project = await database.project.findUnique({ where: { id: projectId }, select: executionProjectSelect });
  const staff = requestStaffWhere(project);
  if (!project || !staff) return [];
  const actors = await database.user.findMany({ where: staff, select: { id: true } });
  const grants = await loadRoleGrants(database, actors.map(actor => actor.id));
  return actors.filter(actor => hasRolePermission(grants, actor.id, "request.execute", {
    projectId, activeDepartmentId: project.department?.archivedAt === null ? project.department.id : null,
  })).map(actor => actor.id);
}
