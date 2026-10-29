import {NOTIFICATION_CHANGED,isNotificationChanged} from "./notification-change-contract";
import { REQUEST_QUEUE_INVALIDATED, isRequestQueueInvalidation } from './request-queue-contract';

/** Rooms select candidates; fresh server policy selects recipients. */
export interface VisibilitySocket {
  id: string;
  data: { userId?: string; globalRole?: string };
  rooms: Set<string>;
  emit(event: string, data: unknown): unknown;
  leave(room: string): unknown;
  disconnect?(close?: boolean): unknown;
}

export interface VisibilityDeliveryDependencies {
  sockets(): Iterable<VisibilitySocket>;
  canReadTask(userId: string, taskId: string): Promise<boolean>;
  /** Additional shared discussion policy, including persisted internal markers. */
  canReadMessage?(userId: string, taskId: string, data: unknown): Promise<boolean>;
  /** Per-recipient task payload projection (e.g. inherited internal files). `null` suppresses. */
  projectTask?(userId: string, taskId: string, projectId: string | undefined, data: unknown): Promise<unknown | null>;
  canReadProject(userId: string, projectId: string): Promise<boolean>;
  canReadNotification(data: unknown): Promise<boolean>;
  currentGlobalRole?(userId: string): Promise<string | null>;
  /**
   * Account status. Cached briefly by this module because the sweep runs for
   * every socket; a missing dependency keeps the historical behaviour.
   */
  isAccountAllowed?(userId: string): Promise<boolean>;
}

/** One status read per actor per sweep window instead of one per socket. */
const ACCOUNT_STATUS_TTL_MS = 3000;
const ACCOUNT_STATUS_CACHE_LIMIT = 10_000;

/** `null` means the status could not be read. It never authorizes delivery. */
type AccountStatus = boolean | null;

