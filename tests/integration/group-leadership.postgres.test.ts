import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/socket/board-events', () => ({ emitAuthRevoked: vi.fn() }));
import { createOrganizationService } from '@/lib/organization';
import { loopbackDatabaseUrl } from './support/test-database';

const testUrl = process.env.TEST_DATABASE_URL;
// Validate before any client construction; never fall back to application URL.
if (testUrl) {
  const url = new URL(testUrl), name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !name.endsWith('_test') || /[/\\]/.test(name)) {
    throw Error('TEST_DATABASE_URL must select one PostgreSQL database ending in _test');
  }
  for (const value of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (value && new URL(value).hostname === url.hostname) throw Error('Test and application/production database hostnames must differ');
  }
}
const runId = `group-leadership-${randomUUID()}`;
const userIds = new Set<string>(), groupIds = new Set<string>();
let database: PrismaClient, inspector: PrismaClient;
type Fixture = { actorId: string; memberId: string; outsiderId: string; groupId: string };
async function fixture(tx: Prisma.TransactionClient): Promise<Fixture> {
  const suffix = randomUUID();
  const actorId = `${runId}-admin-${suffix}`, memberId = `${runId}-member-${suffix}`, outsiderId = `${runId}-other-${suffix}`;
  for (const id of [actorId, memberId, outsiderId]) {
    userIds.add(id);
    await tx.user.create({ data: { id, email: `${id}@synthetic.invalid`, name: runId, globalRole: id === actorId ? 'ADMIN' : 'USER' } });
  }
  const groupId = `${runId}-${suffix}`; groupIds.add(groupId);
  await tx.responsibleGroup.create({ data: { id: groupId, name: runId, members: { create: { userId: memberId } } } });
  return { actorId, memberId, outsiderId, groupId };
}
const version = async (tx: Pick<Prisma.TransactionClient, 'organizationState'>) =>
  (await tx.organizationState.findUnique({ where: { id: 'organization' } }))?.version ?? 0;
function service(tx: Prisma.TransactionClient) {
  // The enclosing real PostgreSQL transaction owns commit/rollback. No mocked
  // repository or SQL: all runner reads, locks, receipts and updates use tx.
  return createOrganizationService({ $transaction: (async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx)) as typeof database.$transaction });
}
async function isolated(run: (tx: Prisma.TransactionClient) => Promise<void>, rollback = true) {
  const rollbackOnly = new Error('Rollback this run-owned fixture transaction');
  try {
    await database.$transaction(async tx => {
      // Serialize metadata and commands against existing organization writers;
      // never restore/delete their shared singleton or their receipts.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-topology-v1'}, 0))::text AS locked`;
      await run(tx);
      if (rollback) throw rollbackOnly;
    }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 20_000 });
  } catch (error) { if (error !== rollbackOnly) throw error; }
}

