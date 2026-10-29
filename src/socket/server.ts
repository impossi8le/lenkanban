import {promoteDiscussionAttachments} from "@/lib/attachments/promote-discussion-attachments";
import {loadTaskWithRelations} from "@/lib/task-queries";
import {persistTaskContentNotifications} from "@/app/api/tasks/[id]/messages/discussion-notifications";
import {commitBeznalContentEffect} from "@/features/kanban/server/task-lifecycle-service";
import {emitRequestQueueInvalidation} from "@/socket/request-queue-events";
import { changeOwnMessage, editOwnMessageSchema, deleteOwnMessageSchema } from "@/lib/chat-message-command";
import { projectChatMessage } from "@/lib/chat-message-projection";
import { mentionUserIdsSchema, validateTaskMentions, persistTaskMentions, sameMentionIds, TaskMentionError } from "@/lib/task-mentions";
import { deliverNotifications } from "@/lib/notifications";
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import { PrismaClient, type Prisma, type User } from '@prisma/client';
import type { Socket } from 'socket.io';
import http from 'http';

import { socketLogger } from '@/lib/logger';
import { rateLimitOrThrowKey } from '@/lib/rate-limit';
import { createInternalEmitRequestHandler } from './internal-emit-handler';
import { z } from 'zod';
import { prepareLegacyTaskScalarBatch, TaskCommandError } from '@/lib/task-command';
import { NotFoundError } from '@/lib/errors';
import { authorizeTaskRequestContentWrite, TaskLifecycleError } from '@/features/kanban/server/task-lifecycle-service';
import { getProjectAccess, getTaskReadWhere, requireTaskRead } from '@/lib/project-access';
import { isAccountAllowed } from '@/lib/auth';
import { isNotificationVisible } from '@/lib/notifications';
import { createVisibilityDelivery } from './visibility-delivery';
import { createRoomSubscriptions } from './room-subscriptions';
import { getAppOrigin, getSessionApiUrl, getSocketPort } from './config';
import { MessageAttachmentError, resolveMessageAttachments } from '@/lib/attachments/message-attachments';
import { filterTaskAttachmentsForReader, parseStoredAttachments, parseAttachmentFileUrl } from '@/lib/attachments/task-port';
import { projectTaskRealtimeForReader } from '@/lib/task-queries';
import https from 'https';
import { canActorReadInternal, loadInternalMessageIds, loadProjectDiscussionFacts } from '@/app/api/tasks/[id]/messages/discussion-access';

const messageAuthorInclude = {
  author: { select: { id: true, email: true, name: true, avatarUrl: true } },
} satisfies Prisma.ChatMessageInclude;

/** Matches the shared per-message limit; ownership is resolved server-side. */
const MAX_MESSAGE_ATTACHMENTS = 5;

const attachmentInputSchema = z.object({
  url: z.string().min(1).max(4096),
  name: z.string().min(1).max(1000),
  size: z.number().finite().nonnegative(),
  mime: z.string().min(1).max(255),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
});

/** PUBLIC sends/replays use current committed metadata, never a client audience flag. */
function resolvePublicSendAttachments(input: unknown, stored: unknown, taskId: string) {
  const parsed = z.array(attachmentInputSchema.extend({ isInternal: z.boolean().optional() })).max(MAX_MESSAGE_ATTACHMENTS).safeParse(input);
  if (!parsed.success || parsed.data.some(attachment => attachment.isInternal)) throw new MessageAttachmentError('ATTACHMENT_NOT_OWNED');
  const attachments = resolveMessageAttachments(parsed.data, stored, taskId);
  if (attachments.some(attachment => attachment.isInternal)) throw new MessageAttachmentError('ATTACHMENT_NOT_OWNED');
  return attachments;
}

const sendMessageSchema = z.object({
  mentionUserIds: mentionUserIdsSchema,
  taskId: z.string().min(1).max(200).refine(value => Boolean(value.trim())),
  clientId: z.string().min(1).max(200).refine(value => Boolean(value.trim())),
  contentText: z.string().max(20_000).optional().default(''),
  attachments: z.array(attachmentInputSchema).max(MAX_MESSAGE_ATTACHMENTS).optional().default([]),
  // The socket path has no internal-only delivery channel, so INTERNAL is
  // acknowledged as unsupported here and must use the HTTP route.
  visibility: z.enum(['PUBLIC', 'INTERNAL']).optional().default('PUBLIC'),
}).refine(value => Boolean(value.contentText.trim()) || value.attachments.length > 0);

