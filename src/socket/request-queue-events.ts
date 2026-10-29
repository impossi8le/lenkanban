import { emitUserRequestQueueInvalidation } from './board-events';
import { prisma } from '@/lib/prisma';
import { readRequestQueueRecipientIds, type RequestQueueReadDatabase } from '@/lib/request-queue-unseen';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Call only after a committed changed=true queue-seen acknowledgement. */
export async function emitRequestQueueSeenInvalidation(actorId: string): Promise<void> {
  if (!validId(actorId)) return;
  try { await emitUserRequestQueueInvalidation(actorId); }
  catch { /* A refresh transport failure never replaces an already committed ACK. */ }
}

/**
 * Post-commit only. Recipient eligibility deliberately ignores queue state:
 * taking/cancelling must clear the old SUBMITTED projection on every device.
 * Prior recipients carry no grant: their event is empty and only refetches ACL.
 */
export async function emitRequestQueueInvalidation(input: {
  taskId: string;
  projectId: string;
  previousRecipientIds?: readonly string[];
}, database: RequestQueueReadDatabase = prisma): Promise<void> {
  if (!validId(input.taskId) || !validId(input.projectId)) return;
  const recipients = new Set((input.previousRecipientIds ?? []).filter(validId));
  try {
    for (const actorId of await readRequestQueueRecipientIds(database, input.taskId, input.projectId)) {
      if (validId(actorId)) recipients.add(actorId);
    }
  } catch { /* Unknown fresh policy grants nothing; prior projections can still be cleared. */ }
  const targets = [...recipients];
  let cursor = 0;
  // Reuse the bounded existing bridge, with no unbounded burst of HTTP requests.
  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, async () => {
    while (cursor < targets.length) {
      const actorId = targets[cursor++];
      await emitRequestQueueSeenInvalidation(actorId);
    }
  }));
}
