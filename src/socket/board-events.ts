import {NOTIFICATION_CHANGED} from "./notification-change-contract";
import type { MoveTaskResponse } from '@/features/kanban/server/move-contract';
import type { Notification } from '@prisma/client';
import { hasConfiguredServiceSecret } from '@/lib/service-auth';
import { socketLogger } from '@/lib/logger';
import { isInternalEmitPayload } from './internal-emit-contract';
import { getInternalEmitUrl } from './config';
import { REQUEST_QUEUE_INVALIDATED } from './request-queue-contract';

async function sendEmit(event: string, projectId: string, data: unknown, roomKind: 'project' | 'user' = 'project'): Promise<void> {
  try {
    if (!projectId || typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(projectId)) return;
    const secret = process.env.INTERNAL_EMIT_SECRET;
    if (!hasConfiguredServiceSecret(secret)) {
      try { socketLogger.warn({ event: 'internal_emit_secret_missing' }); } catch { /* Diagnostic failure must not alter the business result. */ }
      return;
    }
    const envelope = { event, roomId: `${roomKind}:${projectId}`, data };
    if (!isInternalEmitPayload(envelope)) return;
    let body: string;
    try { body = JSON.stringify(envelope); } catch { return; }
    const res = await fetch(getInternalEmitUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body,
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      try { socketLogger.error({ statusCode: res.status, event: 'internal_emit_failed' }); } catch { /* Diagnostic failure must not alter the business result. */ }
    }
  } catch (err) {
    try {
      socketLogger.error({ err, event: 'internal_emit_failed' });
    } catch { /* Diagnostic failure must not alter the business result. */ }
  }
}

/** Reuses the authenticated loopback bridge; only this recipient's committed row. */
export function emitUserNotification(notification: Notification): void {
  try { void sendEmit('notification:new', notification.userId, notification, 'user'); }
  catch { /* Invalid projections or getters cannot replace a committed write. */ }
}

/** Existing authenticated bridge; invalidates only this actor's own projections. */
export async function emitUserRequestQueueInvalidation(actorId: string): Promise<void> {
  await sendEmit(REQUEST_QUEUE_INVALIDATED, actorId, {}, 'user');
}

export function emitTaskCreated(projectId: string, task: unknown): void {
  void sendEmit('task:created', projectId, task);
}
export function emitTaskUpdated(projectId: string, task: unknown): void {
  void sendEmit('task:updated', projectId, task);
}
/** A committed HTTP comment uses the same per-recipient chat delivery as socket sends. */
export async function emitTaskMessageCreated(projectId: string, message: unknown): Promise<void> {
  await sendEmit('message:new', projectId, message);
}
export async function emitTaskMoved(projectId: string, move: MoveTaskResponse): Promise<void> {
  await sendEmit('task:moved', projectId, move);
}
export function emitTaskDeleted(projectId: string, taskId: string, deletedById?: string): void {
  void sendEmit('task:deleted', projectId, { projectId, taskId, deletedById });
}
export function emitColumnCreated(projectId: string, column: Record<string, unknown>, createdById?: string): void {
  try { void sendEmit('column:created', projectId, { ...column, createdById }); } catch { /* Unknown getters must not affect a committed mutation. */ }
}
export function emitColumnUpdated(projectId: string, column: Record<string, unknown>, updatedById?: string): void {
  try { void sendEmit('column:updated', projectId, { ...column, updatedById }); } catch { /* Unknown getters must not affect a committed mutation. */ }
}
export function emitColumnDeleted(projectId: string, columnId: string, userId?: string): void {
  void sendEmit('column:deleted', projectId, { projectId, columnId, userId });
}
export function emitColumnsReordered(projectId: string, columns: unknown): void {
  void sendEmit('columns:reordered', projectId, columns);
}
export function emitProjectMembersUpdated(projectId: string, member: unknown): void {
  void sendEmit('project:members:updated', projectId, member);
}
export function emitProjectMemberDeleted(projectId: string, memberId: string): void {
  void sendEmit('project:member:deleted', projectId, { projectId, memberId });
}
/** Post-commit revocation of an already authenticated socket session. */
export function emitAuthRevoked(userId: string, reason: string): void {
  try { void sendEmit('auth.revoked', userId, { userId, reason }, 'user'); }
  catch { /* Invalid values cannot replace a committed mutation. */ }
}

export async function emitTaskMessageUpdated(projectId: string, message: unknown): Promise<void> {
  await sendEmit("message:updated", projectId, message);
}

/** Read state committed: refresh only this recipient's personal projections. */
export function emitUserNotificationChanged(userId:string):void {
 try{void sendEmit(NOTIFICATION_CHANGED,userId,{version:1},'user');}catch{/* Delivery never replaces committed ACK. */}
}
