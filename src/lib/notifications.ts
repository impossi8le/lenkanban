import { prisma } from "./prisma";
import { rateLimitOrThrowKey } from "./rate-limit";
import { socketLogger } from "./logger";
import type { Notification, Prisma } from "@prisma/client";
import { emitUserNotification, emitUserNotificationChanged } from "@/socket/board-events";
import { getProjectAccess, getTaskReadWhere } from "./project-access";
import { isAccountAllowed } from "./auth";
import { canActorReadInternal, loadProjectDiscussionFacts } from "@/app/api/tasks/[id]/messages/discussion-access";
import { effectiveBeznalPhase, readVisibleTaskAttachments } from "./attachments/task-port";
import { getRequestBoardPhase } from "./request-board-phase";
import { isBeznalProject, isClaimProject } from "./request-presentation";

export type CurrentNotificationTask = {
  taskId: string;
  projectId: string;
  phase: { code: string; label: string };
};

/** Event text is historical; this fresh, actor-scoped projection describes now.
 * One batched task read for the feed, never a task query per notification.
 */
async function withCurrentTaskPhases(userId: string, rows: Notification[]) {
  if (!rows.length) return rows;
  const taskTargets = rows.map(row => notificationTarget(row)).filter(target => target?.kind === "task");
  if (!taskTargets.length) return rows;
  if (!(await isAccountAllowed(userId))) return [];
  const actor = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true } });
  if (!actor) return [];
  const tasks = await prisma.task.findMany({
    where: await getTaskReadWhere(actor, { id: { in: [...new Set(taskTargets.map(target => target.taskId))] } }),
    select: { id: true, projectId: true, status: true, attachments: true,
      request: { select: { state: true, beznalPhase: true } }, column: { select: { name: true } },
      project: { select: { name: true } } },
  });
  const phases = new Map<string, CurrentNotificationTask>();
  const readable = new Set(tasks.map(task => task.id));
  for (const task of tasks) {
    // Partial/legacy projections cannot invent a current board status.
    if (!task.projectId || !task.project || !task.status) continue;
    const beznal = isBeznalProject(task.project.name);
    const attachments = beznal ? await readVisibleTaskAttachments(prisma, actor, task.projectId, task.attachments) : undefined;
    phases.set(task.id, { taskId: task.id, projectId: task.projectId,
      phase: getRequestBoardPhase({ ...task, attachments, request: beznal
        ? { ...task.request, beznalPhase: effectiveBeznalPhase(task.request?.beznalPhase, task.attachments) } : task.request }, beznal, isClaimProject(task.project.name)) });
  }
  return rows.flatMap(row => {
    const target = notificationTarget(row);
    if (target?.kind !== "task") return [row];
    // A revoked task is removed even if the earlier page-visibility read passed.
    if (!readable.has(target.taskId)) return [];
    const currentTask = phases.get(target.taskId);
    if (currentTask && currentTask.projectId !== target.projectId) return [];
    return [{ ...row, ...(currentTask ? { currentTask } : {}) }];
  });
}

