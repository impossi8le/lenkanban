/** JSON-only organization DTOs. Structural links never imply grants; global
 * roles are managed only by their explicit audited ADMIN command. */
export interface OrganizationDepartment {
  id: string;
  name: string;
  parentId: string | null;
  leaderId: string | null;
  archived: boolean;
}
export interface OrganizationGroup { id: string; name: string; archived: boolean }
/** Separate administrative configuration; group membership remains independent. */
export interface OrganizationGroupLeadership { id: string; leaderId: string | null }
/** Minimized administrative picker/member view, without email or role fields. */
export interface OrganizationPerson { id: string; displayName: string | null; primaryDepartmentId: string | null }
export interface OrganizationGroupPage { items: OrganizationGroup[]; nextCursor: string | null; version: number }
export interface OrganizationGroupMemberPage { group: OrganizationGroup; items: OrganizationPerson[]; nextCursor: string | null; version: number }
export interface OrganizationPeoplePage { items: OrganizationPerson[]; nextCursor: string | null; version: number }
/** Administrative metadata only; no project content, owner or members. */
export interface OrganizationProject { id: string; displayName: string | null; departmentId: string | null; responsibleGroupId: string | null }
export interface OrganizationProjectPage { items: OrganizationProject[]; nextCursor: string | null; version: number }
export type OrganizationGlobalRole = 'USER' | 'ADMIN';
/** Separate ADMIN-only role picker; ordinary people DTO never includes roles. */
export interface OrganizationRoleUser { id: string; displayName: string | null; globalRole: OrganizationGlobalRole }
export interface OrganizationRolePage { items: OrganizationRoleUser[]; nextCursor: string | null; version: number }
export interface OrganizationMutation<T> { result: T; version: number; replayed: boolean }
export interface OrganizationDepartmentPage {
  items: OrganizationDepartment[];
  parent: OrganizationDepartment | null;
  nextCursor: string | null;
  version: number;
}
export const ORGANIZATION_MAX_VERSION = 2147483647;

/** Prospective submission policy; never a legacy read/write grant. */
export type OrganizationApplicantPolicy = {
  allEmployees: boolean;
  userIds: string[];
  departmentIds: string[];
  groupIds: string[];
};
export type OrganizationApplicantSource = 'unconfigured' | 'all_employees' | 'explicit_user'
  | 'primary_department' | 'responsible_group' | 'not_in_policy';
export interface OrganizationApplicantPreview {
  userId: string;
  allowed: boolean | null;
  source: OrganizationApplicantSource;
}
export interface OrganizationProjectApplicants {
  project: { id: string; displayName: string | null };
  policy: OrganizationApplicantPolicy | null;
  preview: OrganizationApplicantPreview | null;
  version: number;
}

/** Closed configuration catalog, in canonical lexical order. Resource routes
 * still enforce their own access and lifecycle checks. */
export const ORGANIZATION_PRIVILEGE_PERMISSIONS = [
  'board.columns.manage',
  'board.create',
  'board.members.manage',
  'board.privileges.manage',
  'request.approve',
  'request.assign',
  'request.attachment.read',
  'request.comment',
  'request.create',
  'request.execute',
  'request.export',
  'request.internal.read',
  'request.manage',
  'request.move',
  'request.read',
  'request.read.common',
  'request.return_for_revision',
  'request.update',
] as const;
/** Closed action catalog. A profile name never grants anything: only these
 * explicit permissions do, and an unlisted action is denied by default. */
