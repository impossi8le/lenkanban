import type { Prisma } from "@prisma/client";
import { ConflictError } from "./errors";
import { decodeOrganizationResult } from "./organization-command";
import { decodePrivilegeProfileSettings } from "./organization-command";
import { matchesScopedPrivilegeScope, type ScopedPrivilegeGrant } from "./access-policy";
import type { OrganizationPrivilegePermission } from "./organization-contract";

export type RoleGrant = ScopedPrivilegeGrant & {
  userId: string; source: "personal" | "group"; groupId: string | null; visibility: "own" | "board";
};
export type RoleGrantDatabase = Partial<Pick<Prisma.TransactionClient,
  "scopedPrivilegeAssignment" | "groupPrivilegeAssignment" | "$queryRaw">>;

/** Fresh authority only. Mutation readers lock the exact rows which supply grants. */
export async function loadRoleGrants(database: RoleGrantDatabase, userIds: readonly string[],
  options: { lock?: boolean; explain?: boolean } = {}): Promise<RoleGrant[]> {
  const ids = [...new Set(userIds)].sort();
  if (!ids.length) return [];
  let personalIds: string[] | undefined, groupIds: string[] | undefined;
  let lockedMemberships: Set<string> | undefined;
  if (options.lock) {
    if (!database.$queryRaw) throw new Error("Role authority locking unavailable");
    const personal = await database.$queryRaw<{ id: string }[]>`
      SELECT a."id" FROM "ScopedPrivilegeAssignment" a JOIN "PrivilegeProfile" p ON p."id" = a."profileId"
      WHERE a."userId" = ANY(${ids}::text[]) ORDER BY a."id" FOR SHARE OF a, p`;
    const grouped = await database.$queryRaw<{ id: string; userId: string }[]>`
      SELECT a."id", m."userId" FROM "GroupPrivilegeAssignment" a JOIN "PrivilegeProfile" p ON p."id" = a."profileId"
      JOIN "ResponsibleGroup" g ON g."id" = a."groupId"
      JOIN "ResponsibleGroupMember" m ON m."groupId" = g."id"
      WHERE m."userId" = ANY(${ids}::text[]) ORDER BY a."id", m."userId" FOR SHARE OF a, p, g, m`;
    personalIds = personal.map(row => row.id); groupIds = grouped.map(row => row.id);
    lockedMemberships = new Set(grouped.map(row => JSON.stringify([row.id, row.userId])));
  }
  const personal = database.scopedPrivilegeAssignment ? await database.scopedPrivilegeAssignment.findMany({
    where: { userId: ids.length === 1 ? ids[0] : { in: ids }, ...(!options.explain ? { profile: { archivedAt: null } } : {}), ...(personalIds ? { id: { in: personalIds } } : {}) },
    select: { id: true, userId: true, profileId: true, scopeKind: true, departmentId: true, projectId: true,
      profile: { select: { id: true, permissions: true, archivedAt: true } } },
  }) : [];
  const grouped = database.groupPrivilegeAssignment ? await database.groupPrivilegeAssignment.findMany({
    where: { group: { archivedAt: null, members: { some: { userId: { in: ids } } } }, ...(groupIds ? { id: { in: groupIds } } : {}) },
    select: { id: true, groupId: true, profileId: true, scopeKind: true, departmentId: true, projectId: true,
      profile: { select: { id: true, permissions: true, archivedAt: true } },
      group: { select: { archivedAt: true, members: { where: { userId: { in: ids } }, select: { userId: true } } } } },
  }) : [];
  for (const id of ids) if (personal.filter(row => row.userId === id).length > 100) {
    if (options.explain) throw new ConflictError("Too many privilege assignments");
    return [];
  }
  const result: RoleGrant[] = [];
  function append(row: typeof personal[number], userId: string, groupId: string | null) {
    if (!ids.includes(userId) || (!options.explain && row.profile.archivedAt !== null)) return;
    if (options.explain && groupId === null) {
      decodeOrganizationResult("setPrivilegeAssignment", { id: row.id, userId, profileId: row.profileId, scopeKind: row.scopeKind, departmentId: row.departmentId, projectId: row.projectId, assigned: true });
      if (row.profile.id !== row.profileId) throw new ConflictError("Invalid saved privilege assignment");
    }
    const scopeKind = row.scopeKind;
    if (scopeKind !== "organization" && scopeKind !== "department" && scopeKind !== "board") return;
    if (!((scopeKind === "organization" && row.departmentId === null && row.projectId === null)
      || (scopeKind === "department" && row.departmentId !== null && row.projectId === null)
      || (scopeKind === "board" && row.projectId !== null && row.departmentId === null))) return;
    try {
      const settings = decodePrivilegeProfileSettings(row.profile.permissions);
      if (settings.visibility === "own" && scopeKind !== "board") {
        if (options.explain) throw new ConflictError("Invalid own privilege scope");
        return;
      }
      result.push({ id: row.id, userId, groupId, source: groupId === null ? "personal" : "group",
        profileId: row.profileId, scopeKind, departmentId: row.departmentId, projectId: row.projectId,
        permissions: settings.permissions, visibility: settings.visibility, profileArchived: row.profile.archivedAt !== null });
    } catch (error) { if (options.explain) throw error; /* Invalid stored profiles grant nothing. */ }
  }
  for (const row of personal) append(row, row.userId, null);
  for (const row of grouped) if (row.group.archivedAt === null) for (const member of row.group.members) {
    if (!lockedMemberships || lockedMemberships.has(JSON.stringify([row.id, member.userId]))) append({ ...row, userId: member.userId }, member.userId, row.groupId);
  }
  return result;
}

export function hasRolePermission(grants: readonly RoleGrant[], userId: string,
  permission: OrganizationPrivilegePermission, scope: { projectId: string; activeDepartmentId: string | null }): boolean {
  return grants.some(grant => grant.userId === userId && !grant.profileArchived
    && grant.permissions.includes(permission)
    && (!["request.approve","request.read.common","request.return_for_revision"].includes(permission)||grant.scopeKind==="board")
    && matchesScopedPrivilegeScope(scope, grant));
}
