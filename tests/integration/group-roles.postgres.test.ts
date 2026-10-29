import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// Only external event transport and the application's default singleton are
// mocked. Every repository read, constraint and lock below uses real PostgreSQL.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/socket/board-events', () => ({ emitAuthRevoked: vi.fn() }));
import { createOrganizationService } from '@/lib/organization';
import { groupPrivilegeAssignmentId, privilegeAssignmentId } from '@/lib/organization-command';
import { hasRolePermission, loadRoleGrants } from '@/lib/role-grants';
import { getProjectRequestExecutionPolicy } from '@/lib/project-request-execution-policy';
import { loopbackDatabaseUrl } from './support/test-database';

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(loopbackDatabaseUrl(testUrl));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.port !== '3887' || url.pathname !== '/lenkanban_rbac_20261028_test'
    || (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) {
    throw new Error('Group role acceptance requires its explicitly approved isolated PostgreSQL database');
  }
  for (const value of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (!value) continue;
    const other = new URL(loopbackDatabaseUrl(value));
    if (other.hostname === url.hostname && other.port === url.port && other.pathname === url.pathname) {
      throw new Error('Group role acceptance database must differ from the application database');
    }
  }
}

const runId = `group-roles-${randomUUID()}`;
const userIds = new Set<string>(), groupIds = new Set<string>(), departmentIds = new Set<string>();
const projectIds = new Set<string>(), profileIds = new Set<string>();
let db: PrismaClient, observer: PrismaClient;
type Fixture = { actorId: string; memberId: string; outsiderId: string; groupId: string;
  departmentId: string; otherDepartmentId: string; projectId: string; profileId: string; readProfileId: string };
const version = async (tx: Pick<Prisma.TransactionClient, 'organizationState'>) =>
  (await tx.organizationState.findUnique({ where: { id: 'organization' } }))?.version ?? 0;
function service(tx: Prisma.TransactionClient) {
  // Nested command callbacks share this real enclosing transaction. This is a
  // transaction adapter, not a mocked repository; transport effects are mocked.
  return createOrganizationService({ $transaction: (async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx)) as typeof db.$transaction });
}
async function organizationTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-topology-v1'}, 0))::text AS locked`;
    return run(tx);
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 10_000 });
}
async function fixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const id = (kind: string) => `${runId}-${kind}-${suffix}`;
  const f = { actorId: id('admin'), memberId: id('member'), outsiderId: id('outsider'), groupId: id('group'),
    departmentId: id('dept'), otherDepartmentId: id('otherdept'), projectId: id('board'), profileId: id('execute'), readProfileId: id('read') };
  for (const value of [f.actorId, f.memberId, f.outsiderId]) userIds.add(value);
  for (const value of [f.departmentId, f.otherDepartmentId]) departmentIds.add(value);
  for (const value of [f.profileId, f.readProfileId]) profileIds.add(value);
  groupIds.add(f.groupId); projectIds.add(f.projectId);
  await organizationTransaction(async tx => {
    await tx.department.createMany({ data: [f.departmentId, f.otherDepartmentId].map(value => ({ id: value, name: runId })) });
    for (const userId of [f.actorId, f.memberId, f.outsiderId]) await tx.user.create({ data: {
      id: userId, email: `${userId}@synthetic.invalid`, name: runId,
      globalRole: userId === f.actorId ? 'ADMIN' : 'USER',
      primaryDepartmentId: userId === f.memberId ? f.departmentId : f.otherDepartmentId,
    } });
    await tx.responsibleGroup.create({ data: { id: f.groupId, name: runId,
      members: { create: [{ userId: f.memberId }, { userId: f.outsiderId }] } } });
    await tx.project.create({ data: { id: f.projectId, name: runId, ownerId: f.actorId, departmentId: f.departmentId, responsibleGroupId: f.groupId } });
    await tx.privilegeProfile.createMany({ data: [
      { id: f.profileId, name: runId, permissions: ['request.execute'] },
      { id: f.readProfileId, name: runId, permissions: ['request.read'] },
    ] });
  });
  return f;
}
async function groupGrant(f: Fixture, assigned = true) {
  return organizationTransaction(async tx => service(tx).setGroupPrivilegeAssignment({ actorId: f.actorId,
    groupId: f.groupId, profileId: f.profileId, scopeKind: 'department', departmentId: f.departmentId, projectId: null,
    assigned, operationId: randomUUID(), expectedVersion: await version(tx) }));
}
async function personalGrant(f: Fixture, profileId = f.profileId) {
  return organizationTransaction(async tx => service(tx).setPrivilegeAssignment({ actorId: f.actorId,
    userId: f.memberId, profileId, scopeKind: 'department', departmentId: f.departmentId, projectId: null,
    assigned: true, operationId: randomUUID(), expectedVersion: await version(tx) }));
}
const scope = (f: Fixture) => ({ projectId: f.projectId, activeDepartmentId: f.departmentId });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

