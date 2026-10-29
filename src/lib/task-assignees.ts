import type { Prisma } from "@prisma/client";
import { ownTaskProjectIds } from "@/lib/access-policy";
import { logActivityWithClient } from "@/lib/activity-logger";
import { prepareLegacyTaskScalarBatch } from "@/lib/task-command";
import { BadRequestError, NotFoundError } from "@/lib/errors";

/** Caller owns commit and delivery. All assignment writers use the same locked guard. */
export async function replaceTaskAssigneesWithClient({ tx, actorId, taskId, projectId, userIds: requestedIds }: {
  tx: Prisma.TransactionClient;
  actorId: string;
  taskId: string;
  projectId: string;
  userIds: readonly string[];
}) {
  const userIds = [...new Set(requestedIds)];
  const [lockedTask] = await prepareLegacyTaskScalarBatch({
    tx, actorId, expectedTasks: [{ id: taskId, projectId }], requireAssignmentAuthority: true,
  });
  if (!lockedTask) throw new NotFoundError();
  // The shared batch guard checks fresh ADMIN/owner/member access under locks.
  // OWN boards additionally retain the route's restricted legacy capability.
  if (ownTaskProjectIds(process.env.LENKANBAN_OWN_TASK_PROJECT_IDS).includes(projectId)) {
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { globalRole: true } });
    if (!actor || actor.globalRole !== "ADMIN") throw new NotFoundError();
    if (userIds.length > 1) throw new BadRequestError();
  }
  if (userIds.length > 0) {
    const projectMembers = await tx.projectMember.findMany({
      where: { projectId: lockedTask.projectId, userId: { in: userIds } },
    });
    const ownerCheck = await tx.project.findFirst({
      where: { id: lockedTask.projectId, ownerId: { in: userIds } },
    });
    const validUserIds = new Set([
      ...projectMembers.map(member => member.userId),
      ...(ownerCheck ? [ownerCheck.ownerId] : []),
    ]);
    if (userIds.some(id => !validUserIds.has(id))) throw new BadRequestError();
  }
  const existingAssignees = await tx.taskAssignee.findMany({
    where: { taskId },
    include: { user: { select: { name: true, email: true } } },
  });
  const existingUserIds = new Set(existingAssignees.map(assignee => assignee.userId));
  const requestedUserIds = new Set(userIds);
  const added = userIds.filter(id => !existingUserIds.has(id));
  const removed = existingAssignees.filter(assignee => !requestedUserIds.has(assignee.userId));
  if (added.length > 0 || removed.length > 0) {
    await tx.taskAssignee.deleteMany({ where: { taskId } });
    if (userIds.length > 0) {
      await tx.taskAssignee.createMany({
        data: userIds.map(userId => ({ taskId, userId })),
      });
    }
    const addedUsers = added.length > 0 ? await tx.user.findMany({
      where: { id: { in: added } },
      select: { id: true, name: true, email: true },
    }) : [];
    for (const assignee of addedUsers) {
      await logActivityWithClient(tx, {
        taskId, userId: actorId, action: "assigned",
        newValue: { assigneeId: assignee.id, assigneeName: assignee.name || assignee.email },
      });
    }
    for (const assignee of removed) {
      await logActivityWithClient(tx, {
        taskId, userId: actorId, action: "unassigned",
        oldValue: { assigneeId: assignee.userId, assigneeName: assignee.user.name || assignee.user.email },
      });
    }
  }

  // Capture the committed response and notification facts under the Task lock.
  const updatedTask = await tx.task.findUnique({
    where: { id: taskId },
    include: {
      assignees: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
      tags: {
        include: {
          tag: true,
        },
      },
      checklistItems: {
        orderBy: { position: 'asc' },
      },
      project: {
        select: { id: true },
      },
    },
  });
  if (!updatedTask) throw new NotFoundError();
  return { updatedTask, projectId: lockedTask.projectId, title: updatedTask.title, added };
}
