import type { Notification, Prisma } from "@prisma/client";
import { createNotifications, filterTaskNotificationRecipientIds, persistNotificationsWithClient, type CreateNotificationParams, type NotificationVisibilityDb } from "@/lib/notifications";

import {
  loadProjectDiscussionFacts,
  loadWatcherIds,
  resolveInternalReaderIds,
  type DiscussionDb,
  type ProjectDiscussionFacts,
} from "./discussion-access";
import {
  resolveCommentRecipients,
  resolveQueueRecipients,
  type CommentVisibility,
} from "./discussion-policy";

type NotificationDb = DiscussionDb & Pick<DiscussionDb, "task">;

export type CommentNotificationContext = Readonly<{
  taskTitle: string;
  projectId: string;
  authorId: string | null;
  executorId: string | null;
  watcherIds: readonly string[];
  assigneeIds: readonly string[];
  managementIds: readonly string[];
  projectFacts: ProjectDiscussionFacts | null;
}>;

/**
 * Loads the recipients' facts after the message is committed. Watchers come
 * from the forward-compatible `TaskWatcher` table; a missing table simply
 * means "no watchers". The configured leadership is the active department
 * leader of the board - no hierarchy walk and no whole-group broadcast.
 */
export async function loadCommentNotificationContext(
  db: NotificationDb,
  taskId: string,
): Promise<CommentNotificationContext | null> {
  try {
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        createdById: true,
        request: { select: { authorId: true, executorId: true } },
        assignees: { select: { userId: true } },
      },
    });
    if (!task) return null;

    const projectFacts = await loadProjectDiscussionFacts(db, task.projectId);
    const watcherIds = await loadWatcherIds(db, taskId);
    return {
      taskTitle: task.title,
      projectId: task.projectId,
      // Legacy tasks have no request marker; their creator is the author who must hear back.
      authorId: task.request?.authorId ?? task.createdById ?? null,
      executorId: task.request?.executorId ?? null,
      watcherIds,
      // Legacy tasks have no request marker; their assignees are the only
      // persisted executor-like role. Marker tasks use the single executor.
      assigneeIds: task.request === null ? task.assignees.map(assignee => assignee.userId) : [],
      managementIds: projectFacts?.departmentActive && projectFacts.departmentLeaderId
        ? [projectFacts.departmentLeaderId]
        : [],
      projectFacts,
    };
  } catch {
    return null;
  }
}

/**
 * Delivers notifications for one committed message. Recipients are computed at
 * delivery time, deduplicated by Set and filtered for the internal part. The
 * responsible group is deliberately absent: it is notified on queue entry, not
 * on every comment.
 */
type ContentNotificationParams = Readonly<{
  db: NotificationDb;
  taskId: string;
  actorId: string;
  actorName: string;
  visibility: CommentVisibility;
  excludedRecipientIds?: readonly string[];
  event?: "comment" | "file" | "return_for_revision" | "approval" | "invoice_ready";
  eventId?: string;
}>;

