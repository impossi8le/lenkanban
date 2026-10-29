import { expect, it, vi } from 'vitest';
import { createVisibilityDelivery, type VisibilitySocket } from './visibility-delivery';
import { REQUEST_QUEUE_INVALIDATED } from './request-queue-contract';

function fixture() {
  const socket = (id: string, actor: string): VisibilitySocket => ({ id, data: { userId: actor }, rooms: new Set([`user:${actor}`]),
    emit: vi.fn(), leave: vi.fn(function(this: VisibilitySocket, room: string) { this.rooms.delete(room); }), disconnect: vi.fn() });
  const sockets = [socket('phone', 'a'), socket('desktop', 'a'), socket('outsider', 'b')];
  const deps = { sockets: () => sockets, canReadTask: vi.fn(async () => false), canReadProject: vi.fn(async () => false),
    canReadNotification: vi.fn(async () => false), isAccountAllowed: vi.fn(async () => true) };
  return { sockets, deps };
}

it('invalidates all own devices on their user room without joining a project or reading a now-ineligible task', async () => {
  const { sockets, deps } = fixture();
  await createVisibilityDelivery(deps).dispatch(REQUEST_QUEUE_INVALIDATED, 'user:a', {});
  expect(sockets[0].emit).toHaveBeenCalledExactlyOnceWith(REQUEST_QUEUE_INVALIDATED, {});
  expect(sockets[1].emit).toHaveBeenCalledExactlyOnceWith(REQUEST_QUEUE_INVALIDATED, {});
  expect(sockets[2].emit).not.toHaveBeenCalled();
  expect(deps.canReadTask).not.toHaveBeenCalled();
  expect(deps.canReadNotification).not.toHaveBeenCalled();
});

it('rejects project scopes, extra metadata and blocked/unknown accounts', async () => {
  const { sockets, deps } = fixture();
  const delivery = createVisibilityDelivery(deps);
  await delivery.dispatch(REQUEST_QUEUE_INVALIDATED, 'project:p', {});
  await delivery.dispatch(REQUEST_QUEUE_INVALIDATED, 'user:a', { taskId: 'secret' });
  deps.isAccountAllowed.mockResolvedValue(false);
  await delivery.dispatch(REQUEST_QUEUE_INVALIDATED, 'user:a', {});
  expect(sockets.every(socket => vi.mocked(socket.emit).mock.calls.length === 0)).toBe(true);
  const fresh = createVisibilityDelivery({ ...deps, isAccountAllowed: vi.fn(async () => { throw new Error('unavailable'); }) });
  await fresh.dispatch(REQUEST_QUEUE_INVALIDATED, 'user:a', {});
  expect(sockets.every(socket => vi.mocked(socket.emit).mock.calls.length === 0)).toBe(true);
});

it('suppresses an invalidation revoked while the account gate was pending', async () => {
  const { sockets, deps } = fixture();
  let finish!: (allowed: boolean) => void;
  const delivery = createVisibilityDelivery({ ...deps, isAccountAllowed: () => new Promise(resolve => { finish = resolve; }) });
  const pending = delivery.dispatch(REQUEST_QUEUE_INVALIDATED, 'user:a', {});
  await delivery.revokeUserSockets('a');
  finish(true);
  await pending;
  expect(sockets[0].emit).not.toHaveBeenCalledWith(REQUEST_QUEUE_INVALIDATED, expect.anything());
  expect(sockets[1].emit).not.toHaveBeenCalledWith(REQUEST_QUEUE_INVALIDATED, expect.anything());
});
