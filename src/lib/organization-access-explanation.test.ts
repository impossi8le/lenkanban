import { describe, expect, it } from 'vitest';
import { evaluateProjectAccess, evaluateScopedPrivileges, matchesScopedPrivilegeScope, type ScopedPrivilegeGrant } from './access-policy';
import { delegationActor, evaluatePrivilegeDelegation, evaluatePrivilegeMatrix, PRIVILEGE_SCOPE_LAYERS, STARTER_PRIVILEGE_PROFILES } from './organization-access-explanation';
import { normalizePrivilegePermissions } from './organization-command';
import { ORGANIZATION_PRIVILEGE_PERMISSIONS, type OrganizationPrivilegePermission } from './organization-contract';

const facts = { globalAdmin: false, projectId: 'board', activeDepartmentId: 'department' };
const grant: ScopedPrivilegeGrant = { id: 'assignment', profileId: 'profile', scopeKind: 'organization',
  departmentId: null, projectId: null, permissions: ['request.read'], profileArchived: false };

describe('project explanations and strict scoped grants', () => {
  it.each([
    ['organization', null, null, true],
    ['organization', 'department', null, false],
    ['organization', null, 'board', false],
    ['department', 'department', null, true],
    ['department', 'other-department', null, false],
    ['department', 'department', 'board', false],
    ['department', null, null, false],
    ['board', null, 'board', true],
    ['board', null, 'other-board', false],
    ['board', 'department', 'board', false],
    ['board', null, null, false],
  ] as const)('matches only valid exact scope %s/%s/%s', (scopeKind, departmentId, projectId, allowed) => {
    const candidate = Object.freeze({ ...grant, scopeKind, departmentId, projectId });
    expect(matchesScopedPrivilegeScope(facts, candidate)).toBe(allowed);
    expect(evaluateScopedPrivileges(facts, [candidate]).requestRead.allowed).toBe(allowed);
    if (scopeKind === 'department') {
      expect(evaluateScopedPrivileges({ ...facts, activeDepartmentId: null }, [candidate]).requestRead.allowed).toBe(false);
    }
  });

  it('keeps scoped reading separate from missing project access and lifecycle writes', () => {
    const actor = Object.freeze({ id: 'employee', globalRole: 'USER' as const });
    const project = Object.freeze({ ownerId: 'other', membershipRole: null });
    expect(evaluateScopedPrivileges(facts, [grant]).requestRead.allowed).toBe(true);
    expect(evaluateProjectAccess(actor, project, true)).toEqual({
      canRead: { allowed: false, source: 'no_project_access' },
      canWrite: { allowed: false, source: 'no_project_access' },
      canManageMembers: { allowed: false, source: 'no_project_access' },
    });
  });

  it('denies every action by default without an explicit matching grant', () => {
    const matrix = evaluatePrivilegeMatrix({ globalAdmin: false, projectId: 'board', activeDepartmentId: 'department' }, []);
    expect(matrix.denyByDefault).toBe(true);
    expect(matrix.actions.every(row => !row.allowed && row.source === 'none' && row.reason === 'no_grant')).toBe(true);
    expect(matrix.actions.map(row => row.action)).toEqual([...ORGANIZATION_PRIVILEGE_PERMISSIONS]);
  });

  it('combines every matching layer with OR: a narrower layer adds grants but never removes them', () => {
    const organization: ScopedPrivilegeGrant = { ...grant, permissions: ['request.internal.read', 'request.read'] };
    const inherited = evaluatePrivilegeMatrix(facts, [organization]);
    expect(inherited.actions.find(row => row.action === 'request.internal.read')).toMatchObject({
      allowed: true, scopeKind: 'organization', assignmentIds: ['assignment'] });
    const boardException: ScopedPrivilegeGrant = { ...grant, id: 'board-exception', scopeKind: 'board', projectId: 'board',
      permissions: ['request.read'] };
    const combined = evaluatePrivilegeMatrix(facts, [organization, boardException]);
    expect(combined.actions.find(row => row.action === 'request.read')).toMatchObject({
      allowed: true, scopeKind: 'board', assignmentIds: ['assignment', 'board-exception'] });
    // SCOPED_PRIVILEGE_CONTRACT: "only positive grants OR, no deny/inheritance".
    // The board assignment is not an exception that can take `request.internal.read` away.
    expect(combined.actions.find(row => row.action === 'request.internal.read')).toMatchObject({
      allowed: true, scopeKind: 'organization', assignmentIds: ['assignment'] });
  });

  it('does not let an empty narrower profile deny a broader grant (matrix must match the enforced read)', () => {
    const organization: ScopedPrivilegeGrant = { ...grant, permissions: ['request.read'] };
    const emptyBoard: ScopedPrivilegeGrant = { ...grant, id: 'empty-board', scopeKind: 'board', projectId: 'board', permissions: [] };
    const matrix = evaluatePrivilegeMatrix(facts, [organization, emptyBoard]);
    expect(matrix.actions.find(row => row.action === 'request.read')).toMatchObject({
      allowed: true, scopeKind: 'organization', assignmentIds: ['assignment'] });
    // The enforced evaluator used by task reads and internal discussion agrees.
    expect(evaluateScopedPrivileges(facts, [organization, emptyBoard]).requestRead.allowed).toBe(true);
  });

  it('reports a matching layer without the permission as no_grant, never as an override', () => {
    const organization: ScopedPrivilegeGrant = { ...grant, permissions: [] };
    const matrix = evaluatePrivilegeMatrix(facts, [organization]);
    expect(matrix.actions.find(row => row.action === 'request.read')).toMatchObject({
      allowed: false, reason: 'no_grant', scopeKind: 'organization' });
  });

  it('does not let a department layer leak into another department and stays deny by default there', () => {
    const other: ScopedPrivilegeGrant = { ...grant, id: 'other-dept', scopeKind: 'department', departmentId: 'other' };
    const matrix = evaluatePrivilegeMatrix(facts, [other]);
    expect(matrix.actions.every(row => !row.allowed)).toBe(true);
    expect(matrix.actions[0].reason).toBe('outside_scope');
    expect(evaluatePrivilegeMatrix(facts, [{ ...grant, profileArchived: true }]).actions[0].reason).toBe('profile_archived');
  });

  it('keeps internal discussion dependent on aggregate request.read', () => {
    const internal: ScopedPrivilegeGrant = { ...grant, id: 'internal', permissions: ['request.internal.read'] };
    const matrix = evaluatePrivilegeMatrix(facts, [internal]);
    expect(matrix.actions.find(row => row.action === 'request.internal.read')).toMatchObject({
      allowed: false, reason: 'requires_request_read' });
    expect(evaluatePrivilegeMatrix({ ...facts, globalAdmin: true }, []).actions.every(row => row.allowed && row.source === 'global_admin')).toBe(true);
  });

  it('offers starter profiles as named explicit permission sets, never as names', () => {
    expect(STARTER_PRIVILEGE_PROFILES.map(profile => profile.name)).toEqual([
      'Администратор', 'Руководитель подразделения', 'Управляющий доской', 'Сотрудник', 'Наблюдатель',
    ]);
    for (const profile of STARTER_PRIVILEGE_PROFILES) {
      expect(profile.permissions.length).toBeGreaterThan(0);
      expect(normalizePrivilegePermissions([...profile.permissions])).toEqual([...profile.permissions].sort());
    }
    const employee = STARTER_PRIVILEGE_PROFILES.find(profile => profile.key === 'employee')!;
    const observer = STARTER_PRIVILEGE_PROFILES.find(profile => profile.key === 'observer')!;
    // Only enforced capabilities are offered: both sets grant visibility, while
    // creation/update stay with the request lifecycle, not this profile.
    expect(employee.permissions).toEqual(['request.read']);
    expect(observer.permissions).toEqual(['request.read']);
    expect(PRIVILEGE_SCOPE_LAYERS).toEqual(['organization', 'department', 'board']);
  });

  it('bounds delegation by the actor permissions and covered scope', () => {
    const boardGrant: ScopedPrivilegeGrant = { ...grant, id: 'own-board', scopeKind: 'board', projectId: 'board',
      permissions: ['request.internal.read', 'request.read'] };
    const actor = delegationActor(false, ['request.internal.read', 'request.read'], [boardGrant]);
    const board = { scopeKind: 'board' as const, departmentId: null, projectId: 'board' };
    expect(evaluatePrivilegeDelegation(actor, board, ['request.read', 'request.internal.read']))
      .toEqual({ allowed: true, reason: 'allowed', deniedPermissions: [] });
    const readOnly = delegationActor(false, ['request.read'], [{ ...boardGrant, permissions: ['request.read'] }]);
    expect(evaluatePrivilegeDelegation(readOnly, board, ['request.read', 'request.internal.read'])).toMatchObject({
      allowed: false, reason: 'exceeds_permissions', deniedPermissions: ['request.internal.read'] });
    expect(evaluatePrivilegeDelegation(actor, { ...board, projectId: 'other-board' }, ['request.read'])).toMatchObject({
      allowed: false, reason: 'outside_scope' });
    expect(evaluatePrivilegeDelegation(delegationActor(false, [], []), board, ['request.read'])).toMatchObject({
      allowed: false, reason: 'missing_grant_permission' });
    expect(evaluatePrivilegeDelegation({ ...actor, globalAdmin: true }, { scopeKind: 'organization', departmentId: null, projectId: null },
      ['request.read'] as OrganizationPrivilegePermission[])).toMatchObject({ allowed: true, reason: 'allowed' });
  });

  it('denies coarse OWN writes even for owners without removing the independent membership capability', () => {
    const result = evaluateProjectAccess({ id: 'owner', globalRole: 'USER' }, { ownerId: 'owner', membershipRole: 'PROJECT_ADMIN' }, true);
    expect(result.canWrite).toEqual({ allowed: false, source: 'own_write_restricted' });
    expect(result.canManageMembers).toEqual({ allowed: true, source: 'project_owner' });
    expect(evaluateProjectAccess({ id: 'admin', globalRole: 'ADMIN' }, null, true).canWrite).toEqual({ allowed: true, source: 'global_admin' });
  });
});
