import type { Prisma } from "@prisma/client";

/** List narrowing only. Direct reads retain the shared author/draft ACL. */
export function taskListVisibilityWhere(): Prisma.TaskWhereInput {
  return { OR: [
    { request: { is: null } },
    { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } },
  ] };
}

/** Use only on a hydrated, reader-authorized snapshot; absent marker is unknown. */
export function isTaskVisibleInRequestList(task: { request?: { state?: unknown; deletedAt?: unknown } | null }): boolean {
  if (task.request === null) return true;
  return task.request !== undefined && task.request.deletedAt == null
    && ["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED", "CANCELLED"].includes(String(task.request.state));
}
