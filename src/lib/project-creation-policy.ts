import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getProjectCreateAccess } from "@/lib/project-access";
import { hasActiveResponsibleGroupMembership } from "@/lib/access-policy";

export type ProjectCreationPolicy = {
  projectId: string;
  canCreate: boolean;
  /** null preserves the existing unrestricted column choice; [] denies creation. */
  allowedColumnIds: string[] | null;
};

/** Initial submission does not let an applicant choose a later workflow state. */
export async function getProjectCreationPolicy(
  actor: Pick<User, "id" | "globalRole">,
  projectId: string,
  database: Pick<Prisma.TransactionClient, "project" | "user" | "responsibleGroupMember"> = prisma,
): Promise<ProjectCreationPolicy> {
  const access = await getProjectCreateAccess(actor, projectId, database);
  if (!access.canCreate) return { ...access, allowedColumnIds: [] };
  if (actor.globalRole === "ADMIN") return { ...access, allowedColumnIds: null };
  const project = await database.project.findUnique({
    where: { id: projectId },
    select: {
      responsibleGroup: { select: { archivedAt: true, members: { where: { userId: actor.id }, select: { userId: true }, take: 1 } } },
      columns: { where: { workflowKey: "TODO" }, orderBy: [{ position: "asc" }, { id: "asc" }], select: { id: true }, take: 1 },
    },
  });
  if (!project) return { projectId, canCreate: false, allowedColumnIds: [] };
  if (hasActiveResponsibleGroupMembership(project.responsibleGroup, actor.id)) return { ...access, allowedColumnIds: null };
  return { ...access, allowedColumnIds: project.columns.map(column => column.id) };
}

export function isCreationColumnAllowed(policy: ProjectCreationPolicy, columnId: string): boolean {
  return policy.canCreate && (policy.allowedColumnIds === null || policy.allowedColumnIds.includes(columnId));
}