(testUrl ? describe : describe.skip)('PostgreSQL group and personal role acceptance', () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testUrl!) });
    observer = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testUrl!) });
    // Detect a missing/unapplied exact schema as setup failure, never a skip.
    const rows = await db.$queryRaw<{ table: string | null; db: string }[]>`
      SELECT to_regclass('public."GroupPrivilegeAssignment"')::text AS "table", current_database() AS db`;
    expect(rows).toEqual([{ table: '"GroupPrivilegeAssignment"', db: 'lenkanban_rbac_20261028_test' }]);
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await organizationTransaction(async tx => {
        await tx.organizationOperation.deleteMany({ where: { actorId: { in: [...userIds] } } });
        await tx.groupPrivilegeAssignment.deleteMany({ where: { groupId: { in: [...groupIds] } } });
        await tx.scopedPrivilegeAssignment.deleteMany({ where: { userId: { in: [...userIds] } } });
        await tx.project.deleteMany({ where: { id: { in: [...projectIds] }, name: runId } });
        await tx.responsibleGroup.deleteMany({ where: { id: { in: [...groupIds] }, name: runId } });
        await tx.privilegeProfile.deleteMany({ where: { id: { in: [...profileIds] }, name: runId } });
        await tx.user.deleteMany({ where: { id: { in: [...userIds] }, email: { endsWith: '@synthetic.invalid' }, name: runId } });
        await tx.department.deleteMany({ where: { id: { in: [...departmentIds] }, name: runId } });
      });
      expect(await db.user.count({ where: { id: { in: [...userIds] } } })).toBe(0);
      expect(await db.groupPrivilegeAssignment.count({ where: { groupId: { in: [...groupIds] } } })).toBe(0);
      expect(await db.organizationOperation.count({ where: { actorId: { in: [...userIds] } } })).toBe(0);
    } finally { await Promise.allSettled([db.$disconnect(), observer?.$disconnect()]); }
  });

  it('SQL accepts the natural deterministic identity in all three scopes and enforces CHECK/FK independently of service', async () => {
    const f = await fixture();
    const fields = (scopeKind: string, departmentId: string | null, projectId: string | null) => ({ groupId: f.groupId,
      profileId: f.profileId, scopeKind, departmentId, projectId });
    for (const [scopeKind, departmentId, projectId] of [
      ['organization', null, null], ['department', f.departmentId, null], ['board', null, f.projectId],
    ] as const) {
      const id = groupPrivilegeAssignmentId(f.groupId, f.profileId, scopeKind, departmentId, projectId);
      await db.groupPrivilegeAssignment.create({ data: { id, ...fields(scopeKind, departmentId, projectId) } });
      expect((await observer.groupPrivilegeAssignment.findUniqueOrThrow({ where: { id } })).id).toBe(id);
    }
    const valid = fields('organization', null, null);
    // Prisma 6 exposes PostgreSQL CHECK failures as UnknownRequestError for
    // this path. Require the actual server constraint, not a wrapper P-code.
    await expect(db.groupPrivilegeAssignment.create({ data: { id: 'f'.repeat(64), ...valid } }))
      .rejects.toThrow(/GroupPrivilegeAssignment_identity_check/);
    const wrongShape = fields('department', null, null);
    // A correct identity for an invalid shape isolates the scope CHECK from
    // the separate natural-identity CHECK.
    const wrongShapeId = createHash('sha256').update(JSON.stringify(['group', f.groupId, f.profileId, 'department', null, null])).digest('hex');
    await expect(db.groupPrivilegeAssignment.create({ data: { id: wrongShapeId, ...wrongShape } }))
      .rejects.toThrow(/GroupPrivilegeAssignment_scope_shape_check/);
    const missingProfileId = `${runId}-missing`;
    await expect(db.groupPrivilegeAssignment.create({ data: { ...valid, profileId: missingProfileId,
      id: groupPrivilegeAssignmentId(f.groupId, missingProfileId, 'organization', null, null) } })).rejects.toMatchObject({ code: 'P2003' });
    const missingGroupId = `${runId}-missinggroup`;
    await expect(db.groupPrivilegeAssignment.create({ data: { ...valid, groupId: missingGroupId,
      id: groupPrivilegeAssignmentId(missingGroupId, f.profileId, 'organization', null, null) } })).rejects.toMatchObject({ code: 'P2003' });
    const missingDepartmentId = `${runId}-missingdept`;
    await expect(db.groupPrivilegeAssignment.create({ data: { ...valid, scopeKind: 'department', departmentId: missingDepartmentId,
      id: groupPrivilegeAssignmentId(f.groupId, f.profileId, 'department', missingDepartmentId, null) } })).rejects.toMatchObject({ code: 'P2003' });
    const missingProjectId = `${runId}-missingproject`;
    await expect(db.groupPrivilegeAssignment.create({ data: { ...valid, scopeKind: 'board', projectId: missingProjectId,
      id: groupPrivilegeAssignmentId(f.groupId, f.profileId, 'board', null, missingProjectId) } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await db.groupPrivilegeAssignment.count({ where: { groupId: f.groupId } })).toBe(3);
  });

  it('combines personal/group permissions by OR and retains personal grants after group revoke/member removal', async () => {
    const f = await fixture(); await groupGrant(f); await personalGrant(f, f.readProfileId);
    let grants = await loadRoleGrants(observer, [f.memberId]);
    expect(grants.map(row => row.source).sort()).toEqual(['group', 'personal']);
    expect(hasRolePermission(grants, f.memberId, 'request.execute', scope(f))).toBe(true);
    expect(hasRolePermission(grants, f.memberId, 'request.read', scope(f))).toBe(true);
    await groupGrant(f, false);
    grants = await loadRoleGrants(observer, [f.memberId]);
    expect(hasRolePermission(grants, f.memberId, 'request.execute', scope(f))).toBe(false);
    expect(hasRolePermission(grants, f.memberId, 'request.read', scope(f))).toBe(true);
    await personalGrant(f); await groupGrant(f);
    await organizationTransaction(async tx => service(tx).setGroupMember({ actorId: f.actorId, groupId: f.groupId,
      userId: f.memberId, member: false, operationId: randomUUID(), expectedVersion: await version(tx) }));
    grants = await loadRoleGrants(observer, [f.memberId]);
    expect(grants.every(row => row.source === 'personal')).toBe(true);
    expect(hasRolePermission(grants, f.memberId, 'request.execute', scope(f))).toBe(true);
    expect(await observer.user.findUniqueOrThrow({ where: { id: f.memberId }, select: { globalRole: true } })).toEqual({ globalRole: 'USER' });
  });

  it('requires active department staff AND an explicit execute role; wrong department and blocked staff cannot execute', async () => {
    const f = await fixture();
    expect(await getProjectRequestExecutionPolicy(f.memberId, f.projectId, observer)).toEqual({ canExecute: false });
    await groupGrant(f);
    expect(await getProjectRequestExecutionPolicy(f.memberId, f.projectId, observer)).toEqual({ canExecute: true });
    // Both users are in the same granting group: department still wins.
    expect(hasRolePermission(await loadRoleGrants(observer, [f.outsiderId]), f.outsiderId, 'request.execute', scope(f))).toBe(true);
    expect(await getProjectRequestExecutionPolicy(f.outsiderId, f.projectId, observer)).toEqual({ canExecute: false });
    await db.user.update({ where: { id: f.memberId }, data: { isBlocked: true } });
    expect(await getProjectRequestExecutionPolicy(f.memberId, f.projectId, observer)).toEqual({ canExecute: false });
    await db.user.update({ where: { id: f.memberId }, data: { isBlocked: false, blockedAt: new Date() } });
    expect(await getProjectRequestExecutionPolicy(f.memberId, f.projectId, observer)).toEqual({ canExecute: false });
  });

  it('commits one durable grant/version/receipt; exact replay and no-op never rewrite the row, stale intent conflicts', async () => {
    const f = await fixture();
    let expectedVersion = 0; const operationId = randomUUID();
    const command = { actorId: f.actorId, groupId: f.groupId, profileId: f.profileId, scopeKind: 'department' as const,
      departmentId: f.departmentId, projectId: null, assigned: true, operationId };
    const first = await organizationTransaction(async tx => {
      expectedVersion = await version(tx);
      return service(tx).setGroupPrivilegeAssignment({ ...command, expectedVersion });
    });
    const id = groupPrivilegeAssignmentId(f.groupId, f.profileId, 'department', f.departmentId, null);
    const before = await observer.$queryRaw<{ revision: string }[]>`SELECT xmin::text AS revision FROM "GroupPrivilegeAssignment" WHERE id = ${id}`;
    expect(first).toMatchObject({ result: { id, assigned: true }, version: expectedVersion + 1, replayed: false });
    expect(await observer.organizationOperation.findUniqueOrThrow({ where: { actorId_operationId: { actorId: f.actorId, operationId } } }))
      .toMatchObject({ targetKind: 'groupPrivilegeAssignment', targetId: id, changed: true, committedVersion: expectedVersion + 1 });
    await organizationTransaction(async tx => {
      expect(await service(tx).setGroupPrivilegeAssignment({ ...command, expectedVersion })).toEqual({ ...first, replayed: true });
      expect(await service(tx).setGroupPrivilegeAssignment({ ...command, operationId: randomUUID(), expectedVersion: await version(tx) }))
        .toMatchObject({ version: expectedVersion + 1, replayed: false });
      await expect(service(tx).setGroupPrivilegeAssignment({ ...command, assigned: false, expectedVersion })).rejects.toMatchObject({ name: 'ConflictError' });
      await expect(service(tx).setGroupPrivilegeAssignment({ ...command, operationId: randomUUID(), assigned: false, expectedVersion })).rejects.toMatchObject({ name: 'ConflictError' });
    });
    expect(await observer.$queryRaw`SELECT xmin::text AS revision FROM "GroupPrivilegeAssignment" WHERE id = ${id}`).toEqual(before);
    await groupGrant(f, false);
    await organizationTransaction(async tx => {
      expect(await service(tx).setGroupPrivilegeAssignment({ ...command, expectedVersion })).toMatchObject({ replayed: true });
      expect(await tx.groupPrivilegeAssignment.findUnique({ where: { id } })).toBeNull();
    });
    expect(await observer.scopedPrivilegeAssignment.count({ where: { userId: f.memberId } })).toBe(0);
    expect(privilegeAssignmentId(f.memberId, f.profileId, 'department', f.departmentId, null)).not.toBe(id);
  });

  it('real authority row locks hold a concurrent revoke until the first transaction commits, then fresh reads deny', async () => {
    const f = await fixture(); await groupGrant(f);
    const held = deferred<number>(), release = deferred<void>(), writerStarted = deferred<number>();
    let writerFinished = false;
    const holder = db.$transaction(async tx => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const grants = await loadRoleGrants(tx, [f.memberId], { lock: true });
      expect(hasRolePermission(grants, f.memberId, 'request.execute', scope(f))).toBe(true);
      held.resolve(pid);
      await release.promise;
      expect(hasRolePermission(await loadRoleGrants(tx, [f.memberId]), f.memberId, 'request.execute', scope(f))).toBe(true);
    }, { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 });
    let writer: Promise<unknown> | undefined;
    try {
      const holderPid = await Promise.race([held.promise, holder.then(() => { throw new Error('Holder ended before publishing its lock'); })]);
      writer = organizationTransaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '8s'`;
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        writerStarted.resolve(pid);
        return service(tx).setGroupPrivilegeAssignment({ actorId: f.actorId, groupId: f.groupId, profileId: f.profileId,
          scopeKind: 'department', departmentId: f.departmentId, projectId: null, assigned: false,
          operationId: randomUUID(), expectedVersion: await version(tx) });
      }).then(result => { writerFinished = true; return result; });
      const writerPid = await Promise.race([writerStarted.promise, writer.then(() => { throw new Error('Writer ended before publishing its PID'); })]);
      await vi.waitFor(async () => {
        const [{ blockers }] = await observer.$queryRaw<{ blockers: number[] }[]>`SELECT pg_blocking_pids(${writerPid}::int) AS blockers`;
        expect(blockers).toContain(holderPid);
      }, { interval: 25, timeout: 4_000 });
      expect(writerFinished).toBe(false);
      release.resolve();
      await holder; await writer;
      expect(writerFinished).toBe(true);
      expect(hasRolePermission(await loadRoleGrants(observer, [f.memberId]), f.memberId, 'request.execute', scope(f))).toBe(false);
      expect(await getProjectRequestExecutionPolicy(f.memberId, f.projectId, observer)).toEqual({ canExecute: false });
    } finally {
      release.resolve();
      await Promise.allSettled([holder, ...(writer ? [writer] : [])]);
    }
  }, 25_000);
});
