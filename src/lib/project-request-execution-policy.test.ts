import { describe, expect, it, vi } from "vitest";
vi.mock("./prisma", () => ({ prisma: {} }));
import { canExecuteRequest, getProjectRequestExecutionPolicy, requestStaffWhere } from "./project-request-execution-policy";

const project = { departmentId: "department", department: { id: "department", archivedAt: null }, responsibleGroupId: "group", responsibleGroup: { archivedAt: null } };
describe("destination department executor rule", () => {
  it("uses fresh active destination staff, ignoring group and leader shortcuts", () => {
    expect(requestStaffWhere(project)).toEqual({ primaryDepartmentId: "department", isBlocked: false, blockedAt: null });
    expect(canExecuteRequest({ hasDepartment: true, isDepartmentStaff: false, isGroupMember: true, hasExecutionPermission: true })).toBe(false);
    expect(canExecuteRequest({ hasDepartment: true, isDepartmentStaff: true, isGroupMember: false, hasExecutionPermission: true })).toBe(true);
  });
  it("requires explicit execution permission even for department staff", () => {
    expect(canExecuteRequest({ hasDepartment: true, isDepartmentStaff: true, isGroupMember: true, hasExecutionPermission: false })).toBe(false);
  });
  it("denies archived or missing bound departments rather than falling back to the group", () => {
    expect(requestStaffWhere({ ...project, department: { ...project.department, archivedAt: new Date() } })).toBeNull();
    expect(requestStaffWhere({ ...project, department: null })).toBeNull();
    expect(requestStaffWhere(null)).toBeNull();
  });
  it("retains active group fallback only for an unbound board", () => {
    expect(requestStaffWhere({ ...project, departmentId: null, department: null })).toEqual({ isBlocked: false, blockedAt: null, responsibleGroupMemberships: { some: { groupId: "group", group: { archivedAt: null } } } });
    expect(requestStaffWhere({ ...project, departmentId: null, department: null, responsibleGroup: { archivedAt: new Date() } })).toBeNull();
    expect(canExecuteRequest({ hasDepartment: false, isDepartmentStaff: false, isGroupMember: true, hasExecutionPermission: true })).toBe(true);
  });
  it.each([true, false])("refreshes the actor match for the presentation hint (%s)", async eligible => {
    const database = { scopedPrivilegeAssignment: { findMany: vi.fn(async () => [{ id: "grant", userId: "actor", profileId: "executor", scopeKind: "department", departmentId: "department", projectId: null, profile: { permissions: ["request.execute"], archivedAt: null } }]) }, project: { findUnique: vi.fn().mockResolvedValue(project) }, user: { findFirst: vi.fn().mockResolvedValue(eligible ? { id: "actor" } : null) } };
    expect(await getProjectRequestExecutionPolicy("actor", "board", database as never)).toEqual({ canExecute: eligible });
    expect(database.user.findFirst).toHaveBeenCalledWith({ where: { AND: [{ id: "actor" }, { primaryDepartmentId: "department", isBlocked: false, blockedAt: null }] }, select: { id: true } });
  });
});
