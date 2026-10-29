import { beforeEach, describe, expect, it, vi } from "vitest";
const grants = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: {} }));
vi.mock("./role-grants", async original => ({ ...await original<typeof import("./role-grants")>(), loadRoleGrants: grants.load }));
import { getProjectRequestExecutorIds, getRequestExecutionProjectIds } from "./project-request-execution-policy";

const project = (id: string, departmentId: string | null = "dept") => ({ id, departmentId, department: departmentId ? { id: departmentId, archivedAt: null as Date | null } : null, responsibleGroupId: "group", responsibleGroup: { archivedAt: null as Date | null } });
const grant = (userId: string, patch: object = {}) => ({ id: userId, userId, profileId: "profile", scopeKind: "organization", departmentId: null, projectId: null, profileArchived: false, permissions: ["request.execute"], ...patch });
function fixture(projects = [project("board")]) {
  const db = {
    project: { findMany: vi.fn().mockResolvedValue(projects), findUnique: vi.fn().mockResolvedValue(projects[0] ?? null) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: "staff", primaryDepartmentId: "dept", responsibleGroupMemberships: [{ groupId: "group" }] }), findMany: vi.fn().mockResolvedValue([{ id: "staff" }, { id: "reader" }]) },
  };
  return db;
}
beforeEach(() => { grants.load.mockReset(); grants.load.mockResolvedValue([grant("staff")]); });
describe("batched fresh queue execution projections", () => {
  it("loads one actor and grants once for many projects, honoring department and board scopes", async () => {
    const db = fixture([project("board"), project("other", "other-dept"), project("group-board", null)]);
    grants.load.mockResolvedValue([grant("staff", { scopeKind: "board", projectId: "board" })]);
    expect(await getRequestExecutionProjectIds("staff", undefined, db as never)).toEqual(["board"]);
    expect(db.user.findFirst).toHaveBeenCalledTimes(1); expect(grants.load).toHaveBeenCalledExactlyOnceWith(db, ["staff"]);
    expect(db.user.findFirst.mock.calls[0][0].where).toEqual({ id: "staff", isBlocked: false, blockedAt: null });
  });
  it("archived bound departments cannot fall back to group membership", async () => {
    const archived = { ...project("board"), department: { id: "dept", archivedAt: new Date() } };
    const db = fixture([archived, project("group-board", null)]);
    expect(await getRequestExecutionProjectIds("staff", ["board", "group-board"], db as never)).toEqual(["group-board"]);
    expect(db.project.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["board", "group-board"] } });
    const archivedDb = fixture([archived]);
    expect(await getProjectRequestExecutorIds("board", archivedDb as never)).toEqual([]);
    expect(archivedDb.user.findMany).not.toHaveBeenCalled();
  });
  it("requires active user and explicit request.execute even with administrative/read grants", async () => {
    const db = fixture();
    db.user.findFirst.mockResolvedValueOnce(null);
    expect(await getRequestExecutionProjectIds("staff", undefined, db as never)).toEqual([]);
    grants.load.mockResolvedValue([grant("staff", { permissions: ["request.read"] })]);
    expect(await getRequestExecutionProjectIds("staff", undefined, db as never)).toEqual([]);
  });
  it("recipient batches use the exact staff predicate and one role load for all candidates", async () => {
    const db = fixture();
    expect(await getProjectRequestExecutorIds("board", db as never)).toEqual(["staff"]);
    expect(db.user.findMany).toHaveBeenCalledExactlyOnceWith({ where: { primaryDepartmentId: "dept", isBlocked: false, blockedAt: null }, select: { id: true } });
    expect(grants.load).toHaveBeenCalledExactlyOnceWith(db, ["staff", "reader"]);
    grants.load.mockResolvedValue([]);
    expect(await getProjectRequestExecutorIds("board", db as never)).toEqual([]);
  });
});
