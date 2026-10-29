import type { Prisma } from "@prisma/client";

import { evaluateScopedPrivileges, type ScopedPrivilegeGrant } from "@/lib/access-policy";
import { loadRoleGrants, type RoleGrantDatabase } from "@/lib/role-grants";
import { canReadInternalDiscussion, type InternalAccessFacts } from "./discussion-policy";

/**
 * Persistence boundary for discussion visibility.
 *
 * `ChatMessage.isInternal` and `TaskWatcher` are not part of the checked-in
 * Prisma schema yet (the migration is documented in the issue report). Reads
 * use parameterized raw SQL so the route compiles and the legacy public
 * discussion keeps working before the migration. An internal write never falls
 * back to a public message: if the column is missing the transaction fails.
 */
export type DiscussionDb = Pick<
  Prisma.TransactionClient,
  "project" | "user" | "scopedPrivilegeAssignment" | "task" | "$queryRaw" | "$executeRaw"
> & RoleGrantDatabase;

export type ProjectDiscussionFacts = Readonly<{
  projectId: string;
  departmentId: string | null;
  departmentLeaderId: string | null;
  departmentActive: boolean;
  groupId: string | null;
  groupActive: boolean;
  groupMemberIds: readonly string[];
}>;

/**
 * Active organizational links of the board. A missing/archived link grants
 * nothing. Any read failure yields `null` so callers deny the internal part
 * instead of guessing.
 */
export async function loadProjectDiscussionFacts(
  db: Pick<DiscussionDb, "project">,
  projectId: string,
): Promise<ProjectDiscussionFacts | null> {
  try {
    const row = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        departmentId: true,
        responsibleGroupId: true,
        department: { select: { id: true, leaderId: true, archivedAt: true } },
        responsibleGroup: {
          select: {
            id: true,
            archivedAt: true,
            members: { select: { userId: true } },
          },
        },
      },
    });
    if (!row) return null;

    const departmentActive = row.department !== null && row.department.archivedAt === null;
    const groupActive = row.responsibleGroup !== null && row.responsibleGroup.archivedAt === null;
    return {
      projectId: row.id,
      departmentId: row.departmentId,
      departmentLeaderId: departmentActive ? row.department?.leaderId ?? null : null,
      departmentActive,
      groupId: row.responsibleGroupId,
      groupActive,
      groupMemberIds: groupActive
        ? [...new Set(row.responsibleGroup?.members.map(member => member.userId) ?? [])].sort()
        : [],
    };
  } catch {
    return null;
  }
}

async function loadScopedGrants(
  db: Pick<DiscussionDb, "scopedPrivilegeAssignment"> & RoleGrantDatabase,
  userIds: readonly string[],
): Promise<Map<string, ScopedPrivilegeGrant[]>> {
  const grants = new Map<string, ScopedPrivilegeGrant[]>();
  let loaded;
  try { loaded = await loadRoleGrants(db, userIds); } catch { return grants; }
  for (const grant of loaded) {
    if (grant.visibility !== "board") continue;
    const list = grants.get(grant.userId) ?? [];
    list.push(grant); grants.set(grant.userId, list);
  }
  return grants;
}

/**
 * The exact set of candidate users who may read the internal part of this
 * board. Group membership is taken from the persisted active group, leadership
 * from the configured active department, administrators from `globalRole`, and
 * department/board administrators from explicit scoped grants.
 */
