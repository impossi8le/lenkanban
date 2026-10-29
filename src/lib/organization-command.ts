import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ConflictError, ValidationError } from "./errors";
import { ORGANIZATION_MAX_VERSION, ORGANIZATION_PRIVILEGE_PERMISSIONS, type OrganizationDepartment, type OrganizationGroup, type OrganizationGlobalRole } from "./organization-contract";
import { validCorrelationId } from "./telemetry-sanitize";
import { decodeLifecycleColumnMap, type LifecycleColumnMap } from "./task-request-columns";
import type { OrganizationApplicantPolicy } from "./organization-contract";
import type { OrganizationGroupLeadership } from "./organization-contract";
import type { OrganizationPrivilegePermission, OrganizationPrivilegeProfile, OrganizationPrivilegeAssignment, OrganizationPrivilegeScope, OrganizationPrivilegeVisibility } from "./organization-contract";
import type { OrganizationGroupPrivilegeAssignment } from "./organization-contract";

export { ORGANIZATION_MAX_VERSION } from "./organization-contract";
export const ORGANIZATION_STATE_ID = "organization";

export type OrganizationCommandActor = { actorId: string; operationId: string; expectedVersion: number };
export type OrganizationUserDepartment = { id: string; primaryDepartmentId: string | null };
export type OrganizationGroupMembership = { groupId: string; userId: string; member: boolean };
export type OrganizationProjectBinding = { id: string; departmentId: string | null; responsibleGroupId: string | null };
export type OrganizationCreatedBoard = { id: string; departmentId: string; responsibleGroupId: string | null };
export type OrganizationUserGlobalRole = { id: string; globalRole: OrganizationGlobalRole };
export type OrganizationProjectApplicantPolicy = { id: string; policy: OrganizationApplicantPolicy | null };
export type OrganizationProjectLifecycleColumns = { id: string; lifecycleColumnMap: LifecycleColumnMap | null };
export type OrganizationResult = OrganizationDepartment | OrganizationGroup | OrganizationUserDepartment
  | OrganizationGroupMembership | OrganizationProjectBinding | OrganizationUserGlobalRole | OrganizationProjectApplicantPolicy
  | OrganizationPrivilegeProfile | OrganizationPrivilegeAssignment | OrganizationGroupPrivilegeAssignment | OrganizationProjectLifecycleColumns | OrganizationGroupLeadership;
export type OrganizationMethod = "createDepartment" | "renameDepartment" | "moveDepartment" | "setDepartmentArchived"
  | "setDepartmentLeader" | "assignUserDepartment" | "createGroup" | "renameGroup" | "setGroupArchived"
  | "setGroupMember" | "setGroupLeader" | "bindProject" | "setGlobalRole" | "setProjectApplicantPolicy"
  | "createPrivilegeProfile" | "updatePrivilegeProfile" | "setPrivilegeAssignment" | "setGroupPrivilegeAssignment" | "createBoard" | "setProjectLifecycleColumns";
export type OrganizationTargetKind = "department" | "group" | "user" | "project" | "profile" | "privilegeAssignment" | "groupPrivilegeAssignment";

export function isOrganizationMethod(value: unknown): value is OrganizationMethod {
  return typeof value === "string" && ["createDepartment", "renameDepartment", "moveDepartment", "setDepartmentArchived",
    "setDepartmentLeader", "assignUserDepartment", "createGroup", "renameGroup", "setGroupArchived", "setGroupMember", "setGroupLeader", "bindProject", "setGlobalRole", "setProjectApplicantPolicy",
    "createPrivilegeProfile", "updatePrivilegeProfile", "setPrivilegeAssignment", "setGroupPrivilegeAssignment", "createBoard", "setProjectLifecycleColumns"].includes(value);
}