/** Stored links are references, never grants. Re-read identity and the shared policy on every use. */
export async function isNotificationVisible(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const notification = value as Record<string, unknown>;
  if (typeof notification.userId !== "string" || !notification.userId || typeof notification.type !== "string") return false;
  if (notification.actionUrl !== undefined && notification.actionUrl !== null && typeof notification.actionUrl !== "string") return false;
  const storedMetadata = notification.metadata;
  if (!storedMetadata || typeof storedMetadata !== "object" || Array.isArray(storedMetadata)) return false;
  const metadata = storedMetadata as Record<string, unknown>;
  // Task read alone never grants the internal discussion.
  if (metadata.visibility !== undefined && metadata.visibility !== "PUBLIC" && metadata.visibility !== "INTERNAL") return false;
  const taskId = metadata.taskId;
  const projectId = metadata.projectId;
  const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  if (taskId !== undefined && !validId(taskId)) return false;
  if (projectId !== undefined && !validId(projectId)) return false;
  let linkTask: string | null = null;
  let linkProject: string | undefined;
  if (notification.actionUrl) {
    // Only the canonical application deep link is accepted; no external or ambiguous URLs.
    const match = /^\/projects\/([A-Za-z0-9_-]+)\/board(?:\?task=([A-Za-z0-9_-]+))?$/.exec(notification.actionUrl);
    if (!match) return false;
    linkProject = match[1];
    linkTask = match[2] ?? null;
    if (projectId !== undefined && projectId !== linkProject) return false;
    if (taskId !== undefined && taskId !== linkTask) return false;
  }
  const taskScoped = notification.type.startsWith("task_") || notification.type === "chat_message"
    || notification.type === "automation_rule" || taskId !== undefined || linkTask !== null;
  if (metadata.visibility === "INTERNAL" && !taskScoped) return false;
  const targetProject = projectId ?? linkProject;
  const targetTask = taskId ?? linkTask;
  if (taskScoped && (!validId(taskId) || !validId(projectId) || !validId(targetTask) || !validId(targetProject))) return false;
  if (!taskScoped && notification.type !== "project_member_added") return false;
  if (notification.type === "project_member_added" && !validId(targetProject)) return false;
  if (!(await isAccountAllowed(notification.userId))) return false;
  const actor = await prisma.user.findUnique({ where: { id: notification.userId }, select: { id: true, globalRole: true } });
  if (!actor) return false;
  if (taskScoped) {
    const readable = !!(await prisma.task.findFirst({
      where: await getTaskReadWhere(actor, { id: targetTask as string, projectId: targetProject as string }),
      select: { id: true },
    }));
    if (!readable) return false;
    return metadata.visibility !== "INTERNAL" || await canActorReadInternal(prisma, actor, await loadProjectDiscussionFacts(prisma, targetProject as string));
  }
  return targetProject ? (await getProjectAccess(actor, targetProject)).canRead : true;
}

export type NotificationReadDb = Pick<Prisma.TransactionClient, "notification" | "user" | "task" | "project" | "scopedPrivilegeAssignment" | "groupPrivilegeAssignment" | "$queryRaw">;
const NOTIFICATION_BATCH_SIZE = 100;
const validNotificationId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);

type RowTarget =
  | { kind: "task"; taskId: string; projectId: string }
  | { kind: "project"; projectId: string }
  | null;

/** Classify one stored row without touching the database. */
function notificationTarget(
  notification: Pick<Notification, "metadata" | "type" | "actionUrl">,
  allowInternal = true,
): RowTarget {
  const metadata = notification.metadata as Record<string, unknown> | null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  if (metadata.visibility !== undefined && metadata.visibility !== "PUBLIC"
    && !(allowInternal && metadata.visibility === "INTERNAL")) return null;
  const taskId = metadata.taskId;
  const projectId = metadata.projectId;
  if (taskId !== undefined && !validNotificationId(taskId)) return null;
  if (projectId !== undefined && !validNotificationId(projectId)) return null;

  let linkTask: string | null = null;
  let linkProject: string | undefined;
  if (notification.actionUrl) {
    const match = /^\/projects\/([A-Za-z0-9_-]+)\/board(?:\?task=([A-Za-z0-9_-]+))?$/.exec(notification.actionUrl);
    if (!match) return null;
    linkProject = match[1];
    linkTask = match[2] ?? null;
    if (projectId !== undefined && projectId !== linkProject) return null;
    if (taskId !== undefined && taskId !== linkTask) return null;
  }

  const taskScoped = notification.type.startsWith("task_") || notification.type === "chat_message"
    || notification.type === "automation_rule" || taskId !== undefined || linkTask !== null;
  if (metadata.visibility === "INTERNAL" && !taskScoped) return null;
  const targetProject = projectId ?? linkProject;
  const targetTask = taskId ?? linkTask;

  if (taskScoped) {
    if (!validNotificationId(taskId) || !validNotificationId(projectId) || !validNotificationId(targetTask) || !validNotificationId(targetProject)) return null;
    return { kind: "task", taskId: targetTask, projectId: targetProject };
  }
  if (notification.type !== "project_member_added") return null;
  return validNotificationId(targetProject) ? { kind: "project", projectId: targetProject } : null;
}

interface VisibilityWindow {
  /** Null when the account itself may not receive anything. */
  readableTasks: Set<string> | null;
  readableProjects: Set<string> | null;
  internalReadableTasks: Set<string>;
}

