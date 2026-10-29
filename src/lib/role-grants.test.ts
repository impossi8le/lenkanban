import { describe, expect, it, vi } from "vitest";
vi.mock("./prisma", () => ({ prisma: {} }));
import { loadRoleGrants, hasRolePermission, type RoleGrantDatabase } from "./role-grants";
function row(overrides: Record<string, unknown> = {}) {
  return { id: "grant", userId: "actor", profileId: "profile", scopeKind: "department", departmentId: "department", projectId: null,
    profile: { archivedAt: null, permissions: ["request.execute", "request.read"] }, ...overrides };
}
function fixture() {
  const state = { personal: [row()], groups: [{ ...row({ id: "group-grant" }), groupId: "group", group: { archivedAt: null, members: [{ userId: "actor" }] } }] };
  const database = { scopedPrivilegeAssignment: { findMany: vi.fn(async () => state.personal) },
    groupPrivilegeAssignment: { findMany: vi.fn(async () => state.groups) },
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => parts.join("").includes('FROM "GroupPrivilegeAssignment"') ? state.groups.flatMap(r => r.group.members.map(m => ({ id: r.id, userId: m.userId }))) : state.personal.map(r => ({ id: r.id }))),
  };
  return { state, database: database as unknown as RoleGrantDatabase, queries: database };
}
const scope = { projectId: "board", activeDepartmentId: "department" };
describe("fresh reusable group and personal role grants", () => {
  it("adds group and personal rights with provenance and exact scope", async () => {
    const f = fixture(); const grants = await loadRoleGrants(f.database, ["actor"]);
    expect(grants.map(g => [g.source, g.groupId])).toEqual([["personal", null], ["group", "group"]]);
    expect(hasRolePermission(grants, "actor", "request.execute", scope)).toBe(true);
    expect(hasRolePermission(grants, "other", "request.execute", scope)).toBe(false);
    expect(hasRolePermission(grants, "actor", "request.execute", { ...scope, activeDepartmentId: "elsewhere" })).toBe(false);
  });
  it("revokes group membership immediately while retaining personal rights", async () => {
    const f = fixture(); f.state.groups[0].group.members = [];
    expect(await loadRoleGrants(f.database, ["actor"])).toMatchObject([{ source: "personal" }]);
    f.state.personal = []; expect(await loadRoleGrants(f.database, ["actor"])).toEqual([]);
  });
  it("canonical decoder supports own visibility and rejects unrecognized permissions", async () => {
    const f = fixture(); f.state.groups = [];
    f.state.personal = [row({ scopeKind: "board", departmentId: null, projectId: "board", profile: { archivedAt: null, permissions: { visibility: "own", permissions: ["request.execute"] } } })];
    expect(await loadRoleGrants(f.database, ["actor"])).toMatchObject([{ visibility: "own", permissions: ["request.execute"] }]);
    f.state.personal = [row({ profile: { archivedAt: null, permissions: ["unknown.permission"] } })];
    expect(await loadRoleGrants(f.database, ["actor"])).toEqual([]);
  });
  it.each([
    { profile: { archivedAt: new Date(), permissions: ["request.execute"] } },
    { scopeKind: "organization", departmentId: "department" },
    { scopeKind: "board", departmentId: "department", projectId: "board" },
  ])("denies archived or malformed authority %j", async overrides => {
    const f = fixture(); f.state.groups = []; f.state.personal = [row(overrides)];
    expect(await loadRoleGrants(f.database, ["actor"])).toEqual([]);
  });
  it("locks grant/profile/group/member rows and only uses locked membership pairs", async () => {
    const f = fixture(); f.queries.$queryRaw.mockResolvedValueOnce([{ id: "grant" }] as never).mockResolvedValueOnce([]);
    expect(await loadRoleGrants(f.database, ["actor"], { lock: true })).toMatchObject([{ source: "personal" }]);
    expect(f.queries.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.queries.$queryRaw.mock.calls[1][0].join("")).toContain("FOR SHARE OF a, p, g, m");
  });
  it("propagates storage failure and never invents a role", async () => {
    const f = fixture(); f.queries.scopedPrivilegeAssignment.findMany.mockRejectedValueOnce(new Error("offline"));
    await expect(loadRoleGrants(f.database, ["actor"])).rejects.toThrow("offline");
  });
});

it("approval authority is exact-board only and disappears after group membership revocation",async()=>{
 const f=fixture();f.state.groups=[];
 f.state.personal=[row({scopeKind:"organization",departmentId:null,profile:{archivedAt:null,permissions:["request.approve"]}})];expect(hasRolePermission(await loadRoleGrants(f.database,["actor"]),"actor","request.approve",scope)).toBe(false);
 f.state.personal=[row({scopeKind:"board",departmentId:null,projectId:"board",profile:{archivedAt:null,permissions:["request.approve"]}})];const grants=await loadRoleGrants(f.database,["actor"]);expect(hasRolePermission(grants,"actor","request.approve",scope)).toBe(true);expect(hasRolePermission(grants,"actor","request.approve",{...scope,projectId:"elsewhere"})).toBe(false);expect(hasRolePermission(grants,"actor","request.execute",scope)).toBe(false);
});
