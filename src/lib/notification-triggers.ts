import { prisma } from "./prisma";
import { createNotification, createNotifications } from "./notifications";
import { dispatchCommentNotifications, dispatchQueueNotifications } from "@/app/api/tasks/[id]/messages/discussion-notifications";

/**
 * Notify the board's responsible group that a request entered its queue.
 *
 * This is the single queue-entry trigger: the lifecycle transition calls it
 * once per committed submit. The recipient policy, deduplication and delivery
 * live in the existing discussion notification module; this function adds no
 * second notification system.
 */
export async function notifyTaskRequestQueueEntered(params: {
  taskId: string;
  projectId: string;
  actorId: string;
  actorName: string;
}): Promise<string[]> {
  return dispatchQueueNotifications({
    db: prisma,
    taskId: params.taskId,
    actorId: params.actorId,
    actorName: params.actorName,
  });
}

/**
 * Notify user when they are assigned to a task
 */
export async function notifyTaskAssigned(params: {
  taskId: string;
  taskTitle: string;
  projectId: string;
  assigneeId: string;
  assignedById: string;
  assignedByName: string;
}) {
  const { taskId, taskTitle, projectId, assigneeId, assignedById, assignedByName } = params;

  // Don't notify if user assigned themselves
  if (assigneeId === assignedById) {
    return;
  }

  await createNotification({
    userId: assigneeId,
    type: "task_assigned",
    title: "Вам назначена задача",
    message: `${assignedByName} назначил вас на задачу "${taskTitle}"`,
    actionUrl: `/projects/${projectId}/board?task=${taskId}`,
    metadata: {
      taskId,
      projectId,
      assignedById,
    },
  });
}

/**
 * Notify assignees when task status changes
 */
export async function notifyTaskTakenOver(params: {
  taskId: string; projectId: string; previousExecutorId: string; actorId: string; actorName: string;
}) {
  if (params.previousExecutorId === params.actorId) return;
  await createNotification({
    userId: params.previousExecutorId,
    type: "task_assigned",
    title: "Обращение взял другой исполнитель",
    message: `${params.actorName} взял обращение на себя`,
    actionUrl: `/projects/${params.projectId}/board?task=${params.taskId}`,
    metadata: { taskId: params.taskId, projectId: params.projectId, assignedById: params.actorId },
  });
}

export async function notifyTaskStatusChanged(params: {
  taskId: string;
  taskTitle: string;
  projectId: string;
  oldStatus: string;
  newStatus: string;
  changedById: string;
  changedByName: string;
}) {
  const { taskId, taskTitle, projectId, oldStatus, newStatus, changedById, changedByName } = params;

  // Get task assignees
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignees: {
        select: { userId: true },
      },
    },
  });

  if (!task || task.assignees.length === 0) {
    return;
  }

  const statusLabels: Record<string, string> = {
    TODO: "К выполнению",
    IN_PROGRESS: "В работе",
    IN_REVIEW: "На проверке",
    DONE: "Готово",
  };

  const notifications = task.assignees
    .filter((a) => a.userId !== changedById) // Don't notify the person who made the change
    .map((assignee) => ({
      userId: assignee.userId,
      type: "task_status_changed" as const,
      title: "Статус задачи изменен",
      message: `${changedByName} изменил статус задачи "${taskTitle}" на "${statusLabels[newStatus] || newStatus}"`,
      actionUrl: `/projects/${projectId}/board?task=${taskId}`,
      metadata: {
        taskId,
        projectId,
        oldStatus,
        newStatus,
        changedById,
      },
    }));

  if (notifications.length > 0) {
    await createNotifications(notifications);
  }
}

/**
 * Notify user when they are mentioned in a chat message
 */
export async function notifyMentioned(params: {
  taskId: string;
  taskTitle: string;
  projectId: string;
  mentionedUserId: string;
  mentionedById: string;
  mentionedByName: string;
  messagePreview: string;
}) {
  const { taskId, taskTitle, projectId, mentionedUserId, mentionedById, mentionedByName, messagePreview } = params;

  // Don't notify if user mentioned themselves
  if (mentionedUserId === mentionedById) {
    return;
  }

  await createNotification({
    userId: mentionedUserId,
    type: "task_mentioned",
    title: "Вас упомянули в чате",
    message: `${mentionedByName} упомянул вас в задаче "${taskTitle}": ${messagePreview}`,
    actionUrl: `/projects/${projectId}/board?task=${taskId}`,
    metadata: {
      taskId,
      projectId,
      mentionedById,
    },
  });
}

/**
 * Notify assignees when task deadline is approaching (1 day before)
 */
export async function notifyDeadlineApproaching(params: {
  taskId: string;
  taskTitle: string;
  projectId: string;
  deadline: Date;
}) {
  const { taskId, taskTitle, projectId, deadline } = params;

  // Get task assignees
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignees: {
        select: { userId: true },
      },
    },
  });

  if (!task || task.assignees.length === 0) {
    return;
  }

  const notifications = task.assignees.map((assignee) => ({
    userId: assignee.userId,
    type: "task_deadline_approaching" as const,
    title: "Приближается дедлайн",
    message: `Задача "${taskTitle}" должна быть завершена завтра`,
    actionUrl: `/projects/${projectId}/board?task=${taskId}`,
    metadata: {
      taskId,
      projectId,
      deadline: deadline.toISOString(),
    },
  }));

  await createNotifications(notifications);
}

/**
 * Notify user when they are added to a project
 */
export async function notifyProjectMemberAdded(params: {
  projectId: string;
  projectName: string;
  userId: string;
  addedById: string;
  addedByName: string;
  role: string;
}) {
  const { projectId, projectName, userId, addedById, addedByName, role } = params;

  // Don't notify if user added themselves
  if (userId === addedById) {
    return;
  }

  const roleLabels: Record<string, string> = {
    MEMBER: "участником",
    PROJECT_ADMIN: "администратором",
  };

  await createNotification({
    userId,
    type: "project_member_added",
    title: "Вас добавили в проект",
    message: `${addedByName} добавил вас ${roleLabels[role] || "участником"} проекта "${projectName}"`,
    actionUrl: `/projects/${projectId}/board`,
    metadata: {
      projectId,
      addedById,
      role,
    },
  });
}

/**
 * Notify assignees when new chat message is posted
 */
export async function notifyChatMessage(params: {
  taskId: string;
  taskTitle: string;
  projectId: string;
  authorId: string;
  authorName: string;
  messagePreview: string;
  excludedRecipientIds?: readonly string[];
}) {
  // Retained for legacy callers; new transactional writers persist the same
  // policy before commit and deliver only their exact committed rows.
  return dispatchCommentNotifications({ db: prisma, taskId: params.taskId,
    actorId: params.authorId, actorName: params.authorName, visibility: "PUBLIC",
    excludedRecipientIds: params.excludedRecipientIds });
}