async function contentNotificationRows(params: ContentNotificationParams): Promise<CreateNotificationParams[]> {
  const context = await loadCommentNotificationContext(params.db, params.taskId);
  if (context === null) return [];

  const candidates = [...new Set([
    context.authorId,
    context.executorId,
    ...context.watcherIds,
    ...context.assigneeIds,
  ].filter((userId): userId is string => Boolean(userId)))];

  const internalReaderIds = params.visibility === "INTERNAL" && context.projectFacts
    ? await resolveInternalReaderIds(params.db, context.projectFacts, candidates)
    : new Set<string>();

  const candidatesForDelivery = resolveCommentRecipients({
    actorId: params.actorId,
    visibility: params.visibility,
    authorId: context.authorId,
    executorId: context.executorId,
    watcherIds: context.watcherIds,
    assigneeIds: context.assigneeIds,
    // Management is not an implicit subscription to every working action.
    managementIds: [],
    internalReaderIds,
  });
  const excluded = new Set(params.excludedRecipientIds ?? []);
  const recipients = await filterTaskNotificationRecipientIds(params.db,
    params.taskId, context.projectId, candidatesForDelivery.filter(id => !excluded.has(id)));
  if (recipients.length === 0) return [];

  const event = params.event ?? "comment";
  const title = event === "approval" ? "Счёт принят, обращение закрыто" : event === "invoice_ready" ? "Счёт готов к приёмке" : event === "file" ? "В обращение добавлен файл" : event === "return_for_revision" ? "Обращение возвращено на доработку"
    : params.visibility === "INTERNAL" ? "Новое внутреннее сообщение в задаче" : "Новое сообщение в задаче";
  const action = event === "approval" ? "принял счёт и закрыл обращение" : event === "invoice_ready" ? "подготовил счёт в обращении" : event === "file" ? "добавил файл в обращение" : event === "return_for_revision" ? "вернул на доработку обращение" : "написал в задаче";
  return recipients.map(userId => ({
    userId,
    type: "chat_message" as const,
    title,
    message: `${params.actorName} ${action} "${context.taskTitle}"`,
    actionUrl: `/projects/${context.projectId}/board?task=${params.taskId}`,
    metadata: {
      taskId: params.taskId,
      projectId: context.projectId,
      authorId: params.actorId,
      visibility: params.visibility,
      ...(params.event ? { event: params.event } : {}),
      ...(params.eventId ? { eventId: params.eventId } : {}),
    },
  }));
}

/** Legacy post-commit entry point, sharing the same recipient policy. */
export async function dispatchCommentNotifications(params: ContentNotificationParams): Promise<string[]> {
  const rows = await contentNotificationRows(params);
  if (rows.length) await createNotifications(rows);
  return rows.map(row => row.userId);
}

/** Persist inside the EXISTING successful content transaction. The caller's
 * message/append/lifecycle receipt is the replay gate; eventId identifies that
 * exact new message or Activity. Deliver returned rows only AFTER commit via
 * existing deliverNotifications; no second dispatch for the same operation.
 */
export async function persistTaskContentNotifications(params: Omit<ContentNotificationParams, "db" | "event" | "eventId"> & {
  db: NotificationDb & NotificationVisibilityDb & Pick<Prisma.TransactionClient, "notification">;
  event: "comment" | "file" | "return_for_revision" | "approval" | "invoice_ready";
  eventId: string;
}): Promise<Notification[]> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.eventId)) throw new Error("INVALID_NOTIFICATION_EVENT_ID");
  if (["return_for_revision","approval","invoice_ready"].includes(params.event) && params.visibility !== "PUBLIC") throw new Error("PUBLIC_REVISION_EVENT_REQUIRED");
  return persistNotificationsWithClient(params.db, await contentNotificationRows(params));
}

/**
 * Queue notifications (request submitted / returned to the queue).
 *
 * The responsible group is notified here - once per queue entry - and not on
 * every comment. The lifecycle owner calls this after the committed transition;
 * recipients are deduplicated and the actor is excluded.
 */
export async function dispatchQueueNotifications(params: Readonly<{
  db: NotificationDb;
  taskId: string;
  actorId: string;
  actorName: string;
}>): Promise<string[]> {
  const context = await loadCommentNotificationContext(params.db, params.taskId);
  if (context === null || context.projectFacts === null) return [];

  const candidates = resolveQueueRecipients({
    actorId: params.actorId,
    groupMemberIds: context.projectFacts.groupMemberIds,
    managementIds: context.managementIds,
  });
  const recipients = await filterTaskNotificationRecipientIds(params.db,
    params.taskId, context.projectId, candidates);
  if (recipients.length === 0) return [];

  await createNotifications(recipients.map(userId => ({
    userId,
    type: "task_assigned" as const,
    title: "Заявка поступила в очередь",
    message: `${params.actorName}: заявка "${context.taskTitle}" поступила в очередь`,
    actionUrl: `/projects/${context.projectId}/board?task=${params.taskId}`,
    metadata: {
      taskId: params.taskId,
      projectId: context.projectId,
      actorId: params.actorId,
      reason: "queue",
    },
  })));

  return recipients;
}
