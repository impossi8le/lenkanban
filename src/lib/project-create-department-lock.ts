import type { Prisma } from "@prisma/client";

/** Caller holds Project and actor SHARE. Keep department archival behind commit. */
export async function lockProjectCreationDepartment(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { departmentId: true } });
  if (!project?.departmentId) return false;
  await tx.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ${project.departmentId} FOR SHARE`;
  return true;
}
