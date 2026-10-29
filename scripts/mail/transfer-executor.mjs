import { verifyPlan, simulateTransfer, rollbackTransfer, emptyTransferState } from './transfer-plan.mjs';

const fail = code => { throw new Error(code); };

function requireAdapter(adapter, enabled) {
  if (enabled !== true) fail('DATABASE_IMPORT_DISABLED');
  if (!adapter || typeof adapter.transaction !== 'function') fail('APPLICATION_ADAPTER_REQUIRED');
}

/**
 * Injection boundary for a future application integration. It is supplied by the
 * trusted launcher, never by a path, environment variable, plan or message. The
 * adapter must use the existing server authorization, mutation mechanism, Activity
 * history and attachment ACLs; its transaction must commit cards and ledger
 * atomically and roll back on any thrown error. The trusted import-cli launcher
 * supplies prisma-adapter.mjs; plans cannot select an adapter implementation.
 */
export async function executeTransfer({ plan, approval, batch_id: batchId, enabled = false, adapter }) {
  requireAdapter(adapter, enabled);
  verifyPlan(plan, approval);
  return adapter.transaction(async tx => {
    // Fresh server authorization applies to an idempotent replay as well.
    await tx.authorizeTransfer({ operation: 'import', batch_id: batchId, plan: structuredClone(plan) });
    const state = await tx.loadTransferState() ?? emptyTransferState();
    const transition = simulateTransfer(plan, state, { batch_id: batchId, approval });
    const batch = transition.state.batches[batchId];
    // A simulation ledger is not a database receipt: every key in an applied batch
    // needs a real target ID, otherwise a simulated card could suppress a write.
    const existing = transition.result.status === 'already_applied' ? [...batch.created, ...batch.reused] : batch.reused;
    for (const key of existing) {
      if (!state.cards[key]?.target_id) fail('MISSING_IMPORTED_CARD_ID');
    }
    if (transition.result.status === 'already_applied') return transition.result;
    const targetIds = new Set(Object.values(state.cards).map(card => card.target_id).filter(Boolean));
    for (const key of batch.created) {
      const card = transition.state.cards[key];
      const id = await tx.createImportedCard({ import_key: key, batch_id: batchId, payload: structuredClone(card.payload) });
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) fail('INVALID_IMPORTED_CARD_ID');
      if (targetIds.has(id)) fail('DUPLICATE_IMPORTED_CARD_ID');
      targetIds.add(id);
      card.target_id = id;
    }
    // A durable business receipt, not a log of message contents.
    transition.state.journal.at(-1).operation = 'import';
    await tx.saveTransferState(transition.state);
    return transition.result;
  });
}

export async function executeRollback({ batch_id: batchId, enabled = false, adapter }) {
  requireAdapter(adapter, enabled);
  return adapter.transaction(async tx => {
    await tx.authorizeTransfer({ operation: 'rollback', batch_id: batchId });
    const state = await tx.loadTransferState();
    if (!state) fail('UNKNOWN_BATCH');
    const transition = rollbackTransfer(state, batchId);
    if (transition.result.status === 'already_rolled_back') return transition.result;
    for (const key of state.batches[batchId].created) {
      const card = state.cards[key];
      // The adapter must reject a changed card, foreign ownership or an ACL mismatch
      // in the same transaction; never delete by target_id alone.
      if (!card.target_id) fail('MISSING_IMPORTED_CARD_ID');
      await tx.deleteImportedCard({
        target_id: card.target_id, import_key: key, batch_id: batchId,
        expected_payload: structuredClone(card.payload),
      });
    }
    await tx.saveTransferState(transition.state);
    return transition.result;
  });
}
