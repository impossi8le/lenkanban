// Helper functions for loading tasks with all relations for real-time updates

import { prisma } from "./prisma";
import { taskDetailInclude, toDescriptionEditedAt, toTaskRequestPresentation } from "./task-detail-dto";
import { isBeznalProject } from "./request-presentation";
import { readRequestQueueArrivalMap } from "./request-queue-unseen";
import { readVisibleMessageCounts } from "./task-visible-message-counts";
import {
  parseStoredAttachments,
  publicTaskAttachmentDTOs,
  readVisibleTaskAttachments,
} from "./attachments/task-port";

export const TASK_WITH_RELATIONS_INCLUDE = {
  ...taskDetailInclude,
  assignees: {
    include: {
      user: {
        select: { id: true, email: true, name: true, avatarUrl: true },
      },
    },
  },
  tags: {
    include: {
      tag: true,
    },
  },
  checklistItems: {
    orderBy: { position: "asc" } as const,
  },
  project: {
    select: { id: true, name: true },
  },
  _count: {
    select: { messages: true },
  },
} as const;

export async function loadTaskWithRelations(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: TASK_WITH_RELATIONS_INCLUDE,
  });
  if (!task) return null;
  const { activities, ...safeTask } = task;
  return { ...safeTask, descriptionEditedAt: toDescriptionEditedAt(activities), request: toTaskRequestPresentation(task.request, { isBeznal: isBeznalProject(task.project?.name), attachments: task.attachments }) };
}

/**
 * Realtime task payloads are broadcast to a room before the per-socket policy
 * runs. Project the attachment metadata again for that exact recipient: an
 * unauthorized reader receives no internal URL/name/size, and a revoked
 * internal role is rechecked on every event. `null` suppresses the delivery.
 */
export async function projectTaskRealtimeForReader(
  userId: string,
  taskId: string,
  projectId: string | undefined,
  data: unknown,
): Promise<unknown | null> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (row.id !== taskId || (projectId !== undefined && row.projectId !== projectId)) return null;
  const arrivals = await readRequestQueueArrivalMap(prisma, userId, [taskId]);
  if (!arrivals.has(taskId)) return null;
  let projected: Record<string, unknown> = { ...row, queueArrival: arrivals.get(taskId) ?? null };
  if (row._count && typeof row._count === "object" && "messages" in row._count) {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true } });
    if (!actor) return null;
    const count = (await readVisibleMessageCounts(prisma, actor, [taskId])).get(taskId);
    if (!count) return null;
    projected = { ...projected, _count: { ...row._count, messages: count.total }, unreadCount: count.unread };
  }
  if (!Array.isArray(row.attachments)) return projected;

  const stored = parseStoredAttachments(row.attachments);
  if (!stored.some(attachment => attachment.isInternal)) {
    // Public-only payloads still drop the server-owned classification field.
    return { ...projected, attachments: publicTaskAttachmentDTOs(row.attachments) };
  }

  const scope = typeof projectId === "string" && projectId
    ? projectId
    : typeof row.projectId === "string" && row.projectId ? row.projectId : null;
  if (scope === null || row.id !== taskId) return null;

  const actor = await prisma.user.findUnique({
    where: { id: userId }, select: { id: true, globalRole: true },
  });
  if (!actor) return null;
  const attachments = await readVisibleTaskAttachments(prisma, actor, scope, row.attachments);
  return attachments === undefined ? null : { ...projected, attachments };
}
