import { describe, expect, it, vi } from 'vitest';
import { createVisibilityDelivery, type VisibilitySocket } from './visibility-delivery';

function fixture() {
  const socket = (id: string): VisibilitySocket => ({
    id, data: { userId: id }, rooms: new Set(['project:p', 'task:t', `user:${id}`]),
    emit: vi.fn(), leave: vi.fn(function (this: VisibilitySocket, room: string) { this.rooms.delete(room); }),
  });
  const a = socket('a');
  const b = socket('b');
  const permitted = new Set(['a']);
  const deps = {
    sockets: () => [a, b],
    canReadTask: vi.fn(async (userId: string) => permitted.has(userId)),
    canReadProject: vi.fn(async () => true),
    canReadNotification: vi.fn(async () => true),
    isAccountAllowed: vi.fn(async () => true),
  };
  return { a, b, permitted, deps, delivery: createVisibilityDelivery(deps) };
}

describe('current recipient visibility', () => {
  it('routes HTTP chat events through fresh task/internal/file policy rather than project broadcasts', async () => {
    const f = fixture();
    f.permitted.add('b');
    const canReadMessage = vi.fn(async (userId: string) => userId === 'a');
    const delivery = createVisibilityDelivery({...f.deps, canReadMessage});
    const internal = { id:'m', taskId:'t', isInternal:true, visibility:'INTERNAL', attachments:[] };
    await delivery.dispatch('message:new', 'project:p', internal);
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('message:new', internal);
    expect(f.b.emit).not.toHaveBeenCalled();
    expect(canReadMessage.mock.calls.map(call => call[0])).toEqual(['a','b']);
    f.a.emit = vi.fn();
    canReadMessage.mockResolvedValue(false); // permission/file metadata revoked after commit
    await delivery.dispatch('message:new', 'project:p', {...internal, id:'m2'});
    expect(f.a.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
    expect(f.b.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
  });
  it('projects task attachment metadata for each current recipient and honors revoked internal access', async () => {
    const f = fixture();
    f.permitted.add('b');
    const publicFile = { url: 'public', name: 'public.txt', size: 1, mime: 'text/plain' };
    const internalFile = { ...publicFile, url: 'internal', name: 'internal.txt' };
    const internalReaders = new Set(['a']);
    const projectTask = vi.fn(async (
      userId: string, _taskId: string, _projectId: string | undefined, data: unknown,
    ): Promise<unknown | null> => ({
      ...(data as Record<string, unknown>),
      attachments: internalReaders.has(userId) ? [publicFile, internalFile] : [publicFile],
    }));
    const delivery = createVisibilityDelivery({ ...f.deps, projectTask });
    const payload = { id: 't', projectId: 'p', attachments: [publicFile, { ...internalFile, isInternal: true }] };

    await delivery.dispatch('task:updated', 'project:p', payload);
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('task:updated', { ...payload, attachments: [publicFile, internalFile] });
    expect(f.b.emit).toHaveBeenCalledExactlyOnceWith('task:updated', { ...payload, attachments: [publicFile] });

    f.a.emit = vi.fn(); f.b.emit = vi.fn();
    internalReaders.delete('a');
    await delivery.dispatch('task:updated', 'project:p', payload);
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('task:updated', { ...payload, attachments: [publicFile] });
    expect(f.b.emit).toHaveBeenCalledExactlyOnceWith('task:updated', { ...payload, attachments: [publicFile] });

    f.a.emit = vi.fn(); f.b.emit = vi.fn();
    projectTask.mockResolvedValueOnce(null);
    await delivery.dispatch('task:updated', 'project:p', payload);
    expect(f.a.emit).not.toHaveBeenCalled();
    expect(f.b.emit).toHaveBeenCalledExactlyOnceWith('task:updated', { ...payload, attachments: [publicFile] });
    expect(projectTask).toHaveBeenCalledWith('a', 't', 'p', payload);
    expect(projectTask).toHaveBeenCalledWith('b', 't', 'p', payload);
  });

  it('fails closed on internal HTTP events when no discussion policy is available', async () => {
    const f = fixture();
    await f.delivery.dispatch('message:new','project:p',{id:'m',taskId:'t',isInternal:true});
    expect(f.a.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
    expect(f.b.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
  });
  it('checks both users and never broadcasts task/chat content through a project room', async () => {
    const f = fixture();
    // B knows only the project, never the hidden task ID.
    f.b.rooms.delete('task:t');
    await f.delivery.dispatch('task:updated', 'project:p', { id: 't', title: 'private' });
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('task:updated', { id: 't', title: 'private' });
    expect(f.b.emit).not.toHaveBeenCalled();
    await f.delivery.task('t', 'message:new', { taskId: 't', contentText: 'private chat' }, 'p');
    expect(f.b.emit).not.toHaveBeenCalled();
    expect(f.deps.canReadTask.mock.calls.map(args => args[0])).toEqual(['a', 'b', 'a', 'b']);
  });

  it('revokes an already open subscription and evicts known data without reconnecting', async () => {
    const f = fixture();
    await f.delivery.task('t', 'message:new', { secret: 'before' }, 'p');
    f.a.emit = vi.fn();
    f.permitted.delete('a');
    await f.delivery.revalidate(f.a);
    expect(f.a.leave).toHaveBeenCalledWith('task:t');
    expect(f.a.rooms.has('task:t')).toBe(false);
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('auth.revoked', { userId: 'a', reason: 'task-access-revoked' });
    await f.delivery.task('t', 'message:new', { secret: 'after' }, 'p');
    expect(f.a.emit).toHaveBeenCalledTimes(1);
  });

  it('fails closed on storage errors and does not stop authorized peers', async () => {
    const f = fixture();
    f.deps.canReadTask.mockImplementation(async userId => {
      if (userId === 'a') throw new Error('synthetic secret');
      return true;
    });
    await f.delivery.task('t', 'message:new', { body: 'private' });
    expect(f.a.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
    expect(f.b.emit).toHaveBeenCalledExactlyOnceWith('message:new', { body: 'private' });
  });

  it('checks delayed notifications at dispatch and binds personal rooms to their actor', async () => {
    const f = fixture();
    f.b.rooms.add('user:a');
    await f.delivery.dispatch('notification:new', 'user:a', { userId: 'a' });
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('notification:new', { userId: 'a' });
    expect(f.b.emit).not.toHaveBeenCalled();
    f.deps.canReadNotification.mockResolvedValue(false);
    await f.delivery.dispatch('notification:new', 'user:a', { userId: 'a', title: 'revoked' });
    expect(f.a.emit).toHaveBeenCalledTimes(1);
  });

  it('suppresses a notification revoked while its account check is in flight', async () => {
    const f = fixture();
    let release: (value: boolean) => void = () => undefined;
    f.deps.isAccountAllowed = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const delivery = createVisibilityDelivery(f.deps);
    const pending = delivery.dispatch('notification:new', 'user:a', { userId: 'a', title: 'private task' });
    // The revoke lands while the status read is still pending.
    await delivery.dispatch('auth.revoked', 'user:a', { userId: 'a', reason: 'assignment-removed' });
    release(true);
    await pending;
    expect(f.a.emit).not.toHaveBeenCalledWith('notification:new', expect.anything());
  });

  it('does not deliver a notification to a peer who joined someone else\'s room', async () => {
    const f = fixture();
    f.b.rooms.add('user:a');
    await f.delivery.dispatch('notification:new', 'user:a', { userId: 'a', title: 'private task' });
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('notification:new', { userId: 'a', title: 'private task' });
    expect(f.b.emit).not.toHaveBeenCalled();
  });

  it('sends deleted IDs only to subjects that previously knew the task', async () => {
    const f = fixture();
    f.b.rooms.delete('task:t');
    await f.delivery.dispatch('task:deleted', 'project:p', { taskId: 't' });
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('task:deleted', { taskId: 't', projectId: 'p' });
    expect(f.b.emit).not.toHaveBeenCalled();
  });
});

describe('account status gates delivery, not only the sweep (#40)', () => {
  function statusFixture(status: (userId: string) => Promise<boolean>) {
    const base = fixture();
    const deps = { ...base.deps, isAccountAllowed: vi.fn(status) };
    return { ...base, deps, delivery: createVisibilityDelivery(deps) };
  }

  it('never delivers task data to a blocked account through an open room', async () => {
    const f = statusFixture(async userId => userId !== 'a');
    f.permitted.add('b');
    await f.delivery.task('t', 'message:new', { contentText: 'private' }, 'p');
    expect(f.a.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('auth.revoked', { userId: 'a', reason: 'account-blocked' });
    expect(f.a.rooms.has('task:t')).toBe(false);
    expect(f.b.emit).toHaveBeenCalledExactlyOnceWith('message:new', { contentText: 'private' });
  });

  it('fails closed when the status cannot be read and does not cache the failure as allowed', async () => {
    const f = statusFixture(async () => { throw new Error('synthetic storage error'); });
    await f.delivery.task('t', 'message:new', { contentText: 'private' }, 'p');
    expect(f.a.emit).not.toHaveBeenCalled();
    expect(f.b.emit).not.toHaveBeenCalled();
    // A failed read is not a cached "allowed": the next call reads again.
    f.deps.isAccountAllowed.mockResolvedValue(true);
    await f.delivery.task('t', 'message:new', { contentText: 'later' }, 'p');
    expect(f.a.emit).toHaveBeenCalledExactlyOnceWith('message:new', { contentText: 'later' });
  });

  it('reuses one status read for peers and drops the cached answer when an account is revoked', async () => {
    const f = statusFixture(async () => true);
    // Two sockets of the same actor share one status read.
    f.b.data.userId = 'a';
    await f.delivery.task('t', 'message:new', { body: 'first' }, 'p');
    expect(f.deps.isAccountAllowed).toHaveBeenCalledTimes(1);
    f.deps.isAccountAllowed.mockResolvedValue(false);
    await f.delivery.dispatch('auth.revoked', 'user:a', { userId: 'a', reason: 'blocked' });
    // A revoke drops the positive entry, so a reconnect re-reads instead of
    // serving the cached "allowed" for the rest of the 3s window.
    const reconnect: VisibilitySocket = {
      id: 's2', data: { userId: 'a' }, rooms: new Set(['s2', 'task:t']),
      emit: vi.fn(), leave: vi.fn(function (this: VisibilitySocket, room: string) { this.rooms.delete(room); }),
      disconnect: vi.fn(),
    };
    await f.delivery.revalidate(reconnect);
    expect(f.deps.isAccountAllowed).toHaveBeenCalledTimes(2);
    expect(reconnect.emit).toHaveBeenCalledWith('auth.revoked', { userId: 'a', reason: 'account-blocked' });
  });
});

describe('a revoke that lands during the policy await wins (#40)', () => {
  it('suppresses the payload when the subscription is evicted while canReadTask is in flight', async () => {
    const f = fixture();
    let release: (value: boolean) => void = () => undefined;
    let calls = 0;
    f.deps.canReadTask.mockImplementation(() => {
      calls += 1;
      // Only the in-flight check for the first socket is held open.
      return calls === 1 ? new Promise<boolean>(resolve => { release = resolve; }) : Promise.resolve(true);
    });
    const pending = f.delivery.task('t', 'message:new', { contentText: 'racing' }, 'p');
    // The revocation lands while the in-flight policy check is still pending.
    await f.delivery.dispatch('auth.revoked', 'user:a', { userId: 'a', reason: 'role-demoted' });
    release(true);
    await pending;
    expect(f.a.rooms.has('task:t')).toBe(false);
    expect(f.a.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
  });
});