export function isOrganizationCreateMethod(method: OrganizationMethod): boolean {
  return method === "createDepartment" || method === "createGroup" || method === "createPrivilegeProfile" || method === "createBoard";
}

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export function organizationId(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new ValidationError("Invalid organization identifier");
  return value;
}
export function organizationNullableId(value: unknown): string | null {
  return value === null ? null : organizationId(value);
}
export function organizationName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Invalid organization name");
  const name = value.trim();
  if (name.length < 1 || name.length > 120) throw new ValidationError("Invalid organization name");
  return name;
}
export function organizationBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ValidationError("Invalid organization state");
  return value;
}
export function organizationGlobalRole(value: unknown): OrganizationGlobalRole {
  if (value !== "USER" && value !== "ADMIN") throw new ValidationError("Invalid organization role");
  return value;
}
export function organizationVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ORGANIZATION_MAX_VERSION) {
    throw new ValidationError("Invalid organization version");
  }
  return value;
}
export function normalizeOrganizationActor(input: OrganizationCommandActor): OrganizationCommandActor {
  if (!validCorrelationId(input.operationId)) throw new ValidationError("Invalid organization operation");
  return { actorId: organizationId(input.actorId), operationId: input.operationId.toLowerCase(),
    expectedVersion: organizationVersion(input.expectedVersion) };
}

function canonicalJson(value: Prisma.InputJsonValue | null): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item as Prisma.InputJsonValue | null)).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Prisma.InputJsonObject)[key] ?? null)}`).join(",")}}`;
}
/** Called only with freshly normalized, closed command fields, never raw input. */
export function organizationRequestHash(
  method: OrganizationMethod, targetId: string | null, payload: Prisma.InputJsonObject, expectedVersion: number,
): string {
  return createHash("sha256").update(canonicalJson([method, targetId, payload, expectedVersion])).digest("hex");
}

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => !keys.includes(key))) throw new Error();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new Error();
    result[key] = descriptor.value;
  }
  return result;
}

/** Clone normalized fields before any transaction wait. */
export function normalizeOrganizationApplicantPolicy(value: unknown): OrganizationApplicantPolicy | null {
  try {
    if (value === null) return null;
    const row = objectWithKeys(value, ["allEmployees", "userIds", "departmentIds", "groupIds"]);
    const ids = (input: unknown): string[] => {
      if (!Array.isArray(input) || input.length > 20) throw new Error();
      return [...new Set(Array.from(input, organizationId))].sort();
    };
    const policy = { allEmployees: organizationBoolean(row.allEmployees), userIds: ids(row.userIds),
      departmentIds: ids(row.departmentIds), groupIds: ids(row.groupIds) };
    if (policy.allEmployees && (policy.userIds.length || policy.departmentIds.length || policy.groupIds.length)) throw new Error();
    return policy;
  } catch { throw new ValidationError("Invalid project applicant policy"); }
}

/** Saved JSON must already be canonical, not silently repaired. */
export function decodeOrganizationApplicantPolicy(value: unknown): OrganizationApplicantPolicy | null {
  try {
    const policy = normalizeOrganizationApplicantPolicy(value);
    if (value !== null) {
      const row = objectWithKeys(value, ["allEmployees", "userIds", "departmentIds", "groupIds"]);
      for (const key of ["userIds", "departmentIds", "groupIds"] as const) {
        if (JSON.stringify(row[key]) !== JSON.stringify(policy?.[key])) throw new Error();
      }
    }
    return policy;
  } catch { throw new ConflictError("Invalid saved project applicant policy"); }
}

const privilegePermissionSet: ReadonlySet<string> = new Set(ORGANIZATION_PRIVILEGE_PERMISSIONS);
/** Raw input is bounded by the closed catalog before de-duplication, so an
 * unbounded array can never be normalized into a valid profile. */
export function normalizePrivilegePermissions(value: unknown): OrganizationPrivilegePermission[] {
  if (!Array.isArray(value) || value.length > ORGANIZATION_PRIVILEGE_PERMISSIONS.length) {
    throw new ValidationError("Invalid privilege permissions");
  }
  const permissions = Array.from(value, item => {
    if (typeof item !== "string" || !privilegePermissionSet.has(item)) throw new ValidationError("Invalid privilege permissions");
    return item as OrganizationPrivilegePermission;
  });
  // Duplicates collapse; the raw length bound above stops over-long payloads.
  return [...new Set(permissions)].sort();
}

