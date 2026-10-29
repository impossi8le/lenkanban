import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
const spies = vi.hoisted(() => ({ service: vi.fn(), hash: vi.fn(), compare: vi.fn() }));
vi.mock('../src/lib/organization', () => ({ createOrganizationService: spies.service }));
vi.mock('../src/lib/logger', () => ({ logAuthEvent: vi.fn() }));
vi.mock('bcryptjs', () => ({ default: { hash: spies.hash, compare: spies.compare } }));
import { provisionPeopleRoles, peopleImportDigest } from './provision-people-roles';
const digest = peopleImportDigest;
const operation = (label: string) => { const h = digest(['test-import', label]); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
function fixture() {
  const groups = Array.from({ length: 52 }, (_, i) => ({ legacyId: String(i+1), name: ['IT отдел - Техподдержка','ОКК','ОЗОК'][i] ?? `Synthetic group ${i+1}` }));
  const users = Array.from({ length: 391 }, (_, i) => ({ id: `people-legacy-user-${i+1}`, legacyId: String(i+1), legacyIds: i < 3 ? [String(i+1), String(392+i)] : [String(i+1)], name: `Synthetic person ${i+1}`, login: `user${i+1}`, email: `user${i+1}@taskboard.lenremontn8n.ru`, groupIds: [String(i%52+1)] }));
  const plan = { sourceSha256: 'a'.repeat(64), groups, users, mergedIdentities: users.slice(0,3).map(u => ({ name: u.name, legacyIds: u.legacyIds })) };
  const old = [{ id: 'existing-admin', email: 'admin@example.invalid', name: 'Synthetic admin', passwordHash: 'unchanged-old-hash', globalRole: 'ADMIN', primaryDepartmentId: 'support', isBlocked: false, blockedAt: null, authSource: 'local', externalId: null, emailVerified: new Date(0) }];
  const rows = users.map(u => ({ id: u.id, email: u.email, name: u.name, passwordHash: 'changed-by-user-after-import', globalRole: 'USER', primaryDepartmentId: u.groupIds[0] === '1' ? 'support' : ['2','3'].includes(u.groupIds[0]) ? 'quality' : null, isBlocked: true, blockedAt: new Date(0) as Date | null, authSource: 'local', externalId: null, emailVerified: new Date(0), responsibleGroupMemberships: [{ groupId: `group-${u.groupIds[0]}` }] }));
  const profiles = [ { id: 'employee', name: 'Сотрудник', archivedAt: null, permissions: [] as string[] }, { id: 'executor', name: 'Исполнитель', archivedAt: null, permissions: ['request.execute'] } ];
  const savedGroups = groups.map(g => ({ id: `group-${g.legacyId}`, name: g.name, archivedAt: null, leaderId: null }));
  const receipts = new Map<string, object>();
  for (const profile of profiles) receipts.set(operation(`profile:${profile.id}`), { operation: 'createPrivilegeProfile', targetKind: 'profile', targetId: profile.id, expectedVersion: 0, result: { id: profile.id, name: profile.name, permissions: profile.permissions, visibility: 'board', archived: false } });
  for (const g of groups) receipts.set(operation(`group:${g.legacyId}`), { operation: 'createGroup', targetKind: 'group', targetId: `group-${g.legacyId}`, expectedVersion: 0, result: { id: `group-${g.legacyId}`, name: g.name, archived: false } });
  const state = { inside: false, onBegin: (() => {}) as () => void, old, rows, profiles, savedGroups, receipts, missingPreserved: false, extraMember: false, sql: [] as string[], activationWrites: 0, createWrites: 0 };
  function selected(row: Record<string, unknown>, select?: Record<string, unknown>) { return select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : row; }
  const raw = {
    user: {
      findUnique: async (args: { where: { id: string }; select?: Record<string, unknown> }) => { const row = [...old, ...rows].find(r => r.id === args.where.id); return row ? selected(row, args.select) : null; },
      findMany: async (args: { where: { OR?: unknown; id?: { in?: string[]; notIn?: string[] } }; select?: Record<string, unknown> }) => (args.where.OR ? rows : args.where.id?.notIn ? old : [...old, ...rows].filter(r => args.where.id?.in?.includes(r.id))).map(r => selected(r, args.select)),
      create: async () => { state.createWrites++; throw new Error('UNEXPECTED_ACCOUNT_CREATE'); },
      updateMany: async () => { state.activationWrites++; let count = 0; for (const r of rows) if (r.isBlocked || r.blockedAt !== null) { r.isBlocked = false; r.blockedAt = null; count++; } return { count }; },
    },
    department: { findUnique: async (args: { where: { id: string } }) => ({ id: args.where.id, name: args.where.id === 'support' ? 'Поддержка' : 'Отдел качества', archivedAt: null }) },
    privilegeProfile: {
      findMany: async (args: { where: { name: string } }) => state.profiles.filter(p => p.name === args.where.name),
      findUnique: async (args: { where: { id: string } }) => state.profiles.find(p => p.id === args.where.id),
    },
    responsibleGroup: {
      findMany: async (args: { where: { name: string } }) => savedGroups.filter(g => g.name === args.where.name),
      findUnique: async (args: { where: { id: string } }) => savedGroups.find(g => g.id === args.where.id),
    },
    organizationOperation: { findUnique: async (args: { where: { actorId_operationId: { operationId: string } } }) => receipts.get(args.where.actorId_operationId.operationId) ?? null },
    organizationState: { findUnique: async () => ({ version: 0 }) },
    scopedPrivilegeAssignment: { count: async () => 0, findMany: async () => state.missingPreserved ? [] : [{ userId: old[0].id, profileId: 'executor', scopeKind: 'department', departmentId: 'support', projectId: null }] },
    responsibleGroupMember: { findMany: async (args: { where: { groupId: string } }) => [...rows.filter(row => row.responsibleGroupMemberships.some(member => member.groupId === args.where.groupId)).map(row => ({ userId: row.id })), ...(state.extraMember ? [{ userId: 'unexpected-existing-person' }] : [])] },
    groupPrivilegeAssignment: { findMany: async (args: { where: { groupId: string } }) => [ { profileId: 'employee', scopeKind: 'organization', departmentId: null, projectId: null }, ...(['group-1','group-2','group-3'].includes(args.where.groupId) ? [{ profileId: 'executor', scopeKind: 'department', departmentId: args.where.groupId === 'group-1' ? 'support' : 'quality', projectId: null }] : []) ] },
  };
  function scoped(global: boolean) {
    return Object.fromEntries(Object.entries(raw).map(([key, methods]) => [key, Object.fromEntries(Object.entries(methods).map(([method, fn]) => [method, async (...args: unknown[]) => {
      if (global && state.inside) throw new Error('GLOBAL_CLIENT_INSIDE_TRANSACTION');
      return (fn as (...args: unknown[]) => Promise<unknown>)(...args);
    }]))]));
  }
  const tx = { ...scoped(false), $queryRaw: async (parts: TemplateStringsArray) => { state.sql.push(parts.join('?')); return []; } };
  const database = { ...scoped(true), $transaction: async (run: (tx: object) => Promise<unknown>) => { state.inside = true; state.onBegin(); try { return await run(tx); } finally { state.inside = false; } } };
  spies.hash.mockReset(); spies.compare.mockReset(); spies.service.mockReset();
  spies.service.mockImplementation((guarded: { $transaction: (run: () => Promise<object>) => Promise<object> }) => {
    const result = (value: object) => guarded.$transaction(async () => ({ result: value }));
    return { createPrivilegeProfile: async (input: { name: string }) => result({ id: profiles.find(p => p.name === input.name)!.id }), createGroup: async (input: { name: string }) => result({ id: savedGroups.find(g => g.name === input.name)!.id }), setGroupPrivilegeAssignment: async () => result({ id: 'grant' }), assignUserDepartment: async () => result({ id: 'person' }), setGroupMember: async () => result({ groupId: 'group' }), setPrivilegeAssignment: async () => result({ id: 'grant' }) };
  });
  return { state, input: { phase: 'activate' as 'activate' | 'apply' | 'dry-run' | 'preserve', actorId: old[0].id, importId: 'test-import', plan, manifestSha256: digest(plan), expectedExistingDigest: digest(old), departmentIds: { support: 'support', quality: 'quality' } }, database: database as unknown as PrismaClient };
}

describe('administrative people import guarded activation', () => {
  it('activates only after transaction-local verification and is replay-safe', async () => {
    const f = fixture();
    expect(await provisionPeopleRoles(f.database, f.input)).toMatchObject({ passed: true, activatedCount: 391, createdCount: 0 });
    expect(f.state.sql[0]).toContain('pg_advisory_xact_lock');
    expect(f.state.sql[2]).toContain('FOR UPDATE');
    expect(await provisionPeopleRoles(f.database, f.input)).toMatchObject({ activatedCount: 0 });
    expect(f.state.rows[0].passwordHash).toBe('changed-by-user-after-import');
  });
  it.each(['profile', 'admin', 'staff-grant', 'fingerprint', 'membership'] as const)('denies %s drift occurring after outside preflight, before any activation write', async drift => {
    const f = fixture(); f.state.onBegin = () => {
      if (drift === 'profile') f.state.profiles[1].permissions = ['request.manage'];
      if (drift === 'admin') f.state.old[0].isBlocked = true;
      if (drift === 'staff-grant') f.state.missingPreserved = true;
      if (drift === 'membership') f.state.extraMember = true;
      if (drift === 'fingerprint') f.state.old[0].passwordHash = 'different';
    };
    await expect(provisionPeopleRoles(f.database, f.input)).rejects.toThrow(drift === 'profile' ? 'PROFILE_PERMISSION_DRIFT' : drift === 'admin' ? 'ACTIVE_EXISTING_ADMIN_REQUIRED' : drift === 'staff-grant' ? 'EXISTING_EXECUTION_GRANT_MISSING' : drift === 'membership' ? 'GROUP_MEMBERSHIP_DRIFT' : 'EXISTING_ACCOUNT_PRESERVATION_FAILED');
    expect(f.state.activationWrites).toBe(0);
  });
  it('rerunning apply preserves activated accounts and changed passwords without requiring the initial password', async () => {
    const f = fixture(); for (const row of f.state.rows) { row.isBlocked = false; row.blockedAt = null; }
    f.input.phase = 'apply';
    expect(await provisionPeopleRoles(f.database, f.input)).toMatchObject({ passed: true, createdCount: 0, activatedCount: 0 });
    expect(f.state.rows.every(row => row.isBlocked === false && row.passwordHash === 'changed-by-user-after-import')).toBe(true);
    expect(f.state.createWrites).toBe(0); expect(spies.hash).not.toHaveBeenCalled(); expect(spies.compare).not.toHaveBeenCalled();
  });
  it('preserves only current active departmental execution with no password/account/group writes', async () => {
    const f = fixture(); f.input.phase = 'preserve';
    const before = JSON.stringify(f.state.old);
    expect(await provisionPeopleRoles(f.database, f.input)).toMatchObject({ passed: true, phase: 'preserve', preservedExecutors: 1, importedUsers: 0, importedGroups: 0, createdCount: 0, activatedCount: 0 });
    expect(JSON.stringify(f.state.old)).toBe(before); expect(f.state.createWrites).toBe(0); expect(f.state.activationWrites).toBe(0); expect(spies.hash).not.toHaveBeenCalled();
  });
  it('rejects unrelated identical profile names during dry-run' , async () => {
    const f = fixture(); f.input.phase = 'dry-run'; f.state.profiles.push({ ...f.state.profiles[0], id: 'unrelated' });
    await expect(provisionPeopleRoles(f.database, f.input)).rejects.toThrow('PROFILE_NAME_CONFLICT'); expect(f.state.activationWrites).toBe(0);
  });
  it('rejects unrelated identical group names during dry-run', async () => {
    const f = fixture(); f.input.phase = 'dry-run'; f.state.savedGroups.push({ ...f.state.savedGroups[0], id: 'unrelated' });
    await expect(provisionPeopleRoles(f.database, f.input)).rejects.toThrow('GROUP_NAME_CONFLICT');
  });
  it('accepts equivalent JSON key order and distinguishes changed persisted dates', async () => {
    const f = fixture(); f.input.phase = 'dry-run';
    f.input.plan.users[0] = Object.fromEntries(Object.entries(f.input.plan.users[0]).reverse()) as typeof f.input.plan.users[number];
    expect(await provisionPeopleRoles(f.database, f.input)).toMatchObject({ passed: true });
    expect(digest({ a: new Date(0), b: 1 })).toBe(digest({ b: 1, a: new Date(0) }));
    expect(digest({ a: new Date(0) })).not.toBe(digest({ a: new Date(1) }));
  });
  it('rejects altered manifest before accessing account state' , async () => {
    const f = fixture(); f.input.plan.users[0].name = 'Changed synthetic name';
    await expect(provisionPeopleRoles(f.database, f.input)).rejects.toThrow('MANIFEST_DIGEST_MISMATCH'); expect(f.state.sql).toEqual([]);
  });
});