export type OrganizationPrivilegePermission = typeof ORGANIZATION_PRIVILEGE_PERMISSIONS[number];
export type OrganizationPrivilegeProfile = {
  id: string;
  name: string;
  permissions: OrganizationPrivilegePermission[];
  visibility: OrganizationPrivilegeVisibility;
  archived: boolean;
};
export type OrganizationPrivilegeScope = 'organization' | 'department' | 'board';
export type OrganizationPrivilegeVisibility = 'own' | 'board';
export type OrganizationPrivilegeActionCatalog = Record<OrganizationPrivilegePermission, {
  scopeKinds: readonly OrganizationPrivilegeScope[];
  description: string;
}>;
/** Scope describes where a grant applies, never a cross-board move. */
export const ORGANIZATION_PRIVILEGE_MATRIX: OrganizationPrivilegeActionCatalog = {
  'request.approve': { scopeKinds: ['board'], description: 'Приёмка счёта и закрытие заявки вместо автора' },
  'request.read.common': { scopeKinds: ['board'], description: 'Просмотр общих отправленных заявок и архива доски без права исполнения' },
  'request.return_for_revision': { scopeKinds: ['board'], description: 'Возврат счёта на доработку с сохранением исполнителя' },
  'request.read': { scopeKinds: ['organization', 'department', 'board'], description: 'Просмотр заявок' },
  'request.create': { scopeKinds: ['organization', 'department', 'board'], description: 'Создание заявки' },
  'request.execute': { scopeKinds: ['organization', 'department', 'board'], description: 'Взятие и выполнение доступных заявок своего ответственного отдела' },
  'request.manage': { scopeKinds: ['organization', 'department', 'board'], description: 'Управление доступными заявками в назначенной области' },
  'request.update': { scopeKinds: ['organization', 'department', 'board'], description: 'Изменение заявки' },
  'request.assign': { scopeKinds: ['organization', 'department', 'board'], description: 'Назначение исполнителя внутри доски' },
  'request.move': { scopeKinds: ['organization', 'department', 'board'], description: 'Разрешённый переход статуса внутри доски' },
  'request.comment': { scopeKinds: ['organization', 'department', 'board'], description: 'Добавление комментария' },
  'request.internal.read': { scopeKinds: ['organization', 'department', 'board'], description: 'Чтение внутреннего обсуждения' },
  'request.attachment.read': { scopeKinds: ['organization', 'department', 'board'], description: 'Чтение доступных вложений' },
  'request.export': { scopeKinds: ['organization', 'department', 'board'], description: 'Экспорт доступных заявок' },
  'board.columns.manage': { scopeKinds: ['organization', 'department', 'board'], description: 'Управление колонками доски' },
  'board.members.manage': { scopeKinds: ['organization', 'department', 'board'], description: 'Управление участниками доски' },
  'board.privileges.manage': { scopeKinds: ['organization', 'department', 'board'], description: 'Управление привилегиями доски' },
  'board.create': { scopeKinds: ['organization'], description: 'Создание доски; сервер требует глобальную роль ADMIN' },
};
export type OrganizationPrivilegeAssignment = {
  id: string;
  userId: string;
  profileId: string;
  scopeKind: OrganizationPrivilegeScope;
  departmentId: string | null;
  projectId: string | null;
  assigned: boolean;
};
export interface OrganizationPrivilegeProfilePage {
  items: OrganizationPrivilegeProfile[];
  matrix?: OrganizationPrivilegeMatrix['catalog'];
  nextCursor: string | null;
  version: number;
}
export type OrganizationGroupPrivilegeAssignment = Omit<OrganizationPrivilegeAssignment, 'userId'> & { groupId: string };
export interface OrganizationGroupPrivilegeAssignmentPage {
  items: (OrganizationGroupPrivilegeAssignment & OrganizationAssignmentNames)[];
  nextCursor: string | null;
  version: number;
}
export interface OrganizationPrivilegeAssignmentPage {
  items: (OrganizationPrivilegeAssignment & OrganizationAssignmentNames)[];
  nextCursor: string | null;
  version: number;
}
/** Read-only administrative labels, never persisted in command receipts. */
export interface OrganizationAssignmentNames {
  profileName?: string;
  departmentName?: string;
  projectName?: string;
}
export type OrganizationPrivilegeDenyReason =
  | 'no_grant'
  | 'outside_scope'
  | 'profile_archived'
  | 'requires_request_read';
/** One row of the administrative action matrix, with its provenance. */
export interface OrganizationActionDecision {
  action: OrganizationPrivilegePermission;
  allowed: boolean;
  source: 'global_admin' | 'assignment' | 'none';
  /** Most specific matching layer that grants this action; for a denial, the
   * most specific matching layer that was considered. Null when nothing
   * matched the evaluated board at all. */
  scopeKind: OrganizationPrivilegeScope | null;
  assignmentIds: string[];
  reason: OrganizationPrivilegeDenyReason | null;
}
export interface OrganizationPrivilegeMatrix {
  /** Configuration metadata, separate from effective decisions. */
  catalog?: OrganizationPrivilegeActionCatalog;
  actions: OrganizationActionDecision[];
  /** Layer order (organization → department → board) used only for provenance
   * and display. It is not an inheritance chain: every matching active
   * assignment contributes, and effective permissions are their OR. A narrower
   * layer adds grants but never removes a broader one. */
  inheritance: readonly OrganizationPrivilegeScope[];
  denyByDefault: true;
}
export interface OrganizationScopedDecision {
  allowed: boolean;
  source: 'global_admin' | 'assignment' | 'none' | 'requires_request_read';
  assignmentIds: string[];
}
export interface OrganizationPrivilegePreview {
  project: { id: string; displayName: string | null; departmentId: string | null };
  subject: { id: string; displayName: string | null };
  legacy: { canRead: boolean; canWrite: boolean; canManageMembers: boolean };
  applicant: { allowed: boolean | null; source: OrganizationApplicantSource };
  scoped: { requestRead: OrganizationScopedDecision; internalRead: OrganizationScopedDecision };
  /** Server explanation of the currently enforced coarse project boundary.
   * This is not a decision for an individual task or an internal discussion.
   */
  effective: {
    project: import('./access-policy').ProjectAccessEvaluation;
    /** Current readers return personal_or_executor; older labels remain compatible with historical DTOs. */
    taskReadPolicy: 'legacy' | 'own' | 'personal_or_executor';
    /** Compatibility field: always false. request.read alone never grants foreign task visibility. */
    scopedRequestReadApplied: boolean;
    taskAndDiscussionAccess: 'requires_resource_check';
    /** Per-action result of the OR of every matching active assignment. */
    matrix: OrganizationPrivilegeMatrix;
    assignmentSources: {
      source: 'personal' | 'group';
      groupId: string | null;
      assignmentId: string;
      profileId: string;
      scopeKind: OrganizationPrivilegeScope;
      departmentId: string | null;
      projectId: string | null;
      permissions: OrganizationPrivilegePermission[];
      reason: 'matching' | 'profile_archived' | 'outside_scope';
    }[];
  };
  version: number;
}
