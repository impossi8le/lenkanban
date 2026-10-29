import {
  ORGANIZATION_PRIVILEGE_PERMISSIONS, type OrganizationActionDecision, type OrganizationPrivilegeDenyReason,
  type OrganizationPrivilegeMatrix, type OrganizationPrivilegePermission, type OrganizationPrivilegeScope,
} from './organization-contract';
import { matchesScopedPrivilegeScope, type ScopedPrivilegeGrant } from './access-policy';

/**
 * Pure explanation layer for #16. It does not grant anything by itself: every
 * decision is derived from persisted assignments and the closed permission
 * catalog. Names of starter profiles are labels only; the explicit permission
 * array is the grant.
 */

export type StarterPrivilegeProfile = Readonly<{
  key: 'administrator' | 'department_lead' | 'board_manager' | 'employee' | 'observer';
  name: string;
  description: string;
  permissions: readonly OrganizationPrivilegePermission[];
  /** Scopes an administrator may assign this starter set to. */
  scopeKinds: readonly OrganizationPrivilegeScope[];
}>;

/** Organization → department → board. Layer order for provenance only: every
 * matching active assignment is combined with OR, so a narrower layer adds
 * grants and never removes a broader one. */
export const PRIVILEGE_SCOPE_LAYERS: readonly OrganizationPrivilegeScope[] = ['organization', 'department', 'board'];

/** Named assignment templates, not decisions for a resource. request.read
 * alone never exposes foreign tasks: canonical visibility requires personal
 * participation or actual request.execute + current staff. Internal discussion
 * additionally requires its own authority after the task itself is readable.
 * Global ADMIN remains a separate audited account role.
 */
export const STARTER_PRIVILEGE_PROFILES: readonly StarterPrivilegeProfile[] = Object.freeze([
  Object.freeze({
    key: 'administrator' as const, name: 'Администратор',
    description: 'Разрешения чтения в организации. Видимость заявок проверяется отдельно; глобальная роль ADMIN не выдаётся.',
    permissions: Object.freeze(['request.internal.read', 'request.read'] as const),
    scopeKinds: Object.freeze(['organization'] as const),
  }),
  Object.freeze({
    key: 'department_lead' as const, name: 'Руководитель подразделения',
    description: 'Разрешения чтения своего подразделения. Чужие заявки требуют действующего права исполнения; управление привилегиями не входит.',
    permissions: Object.freeze(['request.internal.read', 'request.read'] as const),
    scopeKinds: Object.freeze(['department'] as const),
  }),
  Object.freeze({
    key: 'board_manager' as const, name: 'Управляющий доской',
    description: 'Разрешения чтения одной доски. Чужие заявки требуют действующего права исполнения; выдача привилегий не входит.',
    permissions: Object.freeze(['request.internal.read', 'request.read'] as const),
    scopeKinds: Object.freeze(['board'] as const),
  }),
  Object.freeze({
    key: 'employee' as const, name: 'Сотрудник',
    description: 'Просмотр своих и доступных по личному участию заявок. Чужие общие заявки требуют права исполнения доски.',
    permissions: Object.freeze(['request.read'] as const),
    scopeKinds: Object.freeze(['organization', 'department', 'board'] as const),
  }),
  Object.freeze({
    key: 'observer' as const, name: 'Наблюдатель',
    description: 'Разрешение чтения обычной части доступных заявок. Само назначение не открывает чужие заявки и внутренние материалы.',
    permissions: Object.freeze(['request.read'] as const),
    scopeKinds: Object.freeze(['organization', 'department', 'board'] as const),
  }),
]);

export type PrivilegeFacts = Readonly<{ globalAdmin: boolean; projectId: string; activeDepartmentId: string | null }>;

type Layer = Readonly<{ scopeKind: OrganizationPrivilegeScope; grants: readonly ScopedPrivilegeGrant[] }>;

/** Reuses the single scope matcher from access-policy; no parallel matching. */
function layerOf(grant: ScopedPrivilegeGrant, facts: PrivilegeFacts): OrganizationPrivilegeScope | null {
  return matchesScopedPrivilegeScope({ projectId: facts.projectId, activeDepartmentId: facts.activeDepartmentId }, grant)
    ? grant.scopeKind : null;
}

/** The matrix covers exactly the closed catalog, in its canonical order. */
const ACTIONS: readonly OrganizationPrivilegePermission[] = ORGANIZATION_PRIVILEGE_PERMISSIONS;

/**
 * Effective action matrix.
 *
 * Semantics are the contract's: "only positive grants OR, no deny/inheritance"
 * (SCOPED_PRIVILEGE_CONTRACT.md). Every assignment whose scope matches the
 * evaluated board contributes its permissions; independent profiles and layers
 * are combined with OR. A narrower layer therefore never removes a permission
 * granted by a broader one, and an empty narrower profile grants nothing and
 * denies nothing. This matrix describes assigned permissions, not access to
 * a particular task or eligibility to execute a board. getTaskReadWhere adds
 * current staff + request.execute for foreign tasks; personal participation,
 * lifecycle and audience constraints remain separate. Internal discussion also
 * requires request.read and access to the task itself.
 */