export function createVisibilityDelivery(deps: VisibilityDeliveryDependencies) {
  const known = new WeakMap<VisibilitySocket, Map<string, string | undefined>>();
  /**
   * Bumped by every eviction and revocation. A delivery captures the value
   * before awaiting policy and re-checks it before emitting, so a revoke that
   * lands while the check is in flight still suppresses the payload.
   */
  const generations = new WeakMap<VisibilitySocket, number>();
  const generationOf = (socket: VisibilitySocket) => generations.get(socket) ?? 0;
  const bumpGeneration = (socket: VisibilitySocket) => { generations.set(socket, generationOf(socket) + 1); };
  const accountStatus = new Map<string, { status: Promise<AccountStatus>; expiresAt: number }>();
  const allowed = async (check: () => Promise<boolean>) => {
    try { return await check(); } catch { return false; }
  };
  /** Revocation invalidates the cached answer instead of waiting for the TTL. */
  const invalidateAccountStatus = (userId: string) => { accountStatus.delete(userId); };
  /**
   * Cached account status. A failed read resolves to `null` (unknown) and is
   * evicted as soon as it settles: an error must neither allow delivery nor be
   * cached as a durable answer for the whole TTL.
   */
  const readAccountStatus = (userId: string): Promise<AccountStatus> => {
    if (!deps.isAccountAllowed) return Promise.resolve(true);
    const now = Date.now();
    const cached = accountStatus.get(userId);
    if (cached && cached.expiresAt > now) return cached.status;
    let pending: Promise<AccountStatus>;
    try {
      pending = Promise.resolve(deps.isAccountAllowed(userId)).then(value => value === true, () => null);
    } catch {
      pending = Promise.resolve(null);
    }
    const entry = { status: pending, expiresAt: now + ACCOUNT_STATUS_TTL_MS };
    accountStatus.set(userId, entry);
    void pending.then(status => {
      if (status === null && accountStatus.get(userId) === entry) accountStatus.delete(userId);
    });
    if (accountStatus.size > ACCOUNT_STATUS_CACHE_LIMIT) {
      for (const [key, item] of accountStatus) if (item.expiresAt <= now) accountStatus.delete(key);
    }
    return pending;
  };
  /** Delivery is fail-closed: only a successful "allowed" read authorizes it. */
  const accountAllowsDelivery = async (userId: string) => (await readAccountStatus(userId)) === true;
  const revoke = async (socket: VisibilitySocket, userId: string, reason: string) => {
    // Membership and any in-flight delivery are invalidated before the awaits
    // below, so a payload already past its policy check cannot still be sent.
    bumpGeneration(socket);
    invalidateAccountStatus(userId);
    for (const room of [...socket.rooms]) {
      if (room === socket.id) continue;
      try { await socket.leave(room); } catch { /* Delivery already fails closed. */ }
    }
    known.delete(socket);
    try { socket.emit('auth.revoked', { userId, reason }); } catch { /* Transport is gone. */ }
    try { socket.disconnect?.(true); } catch { /* Transport is gone. */ }
  };
  const revokeUserSockets = async (userId: string, reason = 'auth-revoked') => {
    await Promise.all([...deps.sockets()].filter(socket => socket.data.userId === userId)
      .map(socket => revoke(socket, userId, reason)));
  };
  const forget = async (socket: VisibilitySocket, taskId: string, projectId?: string) => {
    bumpGeneration(socket);
    const seen = known.get(socket);
    const wasKnown = seen?.has(taskId) || socket.rooms.has(`task:${taskId}`);
    seen?.delete(taskId);
    try { await socket.leave(`task:${taskId}`); } catch { /* Delivery still checks policy. */ }
    // Reuse the existing client eviction event, only for previously visible IDs.
    if (wasKnown) socket.emit('task:deleted', { taskId, projectId });
  };
  const task = async (taskId: string, event: string, data: unknown, projectId?: string, excludeId?: string) => {
    const room = `task:${taskId}`;
    const inScope = (socket: VisibilitySocket) => socket.rooms.has(room)
      || Boolean(projectId && socket.rooms.has(`project:${projectId}`));
    for (const socket of deps.sockets()) {
      if (!inScope(socket)) continue;
      try {
        const userId = socket.data.userId;
        if (event === 'task:deleted' || !userId) {
          await forget(socket, taskId, projectId);
          continue;
        }
        const generation = generationOf(socket);
        // Account status gates delivery itself, not only the periodic sweep.
        const [status, readable] = await Promise.all([
          readAccountStatus(userId),
          allowed(() => deps.canReadTask(userId, taskId)),
        ]);
        // A blocked account is revoked here too; an unreadable status is
        // unknown and only suppresses the payload (the session may stay open).
        if (status === false) {
          await revoke(socket, userId, 'account-blocked');
          continue;
        }
        if (status === null) continue;
        if (!readable) {
          if (known.get(socket)?.has(taskId) || socket.rooms.has(room)) {
            await revokeUserSockets(userId, 'task-access-revoked');
          }
          continue;
        }
        if (event.startsWith('message:')) {
          const row = data as { visibility?: unknown; isInternal?: unknown } | null;
          const internal = row?.visibility === 'INTERNAL' || row?.isInternal === true;
          if (deps.canReadMessage) {
            if (!(await allowed(() => deps.canReadMessage!(userId, taskId, data)))) continue;
          } else if (internal) continue;
        }
        if (socket.id === excludeId) continue;
        let payload = data;
        if (event.startsWith('task:') && deps.projectTask) {
          try { payload = await deps.projectTask(userId, taskId, projectId, data); }
          catch { continue; }
          // A projection refusal is final for this recipient, never a fallback
          // to the unprojected room payload.
          if (payload === null) continue;
        }
        // A revoke/eviction that completed while the checks were in flight wins.
        if (generationOf(socket) !== generation || !inScope(socket)) continue;
        const seen = known.get(socket) ?? new Map<string, string | undefined>();
        seen.set(taskId, projectId);
        known.set(socket, seen);
        socket.emit(event, payload);
      } catch { /* One broken transport cannot expose data or suppress peers. */ }
    }
  };
  /** Returns whether the socket may still receive data after the sweep. */
  const revalidate = async (socket: VisibilitySocket): Promise<boolean> => {
    const userId = socket.data.userId;
    if (userId && deps.currentGlobalRole) {
      try {
        const role = await deps.currentGlobalRole(userId);
        if (role === null || role !== socket.data.globalRole) {
          await revokeUserSockets(userId, 'role-changed');
          return false;
        }
      } catch { return false; }
    }
    const status = userId ? await readAccountStatus(userId) : true;
    if (userId && status === false) {
      await revoke(socket, userId, 'account-blocked');
      return false;
    }
    // Unknown status: no revocation, but no delivery either.
    if (userId && status === null) return false;
    const tasks = new Map(known.get(socket));
    for (const room of socket.rooms) {
      if (room.startsWith('task:')) tasks.set(room.slice(5), tasks.get(room.slice(5)));
      if (room.startsWith('project:') && (!userId || !(await allowed(() => deps.canReadProject(userId, room.slice(8)))))) {
        if (userId) await revokeUserSockets(userId, 'project-access-revoked');
        return false;
      }
    }
    for (const [taskId, projectId] of tasks) {
      if (!userId || !(await allowed(() => deps.canReadTask(userId, taskId)))) {
        if (userId) await revokeUserSockets(userId, 'task-access-revoked');
        else await forget(socket, taskId, projectId);
        return false;
      }
    }
    return true;
  };
  return {
    task,
    revalidate,
    revokeUserSockets,
    async dispatch(event: string, roomId: string, data: unknown) {
      if (event === REQUEST_QUEUE_INVALIDATED || event === NOTIFICATION_CHANGED) {
        if (!/^user:[A-Za-z0-9_-]{1,128}$/.test(roomId) || !(event===NOTIFICATION_CHANGED?isNotificationChanged(data):isRequestQueueInvalidation(data))) return;
        for (const socket of deps.sockets()) {
          const userId = socket.data.userId;
          if (!userId || roomId !== `user:${userId}` || !socket.rooms.has(roomId)) continue;
          const generation = generationOf(socket);
          // No task grant/data is delivered. Prior recipients must also refresh
          // after losing eligibility; checking task read here would retain stale counts.
          if (!(await accountAllowsDelivery(userId))) continue;
          if (generationOf(socket) !== generation || socket.data.userId !== userId || !socket.rooms.has(roomId)) continue;
          try { socket.emit(event, event===NOTIFICATION_CHANGED?{version:1}:{}); } catch { /* One device does not suppress peers. */ }
        }
        return;
      }
      if (event === 'auth.revoked') {
        const row = data as { userId?: unknown; reason?: unknown } | null;
        if (!row || typeof row.userId !== 'string' || !row.userId) return;
        const reason = typeof row.reason === 'string' && row.reason ? row.reason : 'auth-revoked';
        await revokeUserSockets(row.userId, reason);
        return;
      }
      if (event === 'notification:new') {
        if (!(await allowed(() => deps.canReadNotification(data)))) return;
        for (const socket of deps.sockets()) {
          if (!socket.rooms.has(roomId) || roomId !== `user:${socket.data.userId}`) continue;
          const userId = socket.data.userId;
          // Same rule as task payloads: a revoke or eviction that lands while
          // the account/notification check is in flight still suppresses it.
          const generation = generationOf(socket);
          if (userId && !(await accountAllowsDelivery(userId))) continue;
          if (generationOf(socket) !== generation || !socket.rooms.has(roomId)) continue;
          socket.emit(event, data);
        }
        return;
      }
      const projectId = roomId.slice('project:'.length);
      if (event === 'message:new' || event === 'message:updated') {
        const row = data as { taskId?: string };
        // Project membership selects candidates only. The normal chat path
        // checks current task, internal discussion and file visibility again.
        if (row.taskId) await task(row.taskId, event, data, projectId);
        return;
      }
      if (event.startsWith('task:')) {
        const row = data as { id?: string; taskId?: string; task?: { id: string } };
        const taskId = event === 'task:moved' ? row.task?.id : row.taskId ?? row.id;
        if (taskId) await task(taskId, event, data, projectId);
        return;
      }
      for (const socket of deps.sockets()) {
        if (!socket.rooms.has(roomId)) continue;
        // revalidate already applied canReadProject for this room and left it
        // when access was denied; checking the room avoids a second query.
        const generation = generationOf(socket);
        const deliverable = await revalidate(socket);
        if (!deliverable || generationOf(socket) !== generation || !socket.rooms.has(roomId)) continue;
        socket.emit(event, data);
      }
    },
  };
}
