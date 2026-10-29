import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Caller already holds Project/Task/actor locks. Hold authority until commit. */
export async function lockProjectStatusAuthority(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  actorId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string; userId: string }[]>`
    SELECT g."id", gm."userId"
    FROM "Project" p
    JOIN "ResponsibleGroup" g ON g."id" = p."responsibleGroupId"
    JOIN "ResponsibleGroupMember" gm ON gm."groupId" = g."id"
    WHERE p."id" = ${projectId} AND g."archivedAt" IS NULL AND gm."userId" = ${actorId}
    FOR SHARE OF g, gm
  `;
  // A missing row is a denial, never permission to re-read a later inserted
  // membership that this transaction has not locked.
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row = rows[0];
  return row !== null && typeof row === "object" && typeof row.id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(row.id) && row.userId === actorId;
}

/** Additional raw-status restriction; callers still enforce their existing write authorization. */
export async function getProjectStatusPolicy(
  actor: Pick<User, "id" | "globalRole">,
  projectId: string,
  database: Pick<Prisma.TransactionClient, "project"> = prisma,
): Promise<{ canChangeStatus: boolean }> {
  if (actor.globalRole === "ADMIN") return { canChangeStatus: true };
  const project = await database.project.findUnique({
    where: { id: projectId },
    select: {
      responsibleGroup: {
        select: {
          archivedAt: true,
          members: { where: { userId: actor.id }, select: { userId: true }, take: 1 },
        },
      },
    },
  });
  const group = project?.responsibleGroup;
  return { canChangeStatus: Boolean(group && group.archivedAt === null && (
    group.members.some(member => member.userId === actor.id)
  )) };
}
