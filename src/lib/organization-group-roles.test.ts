import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const events = vi.hoisted(() => ({ revoked: vi.fn() }));
vi.mock('@/socket/board-events', () => ({ emitAuthRevoked: events.revoked }));
import { createOrganizationService } from './organization';
import { createOrganizationReader, safeOrganizationHistory } from './organization-reader';
import { decodeOrganizationResult, groupPrivilegeAssignmentId, organizationResultTarget, privilegeAssignmentId } from './organization-command';
import { ORGANIZATION_PRIVILEGE_PERMISSIONS, type OrganizationGroupPrivilegeAssignment } from './organization-contract';
import type { OrganizationOperation } from '@prisma/client';

const meta = (expectedVersion = 0) => ({ actorId: 'admin', operationId: randomUUID(), expectedVersion });
const assignment = () => ({ ...meta(), groupId: 'group', profileId: 'executor', scopeKind: 'department' as const,
  departmentId: 'dept', projectId: null, assigned: true });
type Row = Omit<OrganizationGroupPrivilegeAssignment, 'assigned'>;
function fixture() {
  const users = new Map(['admin', 'person'].map(id => [id, { id, name: id, globalRole: id === 'admin' ? 'ADMIN' : 'USER', primaryDepartment: { id: 'dept', archivedAt: null } }]));
  const group = { id: 'group', name: 'Support group', archivedAt: null as Date | null };
  const department = { id: 'dept', name: 'Support', archivedAt: null as Date | null };
  const profile = { id: 'executor', name: 'Executor', permissions: ['request.execute'] as unknown, archivedAt: null as Date | null };
  const rows = new Map<string, Row>();
  const receipts = new Map<string, Record<string, unknown>>();
  const members = new Set(['person']);
  const state = { id: 'organization', version: 0 };
  let commitGate: Promise<void> | null = null;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null) },
    project: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === 'board' ? {
      id: 'board', name: 'Board', ownerId: 'other', departmentId: 'dept', department, members: [], responsibleGroup: null, applicantPolicyConfig: null,
    } : null), count: vi.fn().mockResolvedValue(0) },
    department: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === department.id ? department : null) },
    responsibleGroup: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === group.id ? group : null),
      update: vi.fn(async ({ data }: { data: { archivedAt: Date | null } }) => Object.assign(group, data)),
    },
    responsibleGroupMember: {
      findMany: vi.fn(async () => [...members].map(userId => ({ userId }))),
      findUnique: vi.fn(async ({ where }: { where: { groupId_userId: { userId: string } } }) => members.has(where.groupId_userId.userId) ? { userId: where.groupId_userId.userId } : null),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => ({ count: members.delete(where.userId) ? 1 : 0 })),
    },
    privilegeProfile: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === profile.id ? profile : null),
      update: vi.fn(async ({ data }: { data: Partial<typeof profile> }) => Object.assign(profile, data)),
    },
    groupPrivilegeAssignment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      count: vi.fn(async () => rows.size),
      create: vi.fn(async ({ data }: { data: Row }) => { rows.set(data.id, structuredClone(data)); return data; }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({ count: rows.delete(where.id) ? 1 : 0 })),
      findMany: vi.fn(async ({ where, take }: { where: { groupId?: string; profileId?: string; id?: { gt: string }; group?: unknown }; take?: number }) => {
        if (where.group && group.archivedAt !== null) return [];
        return [...rows.values()].filter(row => (!where.groupId || row.groupId === where.groupId)
          && (!where.profileId || row.profileId === where.profileId) && (!where.id || row.id > where.id.gt))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map(row => ({ ...row, profile, department, project: null,
            group: { ...group, members: [...members].map(userId => ({ userId })) } }));
      }),
    },
    scopedPrivilegeAssignment: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    organizationState: { findUnique: vi.fn(async () => ({ ...state })), upsert: vi.fn(async () => ({ ...state })),
      update: vi.fn(async ({ data }: { data: { version: number } }) => Object.assign(state, data)) },
    organizationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { actorId_operationId: { actorId: string; operationId: string } } }) => receipts.get(where.actorId_operationId.operationId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = structuredClone({ ...data, before: data.before === Prisma.JsonNull ? null : data.before });
        receipts.set(String(data.operationId), row); return row;
      }),
    },
  };
  const transaction = vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => {
    const result = await operation(tx);
    if (commitGate) await commitGate;
    return result;
  });
  const database = { $transaction: transaction } as unknown as Parameters<typeof createOrganizationService>[0];
  return { service: createOrganizationService(database), reader: createOrganizationReader(database), tx, transaction,
    users, group, department, profile, rows, receipts, members, state, waitForCommit: (value: Promise<void>) => { commitGate = value; } };
}
beforeEach(() => events.revoked.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('group role command protocol (mock DB; no real SQL)', () => {
  it.each([['organization', null, null], ['department', 'dept', null], ['board', null, 'board']] as const)(
    'domain separates canonical %s identity and rejects forged receipts', (scopeKind, departmentId, projectId) => {
      const id = groupPrivilegeAssignmentId('group', 'executor', scopeKind, departmentId, projectId);
      expect(id).toBe(createHash('sha256').update(JSON.stringify(['group', 'group', 'executor', scopeKind, departmentId, projectId])).digest('hex'));
      expect(id).not.toBe(privilegeAssignmentId('group', 'executor', scopeKind, departmentId, projectId));
      const result = { id, groupId: 'group', profileId: 'executor', scopeKind, departmentId, projectId, assigned: true };
      expect(decodeOrganizationResult('setGroupPrivilegeAssignment', result)).toEqual(result);
      expect(organizationResultTarget(result)).toBe(id);
      for (const corrupt of [{ ...result, id: 'forged' }, { ...result, userId: 'person' }, { ...result, assigned: 1 }]) {
        expect(() => decodeOrganizationResult('setGroupPrivilegeAssignment', corrupt)).toThrowError(expect.objectContaining({ name: 'ConflictError' }));
      }
    });
  it('exposes the closed execute/manage permissions without global role mutation', () => {
    expect(ORGANIZATION_PRIVILEGE_PERMISSIONS).toContain('request.execute');
    expect(ORGANIZATION_PRIVILEGE_PERMISSIONS).toContain('request.manage');
    expect([...ORGANIZATION_PRIVILEGE_PERMISSIONS].sort()).toEqual([...ORGANIZATION_PRIVILEGE_PERMISSIONS]);
  });
  it('persists one grant/receipt/version, no-ops repeats and replays after revoke without restoring the grant', async () => {
    const f = fixture(), input = assignment();
    const first = await f.service.setGroupPrivilegeAssignment(input);
    expect(first).toMatchObject({ version: 1, replayed: false, result: { groupId: 'group', assigned: true } });
    expect(f.rows.size).toBe(1); expect(f.tx.groupPrivilegeAssignment.create).toHaveBeenCalledOnce();
    const receipt = f.receipts.get(input.operationId)!;
    expect(receipt.targetKind).toBe('groupPrivilegeAssignment'); expect(receipt.targetId).toBe(first.result.id);
    expect(await f.service.setGroupPrivilegeAssignment({ ...input, ...meta(1) })).toMatchObject({ version: 1, replayed: false });
    expect(f.tx.groupPrivilegeAssignment.create).toHaveBeenCalledOnce();
    await f.service.setGroupPrivilegeAssignment({ ...input, ...meta(1), assigned: false });
    expect(f.rows.size).toBe(0);
    expect(await f.service.setGroupPrivilegeAssignment(input)).toEqual({ ...first, replayed: true });
    expect(f.rows.size).toBe(0); expect(events.revoked).toHaveBeenCalledExactlyOnceWith('person', 'organization-privileges-changed');
    f.users.get('admin')!.globalRole = 'USER';
    await expect(f.service.setGroupPrivilegeAssignment(input)).rejects.toMatchObject({ name: 'ForbiddenError' });
  });
  it('rejects stale version, operation reuse and invalid scope before another write', async () => {
    const f = fixture(), input = assignment(); await f.service.setGroupPrivilegeAssignment(input);
    await expect(f.service.setGroupPrivilegeAssignment({ ...input, assigned: false })).rejects.toMatchObject({ name: 'ConflictError' });
    await expect(f.service.setGroupPrivilegeAssignment({ ...input, ...meta(0), assigned: false })).rejects.toMatchObject({ name: 'ConflictError' });
    expect(() => f.service.setGroupPrivilegeAssignment({ ...input, scopeKind: 'organization' })).toThrowError(expect.objectContaining({ name: 'ValidationError' }));
    expect(f.tx.groupPrivilegeAssignment.deleteMany).not.toHaveBeenCalled();
  });
  it.each(['group', 'profile', 'department'] as const)('refuses archived %s on assignment but permits revoke', async kind => {
    const f = fixture(), input = assignment(); await f.service.setGroupPrivilegeAssignment(input);
    f[kind].archivedAt = new Date();
    await expect(f.service.setGroupPrivilegeAssignment({ ...input, ...meta(1) })).rejects.toMatchObject({ name: 'ConflictError' });
    expect((await f.service.setGroupPrivilegeAssignment({ ...input, ...meta(1), assigned: false })).result.assigned).toBe(false);
  });
  it('rejects corrupt saved grants, missing targets, noncanonical permissions and OWN outside board', async () => {
    const f = fixture(), input = assignment();
    await expect(f.service.setGroupPrivilegeAssignment({ ...input, groupId: 'missing' })).rejects.toMatchObject({ name: 'NotFoundError' });
    f.profile.permissions = ['request.execute', 'request.execute'];
    await expect(f.service.setGroupPrivilegeAssignment(input)).rejects.toMatchObject({ name: 'ConflictError' });
    f.profile.permissions = { permissions: ['request.execute'], visibility: 'own' };
    await expect(f.service.setGroupPrivilegeAssignment(input)).rejects.toMatchObject({ name: 'ValidationError' });
    f.profile.permissions = ['request.execute'];
    await f.service.setGroupPrivilegeAssignment(input);
    f.rows.get([...f.rows.keys()][0])!.scopeKind = 'board';
    await expect(f.service.setGroupPrivilegeAssignment({ ...input, ...meta(1), assigned: false })).rejects.toMatchObject({ name: 'ConflictError' });
  });
  it('bounds grants at100 without blocking a no-op/revoke', async () => {
    const f = fixture(), input = assignment(); f.tx.groupPrivilegeAssignment.count.mockResolvedValue(100);
    await expect(f.service.setGroupPrivilegeAssignment(input)).rejects.toMatchObject({ name: 'ConflictError' });
    f.tx.groupPrivilegeAssignment.count.mockResolvedValue(99); await f.service.setGroupPrivilegeAssignment(input);
    f.tx.groupPrivilegeAssignment.count.mockResolvedValue(100);
    expect((await f.service.setGroupPrivilegeAssignment({ ...input, ...meta(1) })).version).toBe(1);
    await f.service.setGroupPrivilegeAssignment({ ...input, ...meta(1), assigned: false }); expect(f.rows.size).toBe(0);
  });
  it('locks Project before actor for a board-scoped grant', async () => {
    const f = fixture(); await f.service.setGroupPrivilegeAssignment({ ...assignment(), scopeKind: 'board', departmentId: null, projectId: 'board' });
    const locks = f.tx.$queryRaw.mock.calls.map(call => String(call[0]));
    expect(locks[0]).toContain('pg_advisory_xact_lock'); expect(locks[1]).toContain('FROM "Project"'); expect(locks[2]).toContain('FROM "User"');
  });
  it('emits group revocation only after commit, never for a failed/replayed transaction', async () => {
    const f = fixture(), input = assignment(); await f.service.setGroupPrivilegeAssignment(input);
    let release!: () => void; f.waitForCommit(new Promise<void>(resolve => { release = resolve; }));
    const revoke = { ...input, ...meta(1), assigned: false };
    const pending = f.service.setGroupPrivilegeAssignment(revoke);
    await vi.waitFor(() => expect(f.tx.groupPrivilegeAssignment.deleteMany).toHaveBeenCalledOnce());
    expect(events.revoked).not.toHaveBeenCalled(); release(); await pending;
    expect(events.revoked).toHaveBeenCalledOnce(); await f.service.setGroupPrivilegeAssignment(revoke); expect(events.revoked).toHaveBeenCalledOnce();
    const g = fixture(); await g.service.setGroupPrivilegeAssignment(assignment());
    g.tx.organizationOperation.create.mockRejectedValueOnce(new Error('Synthetic receipt failure'));
    await expect(g.service.setGroupPrivilegeAssignment({ ...assignment(), ...meta(1), assigned: false })).rejects.toThrow('Synthetic receipt failure');
    expect(events.revoked).toHaveBeenCalledOnce();
  });
  it('invalidates member removal, group archive and profile-permission revoke without granting ADMIN', async () => {
    const a = fixture(); await a.service.setGroupMember({ ...meta(), groupId: 'group', userId: 'person', member: false });
    expect(events.revoked).toHaveBeenLastCalledWith('person', 'organization-privileges-changed');
    const b = fixture(); await b.service.setGroupArchived({ ...meta(), groupId: 'group', archived: true });
    expect(events.revoked).toHaveBeenCalledTimes(2);
    const c = fixture(); await c.service.setGroupPrivilegeAssignment(assignment());
    await c.service.updatePrivilegeProfile({ ...meta(1), profileId: 'executor', name: 'Executor', permissions: [], archived: false });
    expect(events.revoked).toHaveBeenCalledTimes(3); expect(c.users.get('person')!.globalRole).toBe('USER');
  });
  it('decodes group-grant history using assignment identity rather than group identity', async () => {
    const f = fixture(), input = assignment(); await f.service.setGroupPrivilegeAssignment(input);
    const record = f.receipts.get(input.operationId)!;
    expect(safeOrganizationHistory({ ...record, id: 'history', committedAt: new Date() } as unknown as OrganizationOperation))
      .toMatchObject({ operation: 'setGroupPrivilegeAssignment', targetKind: 'groupPrivilegeAssignment', targetId: [...f.rows.keys()][0] });
  });
});

describe('group role reader (mock DB; no real SQL)', () => {
  it('paginates exact group/version, returns names without changing canonical receipts', async () => {
    const f = fixture();
    for (const profileId of ['executor', 'other', 'third']) {
      const id = groupPrivilegeAssignmentId('group', profileId, 'department', 'dept', null);
      f.rows.set(id, { id, groupId: 'group', profileId, scopeKind: 'department', departmentId: 'dept', projectId: null });
    }
    const first = await f.reader.groupPrivilegeAssignments({ actorId: 'admin', groupId: 'group', limit: 2 });
    expect(first.items).toHaveLength(2); expect(first.items[0]).toMatchObject({ profileName: 'Executor', departmentName: 'Support' });
    const last = await f.reader.groupPrivilegeAssignments({ actorId: 'admin', groupId: 'group', limit: 2, cursor: first.nextCursor! });
    expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
    expect(new Set([...first.items, ...last.items].map(row => row.id)).size).toBe(3);
    expect(() => f.reader.groupPrivilegeAssignments({ actorId: 'admin', groupId: 'other', cursor: first.nextCursor! })).toThrowError(expect.objectContaining({ name: 'ValidationError' }));
    f.state.version++;
    await expect(f.reader.groupPrivilegeAssignments({ actorId: 'admin', groupId: 'group', cursor: first.nextCursor! })).rejects.toMatchObject({ name: 'ConflictError' });
  });
  it('denies nonadmin before list facts and rejects missing groups/corrupt saved IDs', async () => {
    const f = fixture(); f.users.get('admin')!.globalRole = 'USER';
    await expect(f.reader.groupPrivilegeAssignments({ actorId: 'admin', groupId: 'group' })).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(f.tx.groupPrivilegeAssignment.findMany).not.toHaveBeenCalled();
    f.users.get('admin')!.globalRole = 'ADMIN';
    await expect(f.reader.groupPrivilegeAssignments({ actorId: 'admin', groupId: 'missing' })).rejects.toMatchObject({ name: 'NotFoundError' });
    f.rows.set('bad', { id: 'bad', groupId: 'group', profileId: 'executor', scopeKind: 'organization', departmentId: null, projectId: null });
    await expect(f.reader.groupPrivilegeAssignments({ actorId: 'admin', groupId: 'group' })).rejects.toMatchObject({ name: 'ConflictError' });
  });
  it('shows live group provenance in the common effective preview; removal drops group grant', async () => {
    const f = fixture(); await f.service.setGroupPrivilegeAssignment(assignment());
    const result = await f.reader.privilegePreview({ actorId: 'admin', userId: 'person', projectId: 'board' });
    expect(result.effective.assignmentSources).toEqual([expect.objectContaining({ source: 'group', groupId: 'group', permissions: ['request.execute'], reason: 'matching' })]);
    expect(result.effective.matrix.actions.find(row => row.action === 'request.execute')?.allowed).toBe(true);
    f.members.clear();
    const after = await f.reader.privilegePreview({ actorId: 'admin', userId: 'person', projectId: 'board' });
    expect(after.effective.assignmentSources).toEqual([]);
    expect(after.effective.matrix.actions.find(row => row.action === 'request.execute')?.allowed).toBe(false);
  });
});