/**
 * Resolve visibility for a whole page of rows with a constant number of queries:
 * one account probe, one recipient read, one task read and one project read.
 */
async function loadVisibilityWindow(userId: string, rows: Notification[], database: NotificationReadDb = prisma): Promise<VisibilityWindow> {
  const denied: VisibilityWindow = { readableTasks: null, readableProjects: null, internalReadableTasks: new Set() };
  if (database === prisma && !(await isAccountAllowed(userId))) return denied;

  const actor = await database.user.findUnique({
    where: { id: userId },
    select: { id: true, globalRole: true, isBlocked: true, blockedAt: true },
  });
  if (!actor || actor.isBlocked || actor.blockedAt) return denied;

  const taskIds: string[] = [];
  const projectIds: string[] = [];
  for (const row of rows) {
    const target = notificationTarget(row);
    if (!target) continue;
    if (target.kind === "task") taskIds.push(target.taskId);
    else projectIds.push(target.projectId);
  }

  const readableTasks = new Set<string>();
  if (taskIds.length > 0) {
    const uniqueTaskIds = [...new Set(taskIds)];
    // The shared predicate filters unreadable tasks inside the database.
    const tasks = await database.task.findMany({
      where: await getTaskReadWhere(actor, { id: { in: uniqueTaskIds } }, database),
      select: { id: true, projectId: true },
    });
    for (const task of tasks) readableTasks.add(JSON.stringify([task.id,task.projectId]));
  }

  const readableProjects = new Set<string>();
  if (projectIds.length > 0) {
    const uniqueProjectIds = [...new Set(projectIds)];
    const projects = await database.project.findMany({
      where: { id: { in: uniqueProjectIds } },
      select: { id: true, ownerId: true, members: { select: { userId: true } } },
    });
    for (const project of projects) {
      if (actor.globalRole === "ADMIN" || project.ownerId === actor.id
        || project.members.some(member => member.userId === actor.id)) {
        readableProjects.add(project.id);
      }
    }
  }

  const internalReadableTasks = new Set<string>();
  const internalByProject = new Map<string, boolean>();
  for (const row of rows) {
    if ((row.metadata as Record<string, unknown> | null)?.visibility !== "INTERNAL") continue;
    const target = notificationTarget(row);
    if (target?.kind !== "task" || !readableTasks.has(JSON.stringify([target.taskId,target.projectId]))) continue;
    if (!internalByProject.has(target.projectId)) {
      internalByProject.set(target.projectId, await canActorReadInternal(database, actor,
        await loadProjectDiscussionFacts(database, target.projectId)));
    }
    if (internalByProject.get(target.projectId)) internalReadableTasks.add(target.taskId);
  }
  return { readableTasks, readableProjects, internalReadableTasks };
}

function isVisibleInWindow(notification: Notification, window: VisibilityWindow): boolean {
  if (!window.readableTasks || !window.readableProjects) return false;
  const target = notificationTarget(notification);
  if (!target) return false;
  if ((notification.metadata as Record<string, unknown> | null)?.visibility === "INTERNAL"
    && (target.kind !== "task" || !window.internalReadableTasks.has(target.taskId))) return false;
  return target.kind === "task"
    ? window.readableTasks.has(JSON.stringify([target.taskId,target.projectId]))
    : window.readableProjects.has(target.projectId);
}

/**
 * Page through stored rows in bounded batches so visibility filtering never
 * loads a user's whole history and never costs a query per row.
 */