export function decodePrivilegePermissions(value: unknown): OrganizationPrivilegePermission[] {
  return decodePrivilegeProfileSettings(value).permissions;
}

export function normalizePrivilegeVisibility(value: unknown = 'board'): OrganizationPrivilegeVisibility {
  if (value !== 'own' && value !== 'board') throw new ValidationError('Invalid privilege visibility');
  return value;
}

/** Legacy arrays encode the default BOARD. OWN uses the same JSON column.
 * Keep BOARD arrays compatible with existing resource access readers. */
export function encodePrivilegeProfileSettings(permissions: OrganizationPrivilegePermission[], visibility: OrganizationPrivilegeVisibility): Prisma.InputJsonValue {
  return visibility === 'board' ? permissions : { permissions, visibility };
}

export function decodePrivilegeProfileSettings(value: unknown): { permissions: OrganizationPrivilegePermission[]; visibility: OrganizationPrivilegeVisibility } {
  try {
    const row = Array.isArray(value) ? { permissions: value, visibility: 'board' } : objectWithKeys(value, ['permissions', 'visibility']);
    const permissions = normalizePrivilegePermissions(row.permissions);
    if (JSON.stringify(permissions) !== JSON.stringify(row.permissions)) throw new Error();
    return { permissions, visibility: normalizePrivilegeVisibility(row.visibility) };
  } catch { throw new ConflictError("Invalid saved privilege permissions"); }
}

export function normalizePrivilegeScope(scopeKind: unknown, departmentId: unknown, projectId: unknown): {
  scopeKind: OrganizationPrivilegeScope; departmentId: string | null; projectId: string | null;
} {
  const department = organizationNullableId(departmentId);
  const project = organizationNullableId(projectId);
  if ((scopeKind === "organization" && department === null && project === null)
    || (scopeKind === "department" && department !== null && project === null)
    || (scopeKind === "board" && department === null && project !== null)) {
    return { scopeKind, departmentId: department, projectId: project };
  }
  throw new ValidationError("Invalid privilege scope");
}

export function privilegeAssignmentId(userId: string, profileId: string, scopeKind: OrganizationPrivilegeScope,
  departmentId: string | null, projectId: string | null): string {
  const scope = normalizePrivilegeScope(scopeKind, departmentId, projectId);
  return createHash("sha256").update(JSON.stringify([organizationId(userId), organizationId(profileId),
    scope.scopeKind, scope.departmentId, scope.projectId])).digest("hex");
}

/** Domain separation prevents a group ID from aliasing a personal assignment. */
export function groupPrivilegeAssignmentId(groupId: string, profileId: string, scopeKind: OrganizationPrivilegeScope,
  departmentId: string | null, projectId: string | null): string {
  const scope = normalizePrivilegeScope(scopeKind, departmentId, projectId);
  return createHash("sha256").update(JSON.stringify(['group', organizationId(groupId), organizationId(profileId),
    scope.scopeKind, scope.departmentId, scope.projectId])).digest("hex");
}