export async function resolveInternalReaderIds(
  db: Pick<DiscussionDb, "user" | "scopedPrivilegeAssignment"> & RoleGrantDatabase,
  facts: ProjectDiscussionFacts,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const candidates = [...new Set(candidateIds)].filter(Boolean);
  const readers = new Set<string>();
  if (candidates.length === 0) return readers;

  const candidateSet = new Set(candidates);
  if (facts.groupActive) {
    for (const userId of facts.groupMemberIds) {
      if (candidateSet.has(userId)) readers.add(userId);
    }
  }
  if (facts.departmentActive && facts.departmentLeaderId && candidateSet.has(facts.departmentLeaderId)) {
    readers.add(facts.departmentLeaderId);
  }

  try {
    const admins = await db.user.findMany({
      where: { id: { in: candidates }, globalRole: "ADMIN" },
      select: { id: true },
    });
    for (const admin of admins) {
      if (candidateSet.has(admin.id)) readers.add(admin.id);
    }
  } catch {
    // Administrator lookup failure adds no readers.
  }

  const grants = await loadScopedGrants(db, candidates);
  const activeDepartmentId = facts.departmentActive ? facts.departmentId : null;
  for (const [userId, userGrants] of grants) {
    if (!candidateSet.has(userId)) continue;
    const decision = evaluateScopedPrivileges({
      globalAdmin: false,
      projectId: facts.projectId,
      activeDepartmentId,
    }, userGrants);
    if (decision.internalRead.allowed) readers.add(userId);
  }

  return readers;
}

/** Server-side answer for the current actor; never accepts a client flag. */
export async function canActorReadInternal(
  db: Pick<DiscussionDb, "project" | "user" | "scopedPrivilegeAssignment"> & RoleGrantDatabase,
  actor: Readonly<{ id: string; globalRole: "USER" | "ADMIN" }>,
  facts: ProjectDiscussionFacts | null,
): Promise<boolean> {
  if (facts === null) return actor.globalRole === "ADMIN";
  const readers = await resolveInternalReaderIds(db, facts, [actor.id]);
  const accessFacts: InternalAccessFacts = {
    globalRole: actor.globalRole,
    activeGroupMember: facts.groupActive && facts.groupMemberIds.includes(actor.id),
    activeDepartmentLeader: facts.departmentActive && facts.departmentLeaderId === actor.id,
    scopedInternalGrant: readers.has(actor.id),
  };
  return canReadInternalDiscussion(accessFacts);
}

function isMissingInternalColumn(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const metaCode = (error as { meta?: { code?: unknown } }).meta?.code;
  const message = (error as { message?: unknown }).message;
  return (code === "P2010" && metaCode === "42703")
    || (typeof message === "string" && /column\s+"?isInternal"?\s+does not exist/i.test(message));
}

/**
 * Internal message ids of one task.
 *
 * `null` means the `isInternal` column is not migrated yet: in that state no
 * message can have been stored as internal, so legacy behaviour (everything is
 * ordinary) is preserved. Any other storage failure is rethrown, so a broken
 * database cannot silently widen visibility.
 */
export async function loadInternalMessageIds(
  db: DiscussionDb,
  taskId: string,
): Promise<Set<string> | null> {
  try {
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ChatMessage"
      WHERE "taskId" = ${taskId} AND "isInternal" = true
    `;
    return new Set(rows.map(row => row.id));
  } catch (error) {
    if (isMissingInternalColumn(error)) return null;
    throw error;
  }
}

/** Must run inside the message-creation transaction. A missing column rolls back. */
export async function markMessageInternal(db: DiscussionDb, messageId: string): Promise<void> {
  const updated = await db.$executeRaw`
    UPDATE "ChatMessage" SET "isInternal" = true WHERE "id" = ${messageId}
  `;
  if (updated !== 1) throw new Error("INTERNAL_VISIBILITY_NOT_PERSISTED");
}

export async function loadWatcherIds(db: DiscussionDb, taskId: string): Promise<string[]> {
  try {
    const rows = await db.$queryRaw<Array<{ userId: string }>>`
      SELECT "userId" FROM "TaskWatcher" WHERE "taskId" = ${taskId}
    `;
    return [...new Set(rows.map(row => row.userId))].sort();
  } catch {
    // Missing table or failed read: no watchers, never an access grant.
    return [];
  }
}

export async function isTaskWatcher(
  db: DiscussionDb,
  taskId: string,
  userId: string,
): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<Array<{ userId: string }>>`
      SELECT "userId" FROM "TaskWatcher"
      WHERE "taskId" = ${taskId} AND "userId" = ${userId}
      LIMIT 1
    `;
    return rows.length === 1;
  } catch {
    return false;
  }
}