async function visibleNotificationPage(
  userId: string,
  options: { unreadOnly?: boolean; offset?: number; limit?: number; taskIds?: readonly string[] } = {},
  database: NotificationReadDb = prisma,
): Promise<Notification[]> {
  const { unreadOnly = false, offset = 0, limit } = options;
  const wanted = limit === undefined ? Number.POSITIVE_INFINITY : offset + limit;
  const visible: Notification[] = [];
  let cursor = 0;

  while (visible.length < wanted) {
    const batch = await database.notification.findMany({
      where: { userId, ...(unreadOnly ? { read: false } : {}), ...(options.taskIds ? { OR: options.taskIds.map(taskId => ({ metadata: { path: ["taskId"], equals: taskId } })) } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: cursor,
      take: NOTIFICATION_BATCH_SIZE,
    });
    if (batch.length === 0) break;

    const window = await loadVisibilityWindow(userId, batch, database);
    if (!window.readableTasks) break;

    for (const row of batch) if (isVisibleInWindow(row, window)) visible.push(row);

    cursor += batch.length;
    if (batch.length < NOTIFICATION_BATCH_SIZE) break;
  }

  return limit === undefined ? visible.slice(offset) : visible.slice(offset, offset + limit);
}

export type NotificationType =
  | "task_assigned"
  | "task_mentioned"
  | "task_status_changed"
  | "task_deadline_approaching"
  | "project_member_added"
  | "chat_message"
  | "automation_rule";

export interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export type NotificationVisibilityDb = Pick<Prisma.TransactionClient,
  "user" | "task" | "project" | "scopedPrivilegeAssignment">;

async function notificationRecipient(client: NotificationVisibilityDb, userId: string) {
  const actor = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, globalRole: true, isBlocked: true, blockedAt: true },
  });
  return actor && actor.isBlocked === false && actor.blockedAt === null ? actor : null;
}

/** Candidate roles/rooms never grant task read. Resolve every recipient afresh. */
export async function filterTaskNotificationRecipientIds(
  client: NotificationVisibilityDb,
  taskId: string,
  projectId: string,
  candidateIds: readonly string[],
): Promise<string[]> {
  const recipients: string[] = [];
  for (const userId of new Set(candidateIds)) {
    const actor = await notificationRecipient(client, userId);
    if (!actor) continue;
    const task = await client.task.findFirst({
      where: await getTaskReadWhere(actor, { id: taskId, projectId }, client, { projectId }),
      select: { id: true },
    });
    if (task) recipients.push(userId);
  }
  return recipients;
}

async function canPersistNotification(client: NotificationVisibilityDb, notification: CreateNotificationParams) {
  // Recheck internal authority here as well: task read (including a watcher)
  // cannot retain an internal payload after the caller's earlier role check.
  const target = notificationTarget({
    type: notification.type,
    actionUrl: notification.actionUrl ?? null,
    metadata: (notification.metadata ?? {}) as Prisma.JsonObject,
  }, true);
  if (!target) return false;
  if (target.kind === "task") {
    if (!validNotificationId(notification.metadata?.taskId) || !validNotificationId(notification.metadata?.projectId)) return false;
    if ((await filterTaskNotificationRecipientIds(client, target.taskId,
      target.projectId, [notification.userId])).length !== 1) return false;
    if (notification.metadata?.visibility !== "INTERNAL") return true;
    const actor = await notificationRecipient(client, notification.userId);
    return actor ? canActorReadInternal(client, actor, await loadProjectDiscussionFacts(client, target.projectId)) : false;
  }
  const actor = await notificationRecipient(client, notification.userId);
  return actor ? (await getProjectAccess(actor, target.projectId, client)).canRead : false;
}

/**
 * Emit notification via Socket.IO to user's room
 */
function emitNotificationViaSocket(notification: Notification) {
  try {
    emitUserNotification(notification);
  } catch (err) {
    try {
      socketLogger.error({ userId: notification.userId, notificationId: notification.id, err }, "Failed to emit notification via socket");
    } catch { /* A diagnostic failure cannot replace committed notification success. */ }
  }
}

/** The caller's transaction owns every insert and any rollback. No delivery here. */
export async function persistNotificationsWithClient(
  client: NotificationVisibilityDb & Pick<Prisma.TransactionClient, "notification">,
  notifications: readonly CreateNotificationParams[],
): Promise<Notification[]> {
  const created: Notification[] = [];
  for (const notification of notifications) {
    // Filter before private title/message are persisted, using this very same
    // transaction client. Feed/socket checks remain a second delivery boundary.
    if (!(await canPersistNotification(client, notification))) continue;
    created.push(await client.notification.create({
      data: {
        userId: notification.userId,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        actionUrl: notification.actionUrl,
        metadata: (notification.metadata || {}) as Prisma.InputJsonObject,
      },
    }));
  }
  return created;
}