const editMessageSchema = editOwnMessageSchema.extend({ taskId: z.string().min(1).max(128), messageId: z.string().min(1).max(128) }).strict();
const deleteMessageSchema = deleteOwnMessageSchema.extend({ taskId: z.string().min(1).max(128), messageId: z.string().min(1).max(128) }).strict();

const prisma = new PrismaClient();
const httpServer = createServer();

const appOrigin = getAppOrigin();
const io = new SocketIOServer(httpServer, {
  // Unconfigured means same-origin only; there is no historical domain fallback.
  ...(appOrigin ? { cors: { origin: appOrigin, credentials: true } } : {}),
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

const visibility = createVisibilityDelivery({
  sockets: () => io.sockets.sockets.values(),
  canReadProject: (userId, projectId) => canUserAccessProject(userId, projectId),
  canReadTask: async (userId, taskId) => {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true } });
    if (!actor) return false;
    await requireTaskRead(actor, taskId, prisma);
    return true;
  },
  canReadNotification: data => isNotificationVisible(data),
  canReadMessage: canUserReadMessage,
  projectTask: (userId, taskId, projectId, data) => projectTaskRealtimeForReader(userId, taskId, projectId, data),
  isAccountAllowed: userId => isAccountAllowed(userId),
  currentGlobalRole: async userId => (await prisma.user.findUnique({
    where: { id: userId }, select: { globalRole: true },
  }))?.globalRole ?? null,
});

async function canUserReadMessage(userId: string, taskId: string, data: unknown, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  if (!data || typeof data !== 'object') return false;
  const row = data as { id?: string; messageId?: string; visibility?: unknown; isInternal?: unknown; attachments?: unknown; version?: unknown; contentText?: unknown; deletedAt?: unknown };
  const messageId = row.messageId ?? row.id;
  if (typeof row.version === 'number' && messageId) {
    const persisted = await db.chatMessage.findUnique({ where: { id: messageId }, select: { taskId: true, version: true, deletedAt: true } });
    if (!persisted || persisted.taskId !== taskId || persisted.version !== row.version
      || (persisted.deletedAt && (!row.deletedAt || row.contentText !== ''))) return false;
  }
  const internalIds = await loadInternalMessageIds(db, taskId);
  const internal = row.visibility === 'INTERNAL' || row.isInternal === true
    || Boolean(messageId && internalIds?.has(messageId));
  const files = z.array(attachmentInputSchema.extend({ isInternal: z.boolean().optional() })).max(MAX_MESSAGE_ATTACHMENTS).safeParse(row.attachments === undefined ? [] : row.attachments);
  if (!files.success) return false;
  // Deletion/reaction payloads without file metadata retain their existing
  // discussion-only handling. Public file DTOs need current metadata as well.
  if (!internal && files.data.length === 0) return true;
  const metadata = await db.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, attachments: true } });
  if (!metadata || metadata.id !== taskId) return false;
  if (files.data.length > 0 && !z.array(attachmentInputSchema.extend({ isInternal: z.boolean().optional() })).safeParse(metadata.attachments).success) return false;
  // Metadata can wait behind storage/DB work. Resolve the recipient again
  // afterwards; cached socket roles and the sender's commit are not read grants.
  const actor = await db.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true, isBlocked: true, blockedAt: true } });
  if (!actor || actor.isBlocked !== false || actor.blockedAt !== null) return false;
  const readable = await db.task.findFirst({
    where: await getTaskReadWhere(actor, { id: taskId, projectId: metadata.projectId }, db, { projectId: metadata.projectId }),
    select: { id: true },
  });
  if (!readable) return false;
  if (internal && !(await canActorReadInternal(db, actor, await loadProjectDiscussionFacts(db, metadata.projectId)))) return false;
  if (files.data.length === 0) return true;
  // Reuse the download/HTTP projection, including duplicate-public protection.
  // Authorized internal readers retain the message; others receive no stale
  // URL/name/size from the pre-commit public snapshot.
  const visible = await filterTaskAttachmentsForReader(db, actor, metadata.projectId, parseStoredAttachments(metadata.attachments));
  return files.data.every(file => parseAttachmentFileUrl(file.url, taskId) !== null
    && visible.some(current => current.url === file.url));
}