(testUrl ? describe : describe.skip)('PostgreSQL explicit responsible-group leadership', () => {
  beforeAll(() => {
    database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testUrl!) });
    inspector = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testUrl!) });
  });
  afterAll(async () => {
    if (!database) return;
    try {
      await database.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-topology-v1'}, 0))::text AS locked`;
        await tx.organizationOperation.deleteMany({ where: { actorId: { in: [...userIds] }, operation: 'setGroupLeader', targetId: { in: [...groupIds] } } });
        await tx.responsibleGroup.deleteMany({ where: { id: { in: [...groupIds] }, name: runId } });
        await tx.user.deleteMany({ where: { id: { in: [...userIds] }, email: { endsWith: '@synthetic.invalid' }, name: runId } });
      });
      expect(await database.responsibleGroup.count({ where: { id: { in: [...groupIds] } } })).toBe(0);
      expect(await database.user.count({ where: { id: { in: [...userIds] } } })).toBe(0);
      expect(await database.organizationOperation.count({ where: { actorId: { in: [...userIds] } } })).toBe(0);
    } finally { await Promise.allSettled([database.$disconnect(), inspector.$disconnect()]); }
  });

  it('commits leader, version and durable receipt once; exact replay and operation reuse do not rewrite', async () => {
    let f!: Fixture, expectedVersion = 0;
    const operationId = randomUUID();
    await isolated(async tx => {
      f = await fixture(tx); expectedVersion = await version(tx);
      expect(await service(tx).setGroupLeader({ ...f, userId: f.memberId, operationId, expectedVersion })).toEqual({
        result: { id: f.groupId, leaderId: f.memberId }, version: expectedVersion + 1, replayed: false,
      });
    }, false);
    // Independent actual client confirms data after COMMIT, not just in-memory
    // projections or an uncommitted transaction's own view.
    expect(await inspector.responsibleGroup.findUnique({ where: { id: f.groupId }, select: { leaderId: true } })).toEqual({ leaderId: f.memberId });
    const [committedTuple] = await inspector.$queryRaw<{ revision: string }[]>`SELECT xmin::text AS revision FROM "ResponsibleGroup" WHERE "id" = ${f.groupId}`;
    const receipt = await inspector.organizationOperation.findUniqueOrThrow({ where: { actorId_operationId: { actorId: f.actorId, operationId } } });
    expect(receipt).toMatchObject({ operation: 'setGroupLeader', targetKind: 'group', targetId: f.groupId,
      committedVersion: expectedVersion + 1, changed: true, before: { id: f.groupId, leaderId: null }, after: { id: f.groupId, leaderId: f.memberId } });
    await isolated(async tx => {
      const before = await version(tx);
      expect(await service(tx).setGroupLeader({ ...f, userId: f.memberId, operationId, expectedVersion })).toMatchObject({ version: expectedVersion + 1, replayed: true });
      await expect(service(tx).setGroupLeader({ ...f, userId: null, operationId, expectedVersion })).rejects.toMatchObject({ name: 'ConflictError' });
      expect(await version(tx)).toBe(before);
      expect(await tx.organizationOperation.count({ where: { actorId: f.actorId } })).toBe(1);
      const [replayedTuple] = await tx.$queryRaw<{ revision: string }[]>`SELECT xmin::text AS revision FROM "ResponsibleGroup" WHERE "id" = ${f.groupId}`;
      expect(replayedTuple.revision).toBe(committedTuple.revision);
    });
  });

  it.each(['nonmember', 'blocked', 'blockedAt'])('rejects %s without audit or version advancement', async kind => {
    await isolated(async tx => {
      const f = await fixture(tx), expectedVersion = await version(tx);
      if (kind !== 'nonmember') await tx.user.update({ where: { id: f.memberId }, data: kind === 'blocked' ? { isBlocked: true } : { blockedAt: new Date() } });
      await expect(service(tx).setGroupLeader({ ...f, userId: kind === 'nonmember' ? f.outsiderId : f.memberId, operationId: randomUUID(), expectedVersion })).rejects.toMatchObject({ name: 'ConflictError' });
      expect(await version(tx)).toBe(expectedVersion);
      expect(await tx.organizationOperation.count({ where: { actorId: f.actorId } })).toBe(0);
      expect((await tx.responsibleGroup.findUniqueOrThrow({ where: { id: f.groupId } })).leaderId).toBeNull();
    });
  });

  it('rechecks a revoked ADMIN before returning a historical replay', async () => {
    await isolated(async tx => {
      const f = await fixture(tx), expectedVersion = await version(tx), operationId = randomUUID();
      await service(tx).setGroupLeader({ ...f, userId: f.memberId, operationId, expectedVersion });
      await tx.user.update({ where: { id: f.actorId }, data: { globalRole: 'USER' } });
      await expect(service(tx).setGroupLeader({ ...f, userId: f.memberId, operationId, expectedVersion })).rejects.toMatchObject({ name: 'ForbiddenError' });
      expect(await version(tx)).toBe(expectedVersion + 1);
      expect(await tx.organizationOperation.count({ where: { actorId: f.actorId } })).toBe(1);
    });
  });

  it('clears an archived leader while rejecting reacquisition after membership removal', async () => {
    await isolated(async tx => {
      const f = await fixture(tx), expectedVersion = await version(tx);
      await service(tx).setGroupLeader({ ...f, userId: f.memberId, operationId: randomUUID(), expectedVersion });
      await tx.responsibleGroupMember.deleteMany({ where: { groupId: f.groupId, userId: f.memberId } });
      await expect(service(tx).setGroupLeader({ ...f, userId: f.memberId, operationId: randomUUID(), expectedVersion: expectedVersion + 1 })).rejects.toMatchObject({ name: 'ConflictError' });
      expect(await version(tx)).toBe(expectedVersion + 1);
      await tx.responsibleGroup.update({ where: { id: f.groupId }, data: { archivedAt: new Date() } });
      expect(await service(tx).setGroupLeader({ ...f, userId: null, operationId: randomUUID(), expectedVersion: expectedVersion + 1 })).toMatchObject({ result: { id: f.groupId, leaderId: null }, version: expectedVersion + 2 });
      expect(await tx.organizationOperation.count({ where: { actorId: f.actorId } })).toBe(2);
    });
  });
});
