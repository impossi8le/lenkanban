import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findUnique: mocks.findUnique }, user: { findUnique: mocks.user } } }));
import { getProjectAccess, requireProjectMemberAdmin, requireProjectRead, requireProjectWrite } from "./project-access";

const user = { id: "user-one", globalRole: "USER" as const };
function project(overrides: Record<string, unknown> = {}) {
  return { id: "project-one", ownerId: "other-owner", members: [],
    departmentId: "department-one", responsibleGroupId: "group-one",
    department: { id: "department-one", archivedAt: null, parentId: "parent-one" },
    responsibleGroup: { id: "group-one", archivedAt: null, members: [{ userId: user.id }] }, ...overrides };
}
beforeEach(() => { mocks.findUnique.mockReset(); mocks.user.mockReset(); mocks.user.mockResolvedValue(null); });

describe("organization metadata grants no implicit writes; explicit active bound group grants only read", () => {
  it.each([
    ["matching primary department", { primaryDepartmentId: "department-one" }, project({ responsibleGroup: null })],
    ["department administrator metadata", { departmentAdminScopes: ["department-one"] }, project({ responsibleGroup: null })],
    ["parent department metadata", { primaryDepartmentId: "parent-one" }, project({ responsibleGroup: null })],
    ["board metadata without legacy membership", {}, project({ departmentId: null, responsibleGroupId: null, responsibleGroup: null })],
  ])("does not grant a nonmember access via %s", async (_label, metadata, board) => {
    mocks.findUnique.mockResolvedValue(board);
    expect(await getProjectAccess({ ...user, ...metadata }, "project-one")).toEqual({ projectId: "project-one", canRead: false, canWrite: false, canManageMembers: false });
  });
  it("grants only read to a persisted active responsible-group member without ProjectMember", async () => {
    mocks.findUnique.mockResolvedValue(project());
    expect(await getProjectAccess(user, "project-one")).toEqual({ projectId: "project-one", canRead: true, canWrite: false, canManageMembers: false });
  });
  it.each([
    ["legacy owner", { ownerId: user.id }, true],
    ["legacy member", { members: [{ role: "MEMBER" }] }, false],
    ["legacy project administrator", { members: [{ role: "PROJECT_ADMIN" }] }, true],
  ])("preserves %s despite unrelated or archived organizational metadata", async (_label, legacy, manage) => {
    const board = project({ ...legacy, departmentId: "unrelated-department", responsibleGroupId: "unrelated-group",
      department: { archivedAt: new Date("2026-01-01") }, responsibleGroup: { archivedAt: new Date("2026-01-01"), members: [] } });
    mocks.findUnique.mockResolvedValue(board);
    expect(await getProjectAccess(user, "project-one")).toEqual({ projectId: "project-one", canRead: true, canWrite: true, canManageMembers: manage });
  });
  it("does not treat a missing project as visible to an ordinary user", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await getProjectAccess(user, "missing")).toEqual({ projectId: "missing", canRead: false, canWrite: false, canManageMembers: false });
  });
  it("preserves the explicit global administrator bypass", async () => {
    expect(await getProjectAccess({ id: "admin", globalRole: "ADMIN" }, "project-one")).toEqual({ projectId: "project-one", canRead: true, canWrite: true, canManageMembers: true });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
  it("uses the caller transaction rather than an application database lookup", async () => {
    const findUnique = vi.fn().mockResolvedValue(project({ members: [{ role: "MEMBER" }] }));
    const database = { project: { findUnique } } as unknown as NonNullable<Parameters<typeof getProjectAccess>[2]>;
    expect((await getProjectAccess(user, "project-one", database)).canWrite).toBe(true);
    expect(findUnique).toHaveBeenCalledOnce(); expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(findUnique.mock.calls[0][0].where).toEqual({ id: "project-one" });
  });
  it("does not mutate supplied identity or loaded organization metadata", async () => {
    const actor = Object.freeze({ ...user, primaryDepartmentId: "department-one" });
    const board = Object.freeze(project({ members: Object.freeze([{ role: "MEMBER" }]) }));
    const before = JSON.stringify(board); mocks.findUnique.mockResolvedValue(board);
    await getProjectAccess(actor, "project-one"); expect(JSON.stringify(board)).toBe(before);
  });
  it.each([requireProjectRead, requireProjectWrite, requireProjectMemberAdmin])("keeps unauthorized resources hidden through a public wrapper", async requireAccess => {
    mocks.findUnique.mockResolvedValue(project({ responsibleGroup: null }));
    await expect(requireAccess(user, "project-one")).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("does not promote a legacy ordinary member to membership administrator", async () => {
    mocks.findUnique.mockResolvedValue(project({ members: [{ role: "MEMBER" }] }));
    await expect(requireProjectMemberAdmin(user, "project-one")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(requireProjectRead(user, "project-one")).resolves.toMatchObject({ canRead: true });
    await expect(requireProjectWrite(user, "project-one")).resolves.toEqual({ projectId: "project-one", canRead: true, canWrite: true, canManageMembers: false });
  });
  it("propagates a database failure instead of treating it as permission", async () => {
    const failure = new Error("synthetic database failure"); mocks.findUnique.mockRejectedValue(failure);
    await expect(getProjectAccess(user, "project-one")).rejects.toBe(failure);
  });
});
