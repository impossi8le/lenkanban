import { beforeEach, expect, it, vi } from 'vitest';
import { emitRequestQueueInvalidation, emitRequestQueueSeenInvalidation } from './request-queue-events';

const controls = vi.hoisted(() => ({ recipients: vi.fn(), emit: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/request-queue-unseen', () => ({ readRequestQueueRecipientIds: controls.recipients }));
vi.mock('./board-events', () => ({ emitUserRequestQueueInvalidation: controls.emit }));
beforeEach(() => { controls.recipients.mockReset().mockResolvedValue(['a', 'b', 'a']); controls.emit.mockReset().mockResolvedValue(undefined); });

it('uses fresh common recipient policy, deduplicates prior actors and clears removed actors without sending task data', async () => {
  const db = {} as Parameters<typeof emitRequestQueueInvalidation>[1];
  await emitRequestQueueInvalidation({ taskId: 'task', projectId: 'project', previousRecipientIds: ['removed', 'a', 'bad/id'] }, db);
  expect(controls.recipients).toHaveBeenCalledExactlyOnceWith(db, 'task', 'project');
  expect(controls.emit.mock.calls.map(([actor]) => actor).sort()).toEqual(['a', 'b', 'removed']);
  expect(controls.emit.mock.calls.every(call => call.length === 1)).toBe(true);
});

it('still clears captured prior recipients when a deleted task or fresh policy read returns no eligibility', async () => {
  controls.recipients.mockRejectedValue(new Error('not available'));
  controls.emit.mockRejectedValue(new Error('bridge unavailable'));
  await expect(emitRequestQueueInvalidation({ taskId: 'deleted', projectId: 'project', previousRecipientIds: ['prior'] })).resolves.toBeUndefined();
  expect(controls.emit).toHaveBeenCalledExactlyOnceWith('prior');
});

it('seen commits refresh only their actor and malformed identities produce no bridge or policy reads', async () => {
  await emitRequestQueueSeenInvalidation('a');
  expect(controls.emit).toHaveBeenCalledExactlyOnceWith('a');
  controls.emit.mockClear();
  await emitRequestQueueSeenInvalidation('bad/id');
  await emitRequestQueueInvalidation({ taskId: 'task', projectId: 'bad/id' });
  expect(controls.emit).not.toHaveBeenCalled();
  expect(controls.recipients).not.toHaveBeenCalled();
});

it('bounds concurrent bridge sends while reaching all recipients', async () => {
  controls.recipients.mockResolvedValue(Array.from({ length: 23 }, (_, index) => `actor-${index}`));
  let inFlight = 0, peak = 0;
  controls.emit.mockImplementation(async () => { peak = Math.max(peak, ++inFlight); await Promise.resolve(); --inFlight; });
  await emitRequestQueueInvalidation({ taskId: 'task', projectId: 'project' });
  expect(controls.emit).toHaveBeenCalledTimes(23);
  expect(peak).toBeLessThanOrEqual(8);
});
