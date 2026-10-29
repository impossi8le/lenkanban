import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaTransferAdapter } from '../../scripts/mail/prisma-adapter.mjs';
import { executeTransfer, executeRollback } from '../../scripts/mail/transfer-executor.mjs';
import { importPlan } from '../mail/prisma-fixture.mjs';
import { loopbackDatabaseUrl } from './support/test-database';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl), name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !name.endsWith('_test') || /[/\\]/.test(name)) throw Error('Unsafe TEST_DATABASE_URL');
  for (const value of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (value && new URL(value).hostname === url.hostname) throw Error('Test hostname must differ from application hostname');
  }
}
const run = `mail-${randomUUID()}`;
const actorId = `${run}-admin`, outsiderId = `${run}-user`, projectId = `${run}-project`, columnId = `${run}-column`;
const batches = new Set<string>(), keys = new Set<string>();
let db: PrismaClient;

describe.skipIf(!testUrl)('real PostgreSQL mail import adapter', () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testUrl!) });
    // Only the guarded test connection receives this task's additive DDL.
    // Execute twice to exercise IF NOT EXISTS, without db push/reset/seed or
    // applying the project's unrelated migration history.
    const sql = await readFile(new URL('../../prisma/migrations/20261022210000_mail_import_adapter/migration.sql', import.meta.url), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      await db.$transaction(async tx => {
        for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
      });
    }
    await db.user.create({ data: { id: actorId, email: `${actorId}@synthetic.invalid`, globalRole: 'ADMIN' } });
    await db.user.create({ data: { id: outsiderId, email: `${outsiderId}@synthetic.invalid` } });
    await db.project.create({ data: {
      id: projectId, name: run, ownerId: actorId,
      columns: { create: { id: columnId, name: 'Synthetic queue', position: 0, color: '#123456', workflowKey: 'TODO' } },
    } });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'mail-import'}, 0))::text AS locked`;
        const row = await tx.mailImportBatch.findUnique({ where: { batchId: 'mail-import' } });
        if (row) {
          const state = row.state as { cards: Record<string, unknown>; batches: Record<string, unknown>; journal: { batch_id: string }[] };
          for (const key of keys) delete state.cards[key];
          for (const batch of batches) delete state.batches[batch];
          state.journal = state.journal.filter(entry => !batches.has(entry.batch_id));
          if (row.createdBy === actorId && !Object.keys(state.batches).length && !Object.keys(state.cards).length) {
            await tx.mailImportBatch.delete({ where: { id: row.id, createdBy: actorId } });
          } else await tx.mailImportBatch.update({ where: { id: row.id }, data: { state: state as Prisma.InputJsonValue } });
        }
        await tx.project.deleteMany({ where: { id: projectId, name: run } });
        await tx.user.deleteMany({ where: { id: { in: [actorId, outsiderId] }, email: { endsWith: '@synthetic.invalid' } } });
      });
    } finally { await db.$disconnect(); }
  });
  function input(suffix: string, author = actorId) {
    const key = `${run}-${suffix}`, batch = `${run}-${suffix}`;
    keys.add(key); batches.add(batch);
    const plan = importPlan(projectId, author, key);
    return { plan, approval: plan.plan_sha256, batch_id: batch, enabled: true, adapter: createPrismaTransferAdapter({ prisma: db, actorId }) };
  }
  it('imports actual tasks/messages/history, replays without duplication, rolls back only its own cards', async () => {
    const foreign = await db.task.create({ data: { title: 'Foreign', projectId, columnId, createdById: outsiderId, rank: '0|00000000000000000001' } });
    const args = input('normal');
    expect((await executeTransfer(args)).created).toBe(1);
    const task = await db.task.findUniqueOrThrow({ where: { importKey: args.plan.cards[0].card_key }, include: { messages: true, activities: true } });
    expect(task.createdById).toBe(actorId);
    expect(task.messages).toHaveLength(1);
    expect(task.messages[0]).toMatchObject({ contentText: 'Synthetic message', authorId: actorId });
    expect(task.activities).toHaveLength(1);
    expect((await executeTransfer(args)).status).toBe('already_applied');
    expect(await db.task.count({ where: { projectId } })).toBe(2);
    expect((await executeRollback(args)).removed).toBe(1);
    expect(await db.task.findUnique({ where: { id: foreign.id } })).not.toBeNull();
    expect((await executeRollback(args)).removed).toBe(0);
  }, 30_000);
  it('refuses non-ADMIN without persisting a task or ledger batch', async () => {
    const args = input('denied');
    args.adapter = createPrismaTransferAdapter({ prisma: db, actorId: outsiderId });
    await expect(executeTransfer(args)).rejects.toThrow('FORBIDDEN');
    expect(await db.task.count({ where: { importKey: args.plan.cards[0].card_key } })).toBe(0);
  });
  it('keeps a card edited by a different user and aborts the whole rollback', async () => {
    const args = input('changed');
    await executeTransfer(args);
    const task = await db.task.update({ where: { importKey: args.plan.cards[0].card_key }, data: { title: 'Edited', version: { increment: 1 } } });
    await db.activity.create({ data: { taskId: task.id, userId: outsiderId, action: 'title_changed' } });
    await expect(executeRollback(args)).rejects.toThrow('IMPORTED_CARD_CHANGED');
    expect(await db.task.findUnique({ where: { id: task.id } })).not.toBeNull();
  }, 30_000);
  it('detects foreign child writes even when Task.updatedAt/version were unchanged', async () => {
    const args = input('child');
    await executeTransfer(args);
    const task = await db.task.findUniqueOrThrow({ where: { importKey: args.plan.cards[0].card_key } });
    await db.chatMessage.create({ data: { taskId: task.id, authorId: outsiderId, contentText: 'Foreign comment' } });
    await expect(executeRollback(args)).rejects.toThrow('IMPORTED_CARD_CHANGED');
    expect(await db.chatMessage.count({ where: { taskId: task.id } })).toBe(2);
  }, 30_000);
  it('rolls back task creation when a later message cannot be imported', async () => {
    const args = input('atomic', `${run}-missing-author`);
    await expect(executeTransfer(args)).rejects.toThrow('INVALID_IMPORTED_AUTHOR');
    expect(await db.task.count({ where: { importKey: args.plan.cards[0].card_key } })).toBe(0);
  }, 30_000);
});
