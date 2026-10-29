import type { Prisma } from "@prisma/client";
import type { TaskType } from "@/components/kanban/Card";
import {
  publicTaskAttachmentDTOs,
  toPublicAttachmentDTOs,
  type StoredAttachment,
  effectiveBeznalPhase,
} from "@/lib/attachments/task-port";
import { isBeznalProject } from "@/lib/request-presentation";

export const taskDetailInclude = {
  activities: {
    where: { action: "description_changed", newValue: { path: ["afterSubmission"], equals: true } },
    select: { createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
  },
  createdBy: { select: { id: true, name: true, primaryDepartment: { select: { name: true } } } },
  request: { select: { state: true, executorId: true, audienceUserIds: true, beznalPhase: true,
    author: { select: { id: true, name: true } }, executor: { select: { id: true, name: true } },
  } },
  column: { select: { id: true, name: true, color: true } },
  project: { select: { id: true, name: true } },
  assignees: {
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
  },
  tags: { include: { tag: true } },
  checklistItems: { orderBy: { position: "asc" } },
} satisfies Prisma.TaskInclude;

type CompleteStoredTask = Prisma.TaskGetPayload<{ include: typeof taskDetailInclude }>;
type PresentationRelations = "createdBy" | "request" | "column" | "project" | "activities";
type RequestPresentationInput = (Omit<NonNullable<CompleteStoredTask["request"]>, "beznalPhase"> & { beznalPhase?: string | null }) | null;
type StoredTask = Omit<CompleteStoredTask, PresentationRelations> & Partial<Pick<CompleteStoredTask, Exclude<PresentationRelations, "request">>> & { request?: RequestPresentationInput };

/** Safe presentation for detail, mutation responses and realtime snapshots. */
export function toDescriptionEditedAt(activities: readonly { createdAt: Date }[] | undefined): string | null {
  const editedAt = activities?.[0]?.createdAt;
  return editedAt instanceof Date && Number.isFinite(editedAt.getTime()) ? editedAt.toISOString() : null;
}

export function toTaskRequestPresentation(request: RequestPresentationInput, context?: { isBeznal: boolean; attachments: unknown }): NonNullable<TaskType["request"]> | null {
  return request ? {
    state: request.state,
    executorId: request.executorId,
    beznalPhase: context?.isBeznal ? effectiveBeznalPhase(request.beznalPhase, context.attachments) : null,
    isPersonal: (request.audienceUserIds?.length ?? 0) > 0,
    author: request.author ? { id: request.author.id, name: request.author.name } : null,
    executor: request.executor ? { id: request.executor.id, name: request.executor.name } : null,
  } : null;
}

export function toTaskDetailDTO(
  task: StoredTask,
  readableAttachments?: readonly StoredAttachment[],
): TaskType {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    descriptionEditedAt: toDescriptionEditedAt(task.activities),
    status: task.status,
    priority: task.priority,
    position: task.position,
    version: task.version,
    projectId: task.projectId,
    columnId: task.columnId,
    createdById: task.createdById ?? undefined,
    ...(task.createdBy !== undefined ? { createdBy: task.createdBy } : {}),
    ...(task.request !== undefined ? { request: toTaskRequestPresentation(task.request, { isBeznal: isBeznalProject(task.project?.name), attachments: task.attachments }) } : {}),
    ...(task.column !== undefined ? { column: task.column } : {}),
    ...(task.project !== undefined ? { project: task.project } : {}),
    deadline: task.deadline,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    // The actor-aware caller passes the fresh ACL result. A missing caller
    // projection still fails closed and never emits an internal URL.
    attachments: readableAttachments
      ? toPublicAttachmentDTOs(readableAttachments)
      : publicTaskAttachmentDTOs(task.attachments),
    assignees: task.assignees.map(({ id, user }) => ({
      id,
      user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
    })),
    tags: task.tags.map(({ id, tag }) => ({ id, tag: { id: tag.id, name: tag.name, color: tag.color } })),
    checklistItems: task.checklistItems.map(item => ({
      id: item.id,
      taskId: item.taskId,
      text: item.text,
      completed: item.completed,
      position: item.position,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
  };
}