/** Persistence is not a type cast: unsupported/corrupt receipts fail closed. */
export function decodeOrganizationResult(method: OrganizationMethod, value: unknown): OrganizationResult {
  try {
    if (method === "createPrivilegeProfile" || method === "updatePrivilegeProfile") {
      const hasVisibility = value !== null && typeof value === 'object' && Object.hasOwn(value, 'visibility');
      const row = objectWithKeys(value, ["id", "name", "permissions", "archived", ...(hasVisibility ? ['visibility'] : [])]);
      const name = organizationName(row.name);
      if (name !== row.name) throw new Error();
      const settings = decodePrivilegeProfileSettings(row.permissions);
      return { id: organizationId(row.id), name, ...settings,
        ...(hasVisibility ? { visibility: normalizePrivilegeVisibility(row.visibility) } : {}),
        archived: organizationBoolean(row.archived) };
    }
    if (method === "setGroupPrivilegeAssignment") {
      const row = objectWithKeys(value, ["id", "groupId", "profileId", "scopeKind", "departmentId", "projectId", "assigned"]);
      const groupId = organizationId(row.groupId), profileId = organizationId(row.profileId);
      const scope = normalizePrivilegeScope(row.scopeKind, row.departmentId, row.projectId);
      const id = groupPrivilegeAssignmentId(groupId, profileId, scope.scopeKind, scope.departmentId, scope.projectId);
      if (row.id !== id) throw new Error();
      return { id, groupId, profileId, ...scope, assigned: organizationBoolean(row.assigned) };
    }
    if (method === "setPrivilegeAssignment") {
      const row = objectWithKeys(value, ["id", "userId", "profileId", "scopeKind", "departmentId", "projectId", "assigned"]);
      const userId = organizationId(row.userId), profileId = organizationId(row.profileId);
      const scope = normalizePrivilegeScope(row.scopeKind, row.departmentId, row.projectId);
      const id = privilegeAssignmentId(userId, profileId, scope.scopeKind, scope.departmentId, scope.projectId);
      if (row.id !== id) throw new Error();
      return { id, userId, profileId, ...scope, assigned: organizationBoolean(row.assigned) };
    }
    if (["createDepartment", "renameDepartment", "moveDepartment", "setDepartmentArchived", "setDepartmentLeader"].includes(method)) {
      const row = objectWithKeys(value, ["id", "name", "parentId", "leaderId", "archived"]);
      const name = organizationName(row.name);
      if (name !== row.name) throw new Error();
      return { id: organizationId(row.id), name, parentId: organizationNullableId(row.parentId),
        leaderId: organizationNullableId(row.leaderId), archived: organizationBoolean(row.archived) };
    }
    if (["createGroup", "renameGroup", "setGroupArchived"].includes(method)) {
      const row = objectWithKeys(value, ["id", "name", "archived"]);
      const name = organizationName(row.name);
      if (name !== row.name) throw new Error();
      return { id: organizationId(row.id), name, archived: organizationBoolean(row.archived) };
    }
    if (method === "assignUserDepartment") {
      const row = objectWithKeys(value, ["id", "primaryDepartmentId"]);
      return { id: organizationId(row.id), primaryDepartmentId: organizationNullableId(row.primaryDepartmentId) };
    }
    if (method === "setGroupLeader") {
      const row = objectWithKeys(value, ["id", "leaderId"]);
      return { id: organizationId(row.id), leaderId: organizationNullableId(row.leaderId) };
    }
    if (method === "setGroupMember") {
      const row = objectWithKeys(value, ["groupId", "userId", "member"]);
      return { groupId: organizationId(row.groupId), userId: organizationId(row.userId), member: organizationBoolean(row.member) };
    }
    if (method === "bindProject" || method === "createBoard") {
      const row = objectWithKeys(value, ["id", "departmentId", "responsibleGroupId"]);
      return { id: organizationId(row.id), departmentId: method === "createBoard" ? organizationId(row.departmentId) : organizationNullableId(row.departmentId),
        responsibleGroupId: organizationNullableId(row.responsibleGroupId) };
    }
    if (method === "setGlobalRole") {
      const row = objectWithKeys(value, ["id", "globalRole"]);
      return { id: organizationId(row.id), globalRole: organizationGlobalRole(row.globalRole) };
    }
    if (method === "setProjectApplicantPolicy") {
      const row = objectWithKeys(value, ["id", "policy"]);
      return { id: organizationId(row.id), policy: decodeOrganizationApplicantPolicy(row.policy) };
    }
    if (method === "setProjectLifecycleColumns") {
      const row = objectWithKeys(value, ["id", "lifecycleColumnMap"]);
      return { id: organizationId(row.id), lifecycleColumnMap: decodeLifecycleColumnMap(row.lifecycleColumnMap) };
    }
    throw new Error();
  } catch { throw new ConflictError("Invalid saved organization operation"); }
}

export function organizationResultTarget(result: OrganizationResult): string {
  return "groupId" in result && !("id" in result) ? result.groupId : result.id;
}
