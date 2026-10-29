import { expect, it, vi } from 'vitest';
import { createVisibilityDelivery, type VisibilitySocket } from './visibility-delivery';

it('checks discussion rights separately for messages, updates and deletions', async () => {
  const sockets: VisibilitySocket[] = ['author', 'group'].map(userId => ({
    id: userId, data: { userId }, rooms: new Set(['task:t']),
    emit: vi.fn(), leave: vi.fn(),
  }));
  const canReadMessage = vi.fn(async (userId: string) => userId === 'group');
  const delivery = createVisibilityDelivery({
    sockets: () => sockets, canReadTask: async () => true,
    canReadProject: async () => true, canReadNotification: async () => true,
    canReadMessage,
  });
  for (const event of ['message:new', 'message:updated', 'message:deleted']) {
    await delivery.task('t', event, { messageId: 'm', isInternal: true });
    expect(sockets[0].emit).not.toHaveBeenCalled();
    expect(sockets[1].emit).toHaveBeenCalledWith(event, { messageId: 'm', isInternal: true });
  }
  canReadMessage.mockResolvedValue(false);
  await delivery.task('t', 'message:new', { messageId: 'm2', visibility: 'INTERNAL' });
  expect(sockets[1].emit).toHaveBeenCalledTimes(3);
});

it('fails closed for flagged internal messages without an internal policy', async () => {
  const emit = vi.fn();
  const delivery = createVisibilityDelivery({
    sockets: () => [{ id: 's', data: { userId: 'a' }, rooms: new Set(['task:t']), emit, leave: vi.fn() }],
    canReadTask: async () => true, canReadProject: async () => true, canReadNotification: async () => true,
  });
  await delivery.task('t', 'message:new', { visibility: 'INTERNAL' });
  expect(emit).not.toHaveBeenCalled();
});
