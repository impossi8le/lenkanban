import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { deliverNotifications, isNotificationVisible } from "./notifications";

export function deadlineNotificationKey(taskId: string, deadline: Date): string {
  return createHash("sha256").update(JSON.stringify([taskId, "task_deadline_approaching", deadline.toISOString()])).digest("hex");
}

/** The existing notification PK enforces uniqueness even for concurrent workers. */
export async function createDeadlineReminders(params: {
  taskId: string; taskTitle: string; projectId: string; deadline: Date; userIds: readonly string[];
}) {
  const key = deadlineNotificationKey(params.taskId, params.deadline);
  const data = [];
  for (const userId of new Set(params.userIds)) {
    const row = {
      id: `deadline_${createHash("sha256").update(JSON.stringify([key, userId])).digest("hex")}`,
      userId,
      type: "task_deadline_approaching",
      title: "Приближается дедлайн",
      message: `Задача "${params.taskTitle}" должна быть завершена завтра`,
      actionUrl: `/projects/${params.projectId}/board?task=${params.taskId}`,
      metadata: { taskId: params.taskId, projectId: params.projectId, deadline: params.deadline.toISOString(), deduplicationKey: key },
    };
    if (await isNotificationVisible(row)) data.push(row);
  }
  if (data.length === 0) return { count: 0 };
  const created = await prisma.notification.createManyAndReturn({ data, skipDuplicates: true });
  deliverNotifications(created);
  return { count: created.length };
}
