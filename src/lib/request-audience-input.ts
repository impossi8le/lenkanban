import type { Prisma } from "@prisma/client";
import type { CreateTaskInput } from "./validators";
import { getProjectRequestStaffWhere } from "./project-request-execution-policy";
import { ForbiddenError } from "./errors";

/** Freeze set order before hashing, so equivalent recipient sets have one intent. */
export function audienceRecipientIds(audience: CreateTaskInput["audience"]): string[] {
  return audience?.mode === "SELECTED" ? [...audience.userIds].sort() : [];
}

/** Caller holds the Project lock. Lock membership/user rows until creation commits. */
export async function validateRequestRecipients(tx: Prisma.TransactionClient, projectId: string, userIds: readonly string[]): Promise<void> {
  if (!userIds.length) return;
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { departmentId: true, responsibleGroupId: true } });
  if (project?.departmentId) {
    await tx.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ${project.departmentId} FOR SHARE`;
  } else if (project?.responsibleGroupId) {
    await tx.$queryRaw`SELECT "id" FROM "ResponsibleGroup" WHERE "id" = ${project.responsibleGroupId} FOR SHARE`;
    await tx.$queryRaw`SELECT "userId" FROM "ResponsibleGroupMember" WHERE "groupId" = ${project.responsibleGroupId} AND "userId" = ANY(${[...userIds]}::text[]) ORDER BY "userId" FOR SHARE`;
  }
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(${[...userIds]}::text[]) ORDER BY "id" FOR SHARE`;
  const staff = await getProjectRequestStaffWhere(projectId, tx);
  const recipients = staff === null ? [] : await tx.user.findMany({ where: { AND: [staff, { id: { in: [...userIds] } }] }, select: { id: true } });
  if (recipients.length !== userIds.length || userIds.some(id => !recipients.some(user => user.id === id))) throw new ForbiddenError("Недоступные получатели обращения");
}
