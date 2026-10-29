import type { Prisma } from "@prisma/client";
import { getTaskReadWhere } from "@/lib/project-access";
import { decodeStoredTaskRequest } from "@/lib/task-request-marker-lifecycle";

/** One canonical marker projection for every related-request endpoint check. */
export const relatedMarkerSelect = { taskId: true, contractVersion: true, state: true, authorId: true,
  executorId: true, needsInfoSince: true, pausedTotalMs: true, deletedAt: true } as const;
export const relatedEndpointSelect = { id: true, projectId: true,
  request: { select: relatedMarkerSelect } } as const;

type Reader = Readonly<{ id: string; globalRole: "USER" | "ADMIN" }>;
type Database = Pick<Prisma.TransactionClient, "task" | "project" | "scopedPrivilegeAssignment">;
export type RelatedEndpoint = Prisma.TaskGetPayload<{ select: typeof relatedEndpointSelect }>;
export type RelatedEndpointAvailability = { available: true }
  | { available: false; reason: "deleted" | "invalid_marker" };

/**
 * Shared endpoint availability for the related graph and related history:
 * readable task, not soft-deleted, and a fully valid canonical marker when one
 * is stored. An absent marker is a legacy task, never corruption.
 */
export function relatedEndpointAvailability(
  task: Pick<RelatedEndpoint, "id" | "request">,
): RelatedEndpointAvailability {
  if (task.request == null) return { available: true };
  if (task.request.deletedAt !== null) return { available: false, reason: "deleted" };
  const { deletedAt: _deletedAt, ...marker } = task.request; void _deletedAt;
  return decodeStoredTaskRequest(marker, task.id).valid
    ? { available: true } : { available: false, reason: "invalid_marker" };
}

/** Null closes the endpoint for both channels, so no caller can leak its ID. */
export async function findAvailableRelatedEndpoint(
  database: Database,
  actor: Reader,
  taskId: string,
): Promise<RelatedEndpoint | null> {
  const task = await database.task.findFirst({
    where: await getTaskReadWhere(actor, { id: taskId }, database),
    select: relatedEndpointSelect,
  });
  if (!task) return null;
  return relatedEndpointAvailability(task).available ? task : null;
}