export function evaluatePrivilegeMatrix(facts: PrivilegeFacts, grants: readonly ScopedPrivilegeGrant[]): OrganizationPrivilegeMatrix {
  if (facts.globalAdmin) {
    return {
      actions: ACTIONS.map(action => ({ action, allowed: true, source: 'global_admin' as const,
        scopeKind: 'organization' as const, assignmentIds: [], reason: null })),
      inheritance: PRIVILEGE_SCOPE_LAYERS, denyByDefault: true,
    };
  }
  const layers: Layer[] = PRIVILEGE_SCOPE_LAYERS.map(scopeKind => ({ scopeKind,
    grants: grants.filter(grant => layerOf(grant, facts) === scopeKind) }));
  const active = (layer: Layer) => layer.grants.filter(grant => !grant.profileArchived);
  const matching = layers.flatMap(active);
  const hasAnyArchived = grants.some(grant => grant.profileArchived && layerOf(grant, facts) !== null);
  const hasOutside = grants.length > 0 && !grants.some(grant => layerOf(grant, facts) !== null);
  const effective = new Set<OrganizationPrivilegePermission>();
  for (const grant of matching) for (const permission of grant.permissions) effective.add(permission);
  // Most specific matching layer, reported as provenance of a decision.
  const narrowest = [...layers].reverse().find(layer => active(layer).length > 0) ?? null;
  const scopeOf = (predicate: (grant: ScopedPrivilegeGrant) => boolean) => {
    const sources = PRIVILEGE_SCOPE_LAYERS.filter(scopeKind =>
      matching.some(grant => grant.scopeKind === scopeKind && predicate(grant)));
    return sources.length > 0 ? sources[sources.length - 1] : null;
  };

  const actions: OrganizationActionDecision[] = ACTIONS.map(action => {
    if (effective.has(action)) {
      const ids = matching.filter(grant => grant.permissions.includes(action)).map(grant => grant.id).sort();
      return { action, allowed: true, source: 'assignment' as const,
        scopeKind: scopeOf(grant => grant.permissions.includes(action)), assignmentIds: ids, reason: null };
    }
    const reason: OrganizationPrivilegeDenyReason = action === 'request.internal.read' && effective.has('request.read')
      ? 'requires_request_read'
      : matching.length > 0 ? 'no_grant' : hasAnyArchived ? 'profile_archived' : hasOutside ? 'outside_scope' : 'no_grant';
    return { action, allowed: false, source: 'none' as const, scopeKind: narrowest?.scopeKind ?? null, assignmentIds: [], reason };
  });
  // Internal discussion additionally requires the aggregate read capability.
  if (effective.has('request.internal.read') && !effective.has('request.read')) {
    const index = actions.findIndex(row => row.action === 'request.internal.read');
    actions[index] = { ...actions[index], allowed: false, source: 'none', reason: 'requires_request_read' };
  }
  return { actions, inheritance: PRIVILEGE_SCOPE_LAYERS, denyByDefault: true };
}

export type DelegationScope = Readonly<{ scopeKind: OrganizationPrivilegeScope; departmentId: string | null; projectId: string | null }>;
export type DelegationActor = Readonly<{
  globalAdmin: boolean;
  /** Effective permissions the actor holds in the requested scope. */
  permissions: readonly OrganizationPrivilegePermission[];
  /** Scopes the actor's own assignments cover (organization covers everything). */
  covered: Readonly<{ organization: boolean; departmentIds: readonly string[]; projectIds: readonly string[] }>;
}>;
export type DelegationDecision = Readonly<{
  allowed: boolean;
  reason: 'allowed' | 'not_admin' | 'missing_grant_permission' | 'exceeds_permissions' | 'outside_scope';
  deniedPermissions: readonly OrganizationPrivilegePermission[];
}>;

/**
 * Delegation is bounded by the delegator's own effective scope and permission
 * set: nobody can grant more than they hold, and nobody can grant outside the
 * scope they were given. In this wave management is exclusively the global
 * ADMIN role (the HTTP gate and the fresh-ADMIN re-check under the topology
 * lock), so a non-admin actor with no scoped permissions is refused outright;
 * the scope/subset checks remain a second, independent bound. No profile can
 * carry the global ADMIN role, and no scoped permission implies it.
 */
export function evaluatePrivilegeDelegation(
  actor: DelegationActor, target: DelegationScope, requested: readonly OrganizationPrivilegePermission[],
): DelegationDecision {
  if (actor.globalAdmin) return { allowed: true, reason: 'allowed', deniedPermissions: [] };
  if (actor.permissions.length === 0) {
    return { allowed: false, reason: 'missing_grant_permission', deniedPermissions: [...requested] };
  }
  const inside = target.scopeKind === 'organization'
    ? actor.covered.organization
    : target.scopeKind === 'department'
      ? actor.covered.organization || (target.departmentId !== null && actor.covered.departmentIds.includes(target.departmentId))
      : actor.covered.organization || (target.projectId !== null && actor.covered.projectIds.includes(target.projectId));
  if (!inside) return { allowed: false, reason: 'outside_scope', deniedPermissions: [...requested] };
  const denied = requested.filter(permission => !actor.permissions.includes(permission));
  if (denied.length > 0) return { allowed: false, reason: 'exceeds_permissions', deniedPermissions: denied };
  return { allowed: true, reason: 'allowed', deniedPermissions: [] };
}

/** Derive the delegator's covered scopes from their own active assignments. */
export function delegationActor(globalAdmin: boolean, permissions: readonly OrganizationPrivilegePermission[],
  grants: readonly ScopedPrivilegeGrant[]): DelegationActor {
  const active = grants.filter(grant => !grant.profileArchived);
  return {
    globalAdmin, permissions,
    covered: {
      organization: active.some(grant => grant.scopeKind === 'organization' && grant.departmentId === null && grant.projectId === null),
      departmentIds: [...new Set(active.filter(grant => grant.scopeKind === 'department' && grant.departmentId !== null)
        .map(grant => grant.departmentId as string))].sort(),
      projectIds: [...new Set(active.filter(grant => grant.scopeKind === 'board' && grant.projectId !== null)
        .map(grant => grant.projectId as string))].sort(),
    },
  };
}