/** Exact committed rows only. A delivery or diagnostic failure cannot stop peers. */
export function deliverNotifications(notifications: readonly Notification[]): void {
  for (const notification of notifications) {
    try { emitNotificationViaSocket(notification); }
    catch { /* Existing socket/logger boundaries cannot replace a commit. */ }
  }
}

/**
 * Create a notification for a user
 */
export async function createNotification(params: CreateNotificationParams) {
  // Rate limiting per user
  await rateLimitOrThrowKey("notifications:create", params.userId);

  const [notification] = await persistNotificationsWithClient(prisma, [params]);
  if (!notification) return null;

  // Emit via Socket.IO for real-time delivery
  emitNotificationViaSocket(notification);

  return notification;
}

/**
 * Create notifications for multiple users (bulk)
 */
export async function createNotifications(
  notifications: CreateNotificationParams[]
) {
  if (notifications.length === 0) return { count: 0 };

  const created = await prisma.$transaction(tx =>
    persistNotificationsWithClient(tx, notifications),
  );
  deliverNotifications(created);
  return { count: created.length };
}

/**
 * Mark notification as read
 */
export async function markNotificationRead(notificationId: string, userId: string) {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!notification || !(await isNotificationVisible(notification))) return null;
  const updated = await prisma.notification.update({
    where: { id: notificationId, userId },
    data: {
      read: true,
      readAt: new Date(),
    },
  });
  if(!notification.read)emitUserNotificationChanged(userId);
  return updated;
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllNotificationsRead(userId: string) {
  const visible = await visibleNotificationPage(userId, { unreadOnly: true });
  const updated = await prisma.notification.updateMany({
    where: {
      userId,
      read: false,
      id: { in: visible.map(row => row.id) },
    },
    data: {
      read: true,
      readAt: new Date(),
    },
  });
  if(updated.count>0)emitUserNotificationChanged(userId);
  return updated;
}

/**
 * Get unread notification count for a user
 */
export async function getUnreadCount(userId: string): Promise<number> {
  return (await getUnreadNotificationSummary(userId)).count;
}

/**
 * Get notifications for a user (paginated)
 */
export async function getNotifications(
  userId: string,
  options: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
  } = {}
) {
  const { limit = 20, offset = 0, unreadOnly = false } = options;

  // Filter before pagination: hidden history must not affect offsets or counts.
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 20;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return withCurrentTaskPhases(userId, await visibleNotificationPage(userId, { unreadOnly, offset: safeOffset, limit: safeLimit }));
}

export type UnreadNotificationSummary = { actorId: string; count: number; byProject: Record<string,number>; byTask: Record<string,number>; unscopedCount: number };
/** One fresh visibility policy for every unread-event counter. */
export async function getUnreadNotificationSummary(userId:string):Promise<UnreadNotificationSummary>{
 const rows=await visibleNotificationPage(userId,{unreadOnly:true});
 const result:UnreadNotificationSummary={actorId:userId,count:rows.length,byProject:Object.create(null),byTask:Object.create(null),unscopedCount:0};
 for(const row of rows){const target=notificationTarget(row);if(!target){result.unscopedCount++;continue;}
 result.byProject[target.projectId]=(result.byProject[target.projectId]??0)+1;
 if(target.kind==="task")result.byTask[target.taskId]=(result.byTask[target.taskId]??0)+1;}
 return result;
}
/** Exact actor-visible unread ID sets; callers bind a digest, never time alone. */
export async function readVisibleUnreadTaskNotifications(database:NotificationReadDb,userId:string,taskIds:readonly string[]):Promise<Map<string,string[]>>{
 if(!taskIds.length)return new Map();
 const rows=await visibleNotificationPage(userId,{unreadOnly:true,taskIds,limit:50001},database);
 if(rows.length>50000)throw new Error("TASK_NOTIFICATION_SNAPSHOT_LIMIT");
 const result=new Map<string,string[]>(taskIds.map(id=>[id,[]]));
 for(const row of rows){const target=notificationTarget(row);if(target?.kind==="task"&&result.has(target.taskId))result.get(target.taskId)!.push(row.id);}
 for(const ids of result.values())ids.sort();return result;
}