interface SocketAuthedData {
  userId: string;
  userName: string;
  globalRole: User['globalRole'];
}

/**
 * Same read policy as the HTTP routes: a fresh actor is resolved on every call
 * and the shared getProjectAccess evaluator decides (global ADMIN included).
 * A demoted, deleted or removed actor is therefore denied on the next event.
 */
async function canUserAccessProject(
  userId: string,
  projectId: string,
  client: Pick<Prisma.TransactionClient, 'project' | 'user'> = prisma,
): Promise<boolean> {
  const actor = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, globalRole: true },
  });
  if (!actor) return false;
  return (await getProjectAccess(actor, projectId, client)).canRead;
}

async function validateSessionViaNexJS(cookie: string): Promise<{ user: { id: string; email: string; name?: string } } | null> {
  return new Promise((resolve) => {
    const target = getSessionApiUrl();
    const transport = target.protocol === 'https:' ? https : http;
    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        'Cookie': cookie,
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          socketLogger.debug({ statusCode: res.statusCode, dataLength: data.length }, 'Session API response');
          if (res.statusCode === 200 && data) {
            const session = JSON.parse(data);
            if (session?.user?.id) {
              resolve(session);
            } else {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        } catch (err) {
          socketLogger.error({ err }, 'Error parsing session response');
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      socketLogger.error({ err }, 'Error calling session API');
      resolve(null);
    });

    req.setTimeout(5000, () => {
      socketLogger.warn('Session API timeout');
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

async function getSocketUserId(socket: Socket): Promise<SocketAuthedData | null> {
  socketLogger.debug({ socketId: socket.id }, 'Starting authentication');
  const cookie = socket.request.headers.cookie;

  if (!cookie) {
    socketLogger.debug({ socketId: socket.id }, 'No cookie found - rejecting');
    return null;
  }

  socketLogger.debug({ socketId: socket.id }, 'Validating session via Next.js API');
  const session = await validateSessionViaNexJS(cookie);

  if (!session?.user?.id) {
    socketLogger.debug({ socketId: socket.id }, 'Session validation failed');
    return null;
  }

  socketLogger.debug({ socketId: socket.id }, 'Session valid');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, globalRole: true },
  });

  if (!user) {
    socketLogger.warn({ socketId: socket.id, userId: session.user.id }, 'User not found in database');
    return null;
  }

  socketLogger.info({ socketId: socket.id, userId: user.id }, 'Authentication successful');
  return {
    userId: user.id,
    userName: user.name || user.email,
    globalRole: user.globalRole,
  };
}

socketLogger.info('Registering auth middleware');
io.use(async (socket, next) => {
  socketLogger.debug({ socketId: socket.id }, 'Auth middleware called');
  try {
    const authed = await getSocketUserId(socket);
    if (!authed) {
      socketLogger.debug({ socketId: socket.id }, 'Authentication failed - no authed data');
      return next(new Error('Unauthorized'));
    }
    // A blocked account must not open a socket session either; the HTTP side
    // already rejects it on every request (#14).
    if (!(await isAccountAllowed(authed.userId))) {
      socketLogger.info({ socketId: socket.id, userId: authed.userId }, 'Blocked account rejected');
      return next(new Error('Unauthorized'));
    }

    socketLogger.debug({ socketId: socket.id, userId: authed.userId }, 'Auth successful');
    socket.data.userId = authed.userId;
    socket.data.userName = authed.userName;
    socket.data.globalRole = authed.globalRole;

    return next();
  } catch (err) {
    socketLogger.error({ socketId: socket.id, err }, 'Auth error');
    return next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const userId = (socket.data as Partial<SocketAuthedData>).userId;
  const userName = (socket.data as Partial<SocketAuthedData>).userName ?? 'User';

  socketLogger.info({ socketId: socket.id, userId }, 'New connection');

  if (!userId) {
    socketLogger.warn({ socketId: socket.id }, 'No userId - disconnecting');
    socket.disconnect();
    return;
  }

  const subscriptions = createRoomSubscriptions({
    expectedUserId: userId,
    authenticate: () => getSocketUserId(socket),
    canReadProject: async (actor, projectId) => (await getProjectAccess({ id: actor.userId, globalRole: actor.globalRole }, projectId, prisma)).canRead,
    taskProject: async taskId => (await prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } }))?.projectId ?? null,
    canReadTask: async (actor, taskId) => {
      try { await requireTaskRead({ id: actor.userId, globalRole: actor.globalRole }, taskId, prisma); return true; }
      catch { return false; }
    },
    join: room => socket.join(room),
    leave: room => socket.leave(room),
  });
  socket.on('project:join', subscriptions.joinProject);
  socket.on('project:leave', subscriptions.leaveProject);
  socket.on('task:join', subscriptions.joinTask);
  socket.on('task:leave', subscriptions.leaveTask);

  // Delivery always rechecks immediately; this sweep also evicts idle revoked
  // subscriptions without requiring a reconnect or another task mutation.
  let validating = false;
  const accessSweep = setInterval(() => {
    if (validating) return;
    validating = true;
    void visibility.revalidate(socket).catch(() => undefined).finally(() => { validating = false; });
  }, 5000);
  accessSweep.unref();

  // Chat message handlers
  socket.on('message:send', async (payload: unknown, ack?: (res: { ok: boolean; error?: string; retryAfter?: number }) => void) => {
    let acknowledged = false;
    const respond = (result: { ok: boolean; error?: string; retryAfter?: number }) => {
      if (acknowledged) return;
      acknowledged = true;
      try { ack?.(result); } catch { /* A transport callback cannot reverse a commit. */ }
    };
    const parsed = sendMessageSchema.safeParse(payload);
    if (!parsed.success) {
      respond({ ok: false, error: 'InvalidMessagePayload' });
      return;
    }
    const data = parsed.data;
    // Socket delivery fans a message out to every task reader. Until the
    // internal-only channel exists, an INTERNAL request must not be silently
    // downgraded to a public message: the client uses the guarded HTTP route.
    if (data.visibility === 'INTERNAL') {
      respond({ ok: false, error: 'InternalRequiresHttp' });
      return;
    }
    const reportFailure = (error: unknown) => {
      try { socketLogger.error({ event: 'socket.message.send.failed', socketId: socket.id, userId, taskId: data.taskId, err: error }); }
      catch { /* No raw fallback or delivery failure escalation. */ }
    };
    const deliver = (effect: () => void) => { try { effect(); } catch (error) { reportFailure(error); } };

    try {
      // The same actor bucket as HTTP also admits retries; quota storage fails closed.
      await rateLimitOrThrowKey('messages:send', userId);
      const task = await prisma.task.findUnique({
        where: { id: data.taskId },
        select: { projectId: true, title: true },
      });

      if (!task) {
        respond({ ok: false, error: 'TaskNotFound' });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, globalRole: true },
      });
      if (!user) {
        respond({ ok: false, error: 'UserNotFound' });
        return;
      }

      if (!(await prisma.task.findFirst({
        where: await getTaskReadWhere(user, { id: data.taskId, projectId: task.projectId }, prisma, { projectId: task.projectId }),
        select: { id: true },
      }))) {
        respond({ ok: false, error: 'AccessDenied' });
        return;
      }

      const execute = (replayOnly: boolean) => prisma.$transaction(async tx => {
        // Dispatch is never admission: each branch rechecks fresh authority and
        // marker under the Task lock, including a P2002 recovery/replay attempt.
        const presence = await tx.taskRequest.findUnique({ where: { taskId: data.taskId }, select: { taskId: true } });
        let lockedTask: { id: string; projectId: string } | undefined;
        let contentIsBeznal=false;
        if (presence !== null) {
          const content = await authorizeTaskRequestContentWrite({
            tx, actorId: userId, taskId: data.taskId, expectedProjectId: task.projectId, kind: 'comment',
          });
          if (!content.allowed) throw new TaskCommandError(content.code);
          contentIsBeznal=content.marked&&content.beznal===true;
          if (content.marked) lockedTask = { id: data.taskId, projectId: task.projectId };
        }
        if (!lockedTask) {
          [lockedTask] = await prepareLegacyTaskScalarBatch({
            tx, actorId: userId, expectedTasks: [{ id: data.taskId, projectId: task.projectId }],
          });
        }
        if (!lockedTask) throw new NotFoundError();
        // Both admission paths hold the actor row FOR SHARE. Legacy admission
        // predates revocation columns; apply the lifecycle fresh-actor predicate
        // before looking up a replay or creating any message.
        const currentActor = await tx.user.findUnique({
          where: { id: userId }, select: { id: true, isBlocked: true, blockedAt: true },
        });
        if (!currentActor || currentActor.isBlocked !== false || currentActor.blockedAt !== null) throw new NotFoundError();
        await validateTaskMentions(tx, data.taskId, task.projectId, data.mentionUserIds, "PUBLIC");
        const existing = await tx.chatMessage.findUnique({ where: { clientId: data.clientId }, include: messageAuthorInclude });
        if (existing) {
          if (existing.authorId !== userId || existing.taskId !== data.taskId || existing.clientId !== data.clientId || !sameMentionIds(existing.mentions, data.mentionUserIds)) {
            return { kind: 'conflict' as const };
          }
          if (!Array.isArray(existing.attachments)) throw new MessageAttachmentError('ATTACHMENT_NOT_OWNED');
          if (existing.attachments.length > 0) {
            const metadata = await tx.task.findUnique({ where: { id: data.taskId }, select: { id: true, projectId: true, attachments: true } });
            if (!metadata || metadata.id !== lockedTask.id || metadata.projectId !== lockedTask.projectId) throw new NotFoundError();
            resolvePublicSendAttachments(existing.attachments, metadata.attachments, data.taskId);
          }
          return { kind: 'replayed' as const, message: existing };
        }
        if (replayOnly) return null;
        const currentTask = await tx.task.findUnique({
          where: { id: data.taskId },
          select: { id: true, projectId: true, title: true, attachments: true },
        });
        if (!currentTask) throw new NotFoundError();
        if (currentTask.id !== lockedTask.id || currentTask.projectId !== lockedTask.projectId) throw new TaskCommandError('IDENTITY_CHANGED');
        // Client URLs are never stored: each must be the canonical URL of this
        // task and already present in committed Task.attachments. The stored DTO
        // replaces the client name/size/mime.
        // PUBLIC socket sends cannot launder an existing restricted file.
        const resolvedAttachments = resolvePublicSendAttachments(data.attachments, currentTask.attachments, data.taskId);
        const attachments = resolvedAttachments.length?await promoteDiscussionAttachments(tx,data.taskId,userId,resolvedAttachments,"PUBLIC",currentTask.attachments):[];
        const mentions = data.mentionUserIds;
        const message = await tx.chatMessage.create({
          data: { taskId: data.taskId, authorId: userId, clientId: data.clientId,
            contentText: data.contentText, attachments, mentions, reactions: {},
            readBy: { [userId]: new Date().toISOString() } },
          include: messageAuthorInclude,
        });
        const contentEffect=contentIsBeznal?await commitBeznalContentEffect({tx,actorId:userId,taskId:data.taskId,projectId:task.projectId,kind:attachments.length?"invoice":"comment",invoiceUrl:attachments[0]?.url,public:true}):null;
        const contentNotifications=await persistTaskContentNotifications({db:tx,taskId:data.taskId,actorId:userId,actorName:message.author.name||message.author.email,visibility:"PUBLIC",event:"comment",eventId:message.id,...(mentions.length?{excludedRecipientIds:mentions}:{})});
        const mentionNotifications = await persistTaskMentions(tx, { taskId: data.taskId, projectId: task.projectId, actorId: userId, messageId: message.id, mentionUserIds: mentions });
        return { kind: 'created' as const, message, mentionNotifications, contentNotifications, contentEffect, projectId: lockedTask.projectId,
          taskTitle: currentTask.title, authorName: message.author.name || message.author.email };
      });
      let result;
      try { result = await execute(false); }
      catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') throw error;
        // PostgreSQL has unwound the failed insert transaction before this
        // fresh guarded lookup. Never read canonical content in an aborted tx.
        result = await execute(true);
        if (!result) throw error;
      }
      if (!result) throw new Error('Canonical message unavailable');
      if (result.kind === 'conflict') { respond({ ok: false, error: 'ClientIdConflict' }); return; }
      if (result.kind === 'replayed') {
        const replayed = projectChatMessage(result.message);
        const reader = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true, isBlocked: true, blockedAt: true } });
        if (!reader || reader.isBlocked !== false || reader.blockedAt !== null || !(await prisma.task.findFirst({
          where: await getTaskReadWhere(reader, { id: data.taskId, projectId: task.projectId }, prisma, { projectId: task.projectId }),
          select: { id: true },
        })) || !(await canUserReadMessage(userId, data.taskId, replayed))) {
          respond({ ok: false, error: 'AccessDenied' });
          return;
        }
        if (Array.isArray(replayed.attachments) && replayed.attachments.length > 0) {
          // A file can become restricted after the transaction commits. Recheck
          // current metadata before a direct replay, just as room delivery
          // rechecks its current message audience.
          const metadata = await prisma.task.findUnique({ where: { id: data.taskId }, select: { id: true, projectId: true, attachments: true } });
          if (!metadata || metadata.id !== data.taskId || metadata.projectId !== task.projectId) {
            respond({ ok: false, error: 'AccessDenied' });
            return;
          }
          try { resolvePublicSendAttachments(replayed.attachments, metadata.attachments, data.taskId); }
          catch { respond({ ok: false, error: 'AccessDenied' }); return; }
        }
        deliver(() => { socket.emit('message:new', projectChatMessage(replayed)); });
        respond({ ok: true });
        return;
      }
      const committed = result;
      if(committed.contentNotifications.length)deliver(()=>{void Promise.resolve(deliverNotifications(committed.contentNotifications)).catch(reportFailure);});
      if(committed.contentEffect?.queueRecipientIds)deliver(()=>{void emitRequestQueueInvalidation({taskId:data.taskId,projectId:committed.projectId,previousRecipientIds:committed.contentEffect!.queueRecipientIds}).catch(reportFailure);});
      if (committed.mentionNotifications.length) deliverNotifications(committed.mentionNotifications);
      if(committed.contentEffect?.claimed)deliver(()=>{void(async()=>{const updated=await loadTaskWithRelations(data.taskId);if(updated)await visibility.task(data.taskId,'task:updated',updated,committed.projectId);})().catch(reportFailure);});
      deliver(() => { socketLogger.info({ socketId: socket.id, userId, taskId: data.taskId, messageId: committed.message.id }, 'Message created'); });
      deliver(() => { void visibility.task(data.taskId, 'message:new', committed.message, committed.projectId).catch(reportFailure); });
      respond({ ok: true });
    } catch (error) {
      reportFailure(error);
      let code = 'InternalError';
      try {
        if (error instanceof Error && error.message === 'RateLimited' && 'status' in error && error.status === 429
          && 'retryAfterSec' in error && typeof error.retryAfterSec === 'number'
          && Number.isFinite(error.retryAfterSec) && error.retryAfterSec > 0) {
          respond({ ok: false, error: 'RateLimited', retryAfter: Math.ceil(error.retryAfterSec) });
          return;
        }
        if (error instanceof TaskMentionError) code = error.code;
        else if (error instanceof NotFoundError) code = 'TaskNotFound';
        else if (error instanceof TaskCommandError || error instanceof TaskLifecycleError) code = 'MutationRejected';
        else if (error instanceof MessageAttachmentError) code = error.code;
      } catch { /* Hostile thrown values retain the fixed storage failure code. */ }
      respond({ ok: false, error: code });
    }
  });

  const childMutationBoundary = (event: 'socket.message.edit.failed' | 'socket.message.delete.failed' | 'socket.message.react.failed',
    ack?: (res: { ok: boolean; error?: string }) => void) => {
    let acknowledged = false;
    const respond = (response: { ok: boolean; error?: string; data?: unknown }) => {
      if (acknowledged) return;
      acknowledged = true;
      try { ack?.(response); } catch { /* A transport callback cannot reverse a commit. */ }
    };
    const report = (error: unknown) => {
      try { socketLogger.error({ event, socketId: socket.id, userId, err: error }); }
      catch { /* No raw content or diagnostic fallback. */ }
    };
    const deliver = (effect: () => void) => { try { effect(); } catch (error) { report(error); } };
    const fail = (error: unknown) => {
      report(error);
      let code = 'InternalError';
      try {
        if (error instanceof NotFoundError) code = 'TaskNotFound';
        else if (error instanceof TaskCommandError) code = 'MutationRejected';
        else if (error instanceof MessageAttachmentError) code = error.code;
      } catch { /* Hostile errors keep a fixed storage failure code. */ }
      respond({ ok: false, error: code });
    };
    return { respond, deliver, fail };
  };

  // HTTP and socket share ownership, current read/internal authority, message CAS,
  // durable exact retry and atomic Activity. Old unversioned payloads fail closed.
  for (const action of ['edit', 'delete'] as const) {
    socket.on(`message:${action}`, async (payload: unknown, ack?: (res: { ok: boolean; error?: string; data?: unknown }) => void) => {
      const boundary = childMutationBoundary(`socket.message.${action}.failed`, ack);
      const parsed = (action === 'edit' ? editMessageSchema : deleteMessageSchema).safeParse(payload);
      if (!parsed.success) { boundary.respond({ ok: false, error: 'InvalidMessageCommand' }); return; }
      try {
        await rateLimitOrThrowKey('tasks:update', userId);
        const result = await changeOwnMessage(prisma, { ...parsed.data, actorId: userId, action });
        if (result.ack.changed && !result.ack.replayed && result.message) {
          boundary.deliver(() => { void visibility.task(parsed.data.taskId, 'message:updated', result.message, result.projectId).catch(() => undefined); });
        }
        boundary.respond({ ok: true, data: result.ack });
      } catch (error) { boundary.fail(error); }
    });
  }

  socket.on('message:react', async (data: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    const boundary = childMutationBoundary('socket.message.react.failed', ack);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      boundary.respond({ ok: false, error: 'InvalidReactionPayload' });
      return;
    }
    const { taskId, messageId, emoji, action } = data as Record<string, unknown>;
    if (
      typeof taskId !== 'string' || !taskId.trim() || taskId.length > 200 ||
      typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200 ||
      typeof emoji !== 'string' || !emoji.trim() || emoji.length > 64 ||
      ['__proto__', 'prototype', 'constructor'].includes(emoji) ||
      (action !== 'add' && action !== 'remove')
    ) {
      boundary.respond({ ok: false, error: 'InvalidReactionPayload' });
      return;
    }

    try {
      const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { taskId: true, task: { select: { projectId: true } } },
      });

      if (!message) {
        boundary.respond({ ok: false, error: 'MessageNotFound' });
        return;
      }

      if (message.taskId !== taskId || !(await canUserAccessProject(userId, message.task.projectId))) {
        boundary.respond({ ok: false, error: 'AccessDenied' });
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        // Reactions are discussion content, not scalar edits. The common
        // content guard admits authorized request readers without granting
        // them task-field or lifecycle mutation rights.
        const presence = await tx.taskRequest.findUnique({ where: { taskId }, select: { taskId: true } });
        let task: { id: string; projectId: string } | undefined;
        if (presence !== null) {
          const content = await authorizeTaskRequestContentWrite({
            tx, actorId: userId, taskId, expectedProjectId: message.task.projectId, kind: 'comment',
          });
          if (!content.allowed) throw new TaskCommandError(content.code);
          if (content.marked) task = { id: taskId, projectId: message.task.projectId };
        }
        if (!task) {
          [task] = await prepareLegacyTaskScalarBatch({
            tx, actorId: userId, expectedTasks: [{ id: message.taskId, projectId: message.task.projectId }],
          });
        }
        if (!task) throw new NotFoundError();
        // Concurrent commands must read reactions only after acquiring this
        // row lock; reusing the authorization snapshot would lose updates.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "ChatMessage"
          WHERE "id" = ${messageId} AND "taskId" = ${taskId}
          FOR UPDATE
        `;
        if (!locked.length) return { ok: false as const, error: 'MessageNotFound' };
        const current = await tx.chatMessage.findUnique({
          where: { id: messageId },
          select: { id: true, deletedAt: true, attachments: true, reactions: true, taskId: true, task: { select: { projectId: true } } },
        });
        if (!current || current.deletedAt) return { ok: false as const, error: 'MessageNotFound' };
        if (current.taskId !== taskId || current.task.projectId !== task.projectId || !(await canUserAccessProject(userId, current.task.projectId, tx))) {
          return { ok: false as const, error: 'AccessDenied' };
        }

        if (!(await canUserReadMessage(userId, taskId, current, tx))) {
          return { ok: false as const, error: 'AccessDenied' };
        }
        const reactions: Record<string, string[]> = Object.assign(Object.create(null), current.reactions || {});
        const users = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];
        if (action === 'add') {
          if (!users.includes(userId)) users.push(userId);
          reactions[emoji] = users;
        } else {
          const remaining = users.filter(id => id !== userId);
          if (remaining.length) reactions[emoji] = remaining;
          else delete reactions[emoji];
        }
        const updated = await tx.chatMessage.update({
          where: { id: messageId },
          data: { reactions },
          include: {
            author: { select: { id: true, email: true, name: true, avatarUrl: true } },
          },
        });
        return { ok: true as const, updated };
      }, { isolationLevel: 'ReadCommitted' });

      if (!result.ok) {
        boundary.respond({ ok: false, error: result.error });
        return;
      }
      boundary.deliver(() => { socketLogger.info({ socketId: socket.id, userId, messageId }, 'Message reactions updated'); });
      boundary.deliver(() => { void visibility.task(result.updated.taskId, 'message:updated', projectChatMessage(result.updated)).catch(() => undefined); });
      boundary.respond({ ok: true });
    } catch (error) {
      boundary.fail(error);
    }
  });

  // Access checks may complete out of order; only the latest state for a task
  // may be broadcast. Entries exist only while the latest check is pending.
  const typingAttempts = new Map<string, symbol>();
  let typingClosed = false;
  socket.on('typing', async (data: unknown) => {
    let taskId: string | undefined;
    let attempt: symbol | undefined;
    try {
      if (typingClosed || !data || typeof data !== 'object' || Array.isArray(data)) return;
      const candidate = (data as Record<string, unknown>).taskId;
      const isTyping = (data as Record<string, unknown>).isTyping;
      if (typeof candidate !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate) || typeof isTyping !== 'boolean') return;
      taskId = candidate;
      attempt = Symbol();
      typingAttempts.set(taskId, attempt);
      const actor = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, globalRole: true } });
      if (!actor) return;
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { id: true, projectId: true },
      });
      if (!task || !(await getProjectAccess(actor, task.projectId, prisma)).canRead) return;
      // Board visibility never admits typing into a selected-audience request.
      // The sender passes the same current task policy as every recipient.
      await requireTaskRead(actor, task.id, prisma);
      if (typingClosed || typingAttempts.get(taskId) !== attempt) return;

      await visibility.task(task.id, 'typing', {
        taskId: task.id,
        userId,
        userName,
        isTyping,
      }, undefined, socket.id);
    } catch (error) {
      try { socketLogger.error({ socketId: socket.id, userId, taskId, err: error }, 'Error handling typing event'); }
      catch { /* Diagnostic failure cannot reject an ephemeral typing event. */ }
    } finally {
      if (taskId && typingAttempts.get(taskId) === attempt) typingAttempts.delete(taskId);
    }
  });

  // Notification handlers
  socket.on('notification:join', subscriptions.joinNotifications);
  socket.on('notification:leave', subscriptions.leaveNotifications);

  socket.on('disconnect', () => {
    clearInterval(accessSweep);
    typingClosed = true;
    typingAttempts.clear();
    subscriptions.disconnect();
    socketLogger.info({ socketId: socket.id, userId }, 'Socket disconnected');
  });
});

// Internal API calls share this HTTP server with Engine.IO. Requests that do
// not belong to the bridge must be left untouched for Socket.IO to complete.
httpServer.on(
  'request',
  createInternalEmitRequestHandler(io, {
    secret: process.env.INTERNAL_EMIT_SECRET,
    allowPrivateNetwork: process.env.INTERNAL_EMIT_ALLOW_PRIVATE_NETWORK === 'true',
    dispatch: visibility.dispatch,
    onError: (err) =>
      socketLogger.error({ err }, 'Error parsing internal emit request'),
  }),
);


const PORT = getSocketPort();

// Only start server if this file is run directly (not imported)
if (require.main === module) {
  httpServer.listen(PORT, () => {
    socketLogger.info({ event: 'socket.server.listening', port: PORT }, 'Socket.IO server listening');
  });
}
