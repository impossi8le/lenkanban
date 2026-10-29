import { expect, it } from 'vitest';
import { isInternalEmitPayload } from './internal-emit-contract';
import { isRequestQueueInvalidation, REQUEST_QUEUE_INVALIDATED } from './request-queue-contract';

it('admits only opaque personal-room invalidation, never a shared actor/task/count projection', () => {
  expect(isInternalEmitPayload({ event: REQUEST_QUEUE_INVALIDATED, roomId: 'user:actor', data: {} })).toBe(true);
  for (const data of [null, [], undefined, { taskId: 'private' }, { count: 2 }, { unseen: true }, { actorId: 'other' }]) {
    expect(isRequestQueueInvalidation(data)).toBe(false);
    expect(isInternalEmitPayload({ event: REQUEST_QUEUE_INVALIDATED, roomId: 'user:actor', data })).toBe(false);
  }
  for (const roomId of ['project:board', 'task:private', 'user:', 'user:actor/other']) {
    expect(isInternalEmitPayload({ event: REQUEST_QUEUE_INVALIDATED, roomId, data: {} })).toBe(false);
  }
});
