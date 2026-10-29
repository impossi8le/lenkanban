import { describe, expect, it } from "vitest";
import { evaluateLegacyProjectAccess, evaluateProjectAccess, hasActiveResponsibleGroupMembership, projectReadPredicate, taskReadPredicate, type LegacyProjectActor, type LegacyProjectFacts } from "./access-policy";

const user: LegacyProjectActor = { id: "actor", globalRole: "USER" };
const admin: LegacyProjectActor = { id: "actor", globalRole: "ADMIN" };
const cases: { title: string; actor: LegacyProjectActor; project: LegacyProjectFacts | null; source: string; allowed: [boolean, boolean, boolean] }[] = [
  { title: "global ADMIN without loaded project", actor: admin, project: null, source: "global_admin", allowed: [true, true, true] },
  { title: "global ADMIN over owner and PROJECT_ADMIN", actor: admin, project: { ownerId: "actor", membershipRole: "PROJECT_ADMIN" }, source: "global_admin", allowed: [true, true, true] },
  { title: "global ADMIN over ordinary membership", actor: admin, project: { ownerId: "other", membershipRole: "MEMBER" }, source: "global_admin", allowed: [true, true, true] },
  { title: "owner without membership", actor: user, project: { ownerId: "actor", membershipRole: null }, source: "project_owner", allowed: [true, true, true] },
  { title: "owner over PROJECT_ADMIN", actor: user, project: { ownerId: "actor", membershipRole: "PROJECT_ADMIN" }, source: "project_owner", allowed: [true, true, true] },
  { title: "owner over ordinary membership", actor: user, project: { ownerId: "actor", membershipRole: "MEMBER" }, source: "project_owner", allowed: [true, true, true] },
  { title: "non-owner PROJECT_ADMIN", actor: user, project: { ownerId: "other", membershipRole: "PROJECT_ADMIN" }, source: "project_admin", allowed: [true, true, true] },
  { title: "ordinary member cannot manage members", actor: user, project: { ownerId: "other", membershipRole: "MEMBER" }, source: "project_member", allowed: [true, true, false] },
  { title: "non-owner without membership", actor: user, project: { ownerId: "other", membershipRole: null }, source: "no_project_access", allowed: [false, false, false] },
  { title: "USER without project facts", actor: user, project: null, source: "no_project_access", allowed: [false, false, false] },
];

describe("closed legacy project access policy", () => {
  it.each(cases)("$title", ({ actor, project, source, allowed }) => {
    expect(evaluateLegacyProjectAccess(actor, project)).toEqual({
      canRead: { allowed: allowed[0], source }, canWrite: { allowed: allowed[1], source }, canManageMembers: { allowed: allowed[2], source },
    });
  });
  it("preserves frozen normalized inputs and deterministically repeats the same decision", () => {
    const actor = Object.freeze({ id: "actor", globalRole: "USER" as const });
    const project = Object.freeze({ ownerId: "other", membershipRole: "MEMBER" as const });
    const original = JSON.stringify({ actor, project });
    const first = evaluateLegacyProjectAccess(actor, project);
    expect(evaluateLegacyProjectAccess(actor, project)).toEqual(first);
    expect(JSON.stringify({ actor, project })).toBe(original);
  });
  it("allocates independent result and capability decisions on every evaluation", () => {
    const first = evaluateLegacyProjectAccess(user, { ownerId: "other", membershipRole: "MEMBER" });
    const second = evaluateLegacyProjectAccess(user, { ownerId: "other", membershipRole: "MEMBER" });
    expect(first).not.toBe(second);
    expect(first.canRead).not.toBe(second.canRead); expect(first.canWrite).not.toBe(second.canWrite); expect(first.canManageMembers).not.toBe(second.canManageMembers);
    expect(first.canRead).not.toBe(first.canWrite); expect(first.canRead).not.toBe(first.canManageMembers);
    // Freezing one caller's results cannot affect subsequent evaluations.
    Object.freeze(first.canRead); Object.freeze(first.canWrite); Object.freeze(first.canManageMembers); Object.freeze(first);
    expect(evaluateLegacyProjectAccess(admin, null)).toEqual({
      canRead: { allowed: true, source: "global_admin" }, canWrite: { allowed: true, source: "global_admin" }, canManageMembers: { allowed: true, source: "global_admin" },
    });
  });
  it("never treats matching department, leader, group or arbitrary permission metadata as grants", () => {
    const actor = Object.freeze({ ...user, primaryDepartmentId: "department", ledDepartments: ["department"], responsibleGroupIds: ["group"], permissions: ["project:write", "ADMIN"] });
    const project = Object.freeze({ ownerId: "other", membershipRole: null, departmentId: "department", leaderId: "actor", responsibleGroupId: "group", permissions: ["read", "manage"] });
    expect(evaluateLegacyProjectAccess(actor, project)).toEqual({
      canRead: { allowed: false, source: "no_project_access" }, canWrite: { allowed: false, source: "no_project_access" }, canManageMembers: { allowed: false, source: "no_project_access" },
    });
  });
});

describe("configured responsible-group board read", () => {
  it("grants read only from an explicit active relation fact and preserves legacy provenance", () => {
    const facts = { ownerId: "other", membershipRole: null };
    expect(evaluateProjectAccess(user, facts, false, true)).toEqual({
      canRead: { allowed: true, source: "responsible_group_read" },
      canWrite: { allowed: false, source: "no_project_access" },
      canManageMembers: { allowed: false, source: "no_project_access" },
    });
    expect(evaluateProjectAccess(user, null, false, true).canRead.allowed).toBe(false);
    expect(evaluateProjectAccess(user, { ...facts, membershipRole: "MEMBER" }, false, true).canRead.source).toBe("project_member");
    expect(evaluateProjectAccess(user, facts, false).canRead.allowed).toBe(false);
  });
  it("requires the actor in an active persisted group rather than bare group metadata", () => {
    expect(hasActiveResponsibleGroupMembership({ archivedAt: null, members: [{ userId: user.id }] }, user.id)).toBe(true);
    for (const group of [null, undefined, { archivedAt: new Date(0), members: [{ userId: user.id }] }, { archivedAt: null, members: [{ userId: "other" }] }]) expect(hasActiveResponsibleGroupMembership(group, user.id)).toBe(false);
  });
  it("builds a read predicate with one active exact group relation and no write authority", () => {
    expect(projectReadPredicate(user)).toEqual({ OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } },
      { departmentId: null, responsibleGroup: { is: { archivedAt: null, members: { some: { userId: user.id } } } } }, { department: { is: { archivedAt: null } } }] });
    expect(projectReadPredicate(admin)).toEqual({});
  });
});

describe("global task policy ignores the former staged OWN allowlist", () => {
  it("uses the same personal/execute rule on configured and unconfigured boards", () => {
    expect(taskReadPredicate(user, [])).toEqual(taskReadPredicate(user, ["board"], [], true));
  });
  it("keeps the global ADMIN bypass", () => {
    expect(taskReadPredicate(admin, [], [{ id: "board" }])).toEqual({});
  });
});
