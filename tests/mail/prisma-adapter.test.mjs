import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, emptyTransferState } from '../../scripts/mail/transfer-plan.mjs';
import { createPrismaTransferAdapter } from '../../scripts/mail/prisma-adapter.mjs';
import { executeTransfer, executeRollback } from '../../scripts/mail/transfer-executor.mjs';
import { runImportCli } from '../../scripts/mail/import-cli.mjs';
import { importPlan } from './prisma-fixture.mjs';

function fixture({ role = 'ADMIN', missing = false, blocked = false } = {}) {
  const tasks = new Map();
  const deleted = [];
  let row;
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => missing ? null : { id: 'admin', globalRole: role, isBlocked: blocked } },
    task: {
      findUnique: async ({ where }) => structuredClone(tasks.get(where.importKey) ?? null),
      findMany: async ({ where }) => [...tasks.entries()].filter(([key]) => where.importKey.in.includes(key)).map(([, task]) => ({ projectId: task.projectId ?? 'project' })),
      delete: async ({ where }) => { deleted.push(where.importKey); tasks.delete(where.importKey); },
    },
    mailImportBatch: {
      findUnique: async ({ where }) => { assert.equal(where.batchId, 'mail-import'); return row; },
      upsert: async args => { row = structuredClone({ state: args.update.state }); },
    },
  };
  const prisma = { $transaction: async fn => fn(tx) };
  const adapter = createPrismaTransferAdapter({ prisma, actorId: 'admin' });
  return { adapter, tasks, deleted, setState: state => { row = { state }; }, tx };
}

for (const options of [{ role: 'USER' }, { missing: true }, { blocked: true }]) {
  test(`reject unauthorized actor ${JSON.stringify(options)} before reading the ledger`, async () => {
    const f = fixture(options);
    f.tx.mailImportBatch.findUnique = () => { assert.fail('must not read ledger'); };
    const plan = importPlan();
    await assert.rejects(executeTransfer({ plan, approval: plan.plan_sha256, batch_id: 'batch', enabled: true, adapter: f.adapter }), /FORBIDDEN/);
    await assert.rejects(executeRollback({ batch_id: 'batch', enabled: true, adapter: f.adapter }), /FORBIDDEN/);
  });
}

test('existing unique importKey returns the same target without a second insert', async () => {
  const f = fixture();
  f.tasks.set('key', { id: 'existing' });
  await f.adapter.transaction(async tx => {
    await assert.rejects(tx.createImportedCard({ import_key: 'key', batch_id: 'batch', payload: {} }), /FORBIDDEN/);
    await tx.authorizeTransfer({ operation: 'import', batch_id: 'batch' });
    for (let i = 0; i < 2; i++) assert.equal(await tx.createImportedCard({ import_key: 'key', batch_id: 'batch', payload: {} }), 'existing');
    await assert.rejects(tx.createImportedCard({ import_key: 'key', batch_id: 'other', payload: {} }), /FORBIDDEN/);
  });
  assert.equal(f.tasks.size, 1);
});

function rollbackFixture() {
  const f = fixture();
  const state = emptyTransferState();
  const payload = importPlan().cards[0];
  const task = { id: 'owned', importKey: 'key', createdById: 'admin', title: 'Synthetic', version: 0, activities: [{ userId: 'admin', action: 'created' }] };
  state.cards.key = {
    batch_id: 'batch', payload, fingerprint: digest(payload), target_id: task.id,
    prisma_receipt: { batch_id: 'batch', actor_id: 'admin', task_id: task.id, fingerprint: digest(task) },
  };
  state.batches.batch = { status: 'applied', created: ['key'], reused: [] };
  f.tasks.set('key', task);
  f.tasks.set('foreign', { id: 'foreign', importKey: 'foreign', createdById: 'other' });
  f.setState(state);
  return { ...f, state, task };
}

test('rollback removes only the unchanged card owned by its batch and leaves foreign cards', async () => {
  const f = rollbackFixture();
  const result = await executeRollback({ batch_id: 'batch', enabled: true, adapter: f.adapter });
  assert.equal(result.removed, 1);
  assert.deepEqual(f.deleted, ['key']);
  assert.ok(f.tasks.has('foreign'));
});

for (const mutation of ['task', 'child', 'batch', 'creator', 'target', 'missing_receipt']) {
  test(`rollback refuses ${mutation} changes`, async () => {
    const f = rollbackFixture();
    if (mutation === 'task') f.task.title = 'Edited';
    if (mutation === 'child') f.task.activities.push({ userId: 'other', action: 'commented' });
    if (mutation === 'creator') f.task.createdById = 'other';
    if (mutation === 'target') f.task.id = 'substituted';
    if (mutation === 'batch') f.state.cards.key.prisma_receipt.batch_id = 'other';
    if (mutation === 'missing_receipt') delete f.state.cards.key.prisma_receipt;
    await assert.rejects(executeRollback({ batch_id: 'batch', enabled: true, adapter: f.adapter }), /IMPORTED_CARD_CHANGED/);
    assert.deepEqual(f.deleted, []);
    assert.ok(f.tasks.has('key'));
  });
}

test('applied executor replay uses persisted IDs and never creates cards', async () => {
  const f = fixture(), plan = importPlan(), payload = plan.cards[0];
  const state = emptyTransferState();
  state.cards[payload.card_key] = { batch_id: 'batch', payload, fingerprint: digest(payload), target_id: 'existing' };
  state.batches.batch = { status: 'applied', plan_sha256: plan.plan_sha256, created: [payload.card_key], reused: [] };
  f.setState(state);
  f.tx.task.findUnique = () => { assert.fail('replay must not create'); };
  assert.equal((await executeTransfer({ plan, approval: plan.plan_sha256, batch_id: 'batch', enabled: true, adapter: f.adapter })).status, 'already_applied');
});

test('CLI argument and IO failures return only fixed codes, never raw input', async () => {
  assert.deepEqual(await runImportCli([]), { code: 'CLI_ARGUMENTS_REQUIRED' });
  assert.deepEqual(await runImportCli(['secret-filename', '--approve', 'a'.repeat(64), '--actor', 'private-user', '--batch', 'batch']), { code: 'IMPORT_FAILED' });
});
