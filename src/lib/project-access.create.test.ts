import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { getProjectCreateAccess, requireProjectCreate } from "./project-access";

const actor = { id: "actor", globalRole: "USER" as const };
const nobody = { allEmployees: false, userIds: [] as string[], departmentIds: [] as string[], groupIds: [] as string[] };
function fixture(policy: unknown = nobody) {
  const project = vi.fn().mockResolvedValue({ ownerId: "owner", members: [], applicantPolicyConfig: { policy } });
  const user = vi.fn().mockResolvedValue({ id: actor.id, primaryDepartment: { id: "dept", archivedAt: null } });
  const groups = vi.fn().mockResolvedValue([]);
  const database = { project: { findUnique: project }, user: { findUnique: user }, responsibleGroupMember: { findMany: groups } };
  return { project, user, groups, database: database as unknown as Pick<Prisma.TransactionClient, "project" | "user" | "responsibleGroupMember"> };
}
beforeEach(() => vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", ""));
afterEach(() => vi.unstubAllEnvs());

describe("persisted applicant profile in the common access boundary (mock database)", () => {
  it.each([
    ["everyone", { ...nobody, allEmployees: true }, true],
    ["explicit user", { ...nobody, userIds: [actor.id] }, true],
    ["primary department", { ...nobody, departmentIds: ["dept"] }, true],
    ["other department", { ...nobody, departmentIds: ["parent"] }, false],
    ["nobody", nobody, false],
  ])("evaluates %s from saved policy and persisted subject facts", async (_name, policy, allowed) => {
    const f = fixture(policy);
    expect(await getProjectCreateAccess(actor, "board", f.database)).toEqual({ projectId: "board", canCreate: allowed });
  });
  it("does not infer applicant permission from ownership or ADMIN on a configured profile", async () => {
    const f = fixture();
    f.project.mockResolvedValue({ ownerId: actor.id, members: [{ role: "PROJECT_ADMIN" }], applicantPolicyConfig: { policy: nobody } });
    expect((await getProjectCreateAccess(actor, "board", f.database)).canCreate).toBe(false);
    expect((await getProjectCreateAccess({ ...actor, globalRole: "ADMIN" }, "board", f.database)).canCreate).toBe(false);
    await expect(requireProjectCreate(actor, "board", f.database)).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("refreshes group membership on every check and filters archived groups", async () => {
    const f = fixture({ ...nobody, groupIds: ["group"] });
    f.groups.mockResolvedValueOnce([{ groupId: "group" }]).mockResolvedValueOnce([]);
    expect((await requireProjectCreate(actor, "board", f.database)).canCreate).toBe(true);
    expect((await getProjectCreateAccess(actor, "board", f.database)).canCreate).toBe(false);
    expect(f.groups).toHaveBeenCalledWith({ where: { userId: actor.id, groupId: { in: ["group"] }, group: { archivedAt: null } }, select: { groupId: true }, take: 20 });
  });
  it("ignores archived primary department and caller-supplied metadata", async () => {
    const f = fixture({ ...nobody, departmentIds: ["dept"] });
    f.user.mockResolvedValue({ id: actor.id, primaryDepartment: { id: "dept", archivedAt: new Date() } });
    expect((await getProjectCreateAccess({ ...actor, primaryDepartmentId: "dept" } as typeof actor, "board", f.database)).canCreate).toBe(false);
  });
  it("permits legacy owner submission without granting project mutation rights", async () => {
    const f = fixture();
    f.project.mockResolvedValue({ ownerId: actor.id, members: [], applicantPolicyConfig: null });
    expect((await getProjectCreateAccess(actor, "board", f.database)).canCreate).toBe(true);
    expect(f.user).not.toHaveBeenCalled();
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "board");
    expect((await getProjectCreateAccess(actor, "board", f.database)).canCreate).toBe(true);
  });
  it.each([null, { ...nobody, userIds: "actor" }, { ...nobody, extra: true }])("fails closed on corrupt persisted profile %#", async policy => {
    const f = fixture(policy);
    await expect(getProjectCreateAccess(actor, "board", f.database)).rejects.toMatchObject({ name: "ConflictError" });
  });
  it("denies a missing board or subject and propagates storage failures", async () => {
    const f = fixture({ ...nobody, allEmployees: true });
    f.user.mockResolvedValue(null);
    expect((await getProjectCreateAccess(actor, "board", f.database)).canCreate).toBe(false);
    f.project.mockResolvedValueOnce(null);
    expect((await getProjectCreateAccess(actor, "board", f.database)).canCreate).toBe(false);
    f.project.mockRejectedValueOnce(Error("synthetic storage failure"));
    await expect(getProjectCreateAccess(actor, "board", f.database)).rejects.toThrow("synthetic storage failure");
  });
});

describe("universal submission to active departments", () => {
  function departmentFixture() {
    const f = fixture();
    const board = { ownerId: "other", members: [], applicantPolicyConfig: { policy: nobody }, department: { id: "dept", archivedAt: null as Date | null } };
    const subject = { id: actor.id, isBlocked: false, blockedAt: null as Date | null };
    f.project.mockImplementation(async () => board);f.user.mockImplementation(async () => subject);
    return { ...f, board, subject };
  }
  it("lets an ordinary employee submit to any active department without membership or applicant grants", async () => {
    const f=departmentFixture();expect((await getProjectCreateAccess(actor,"board",f.database)).canCreate).toBe(true);
    expect(f.user).toHaveBeenCalledWith({where:{id:actor.id},select:{id:true,isBlocked:true,blockedAt:true}});
    expect(f.groups).not.toHaveBeenCalled();
  });
  it.each(["blocked","blockedAt","board-archived","missing-user","wrong-user"])("does not grant department creation after %s",async kind=>{
    const f=departmentFixture();
    if(kind==="blocked")f.subject.isBlocked=true;
    if(kind==="blockedAt")f.subject.blockedAt=new Date();
    if(kind==="board-archived")f.board.department.archivedAt=new Date();
    if(kind==="missing-user")f.user.mockResolvedValue(null);
    if(kind==="wrong-user")f.subject.id="someone-else";
    expect((await getProjectCreateAccess(actor,"board",f.database)).canCreate).toBe(false);
  });
  it("uses persisted account state instead of forged client department/group or block flags",async()=>{
    const f=departmentFixture();f.subject.isBlocked=true;
    expect((await getProjectCreateAccess({...actor,primaryDepartmentId:"dept",responsibleGroupIds:["group"],isBlocked:false} as typeof actor,"board",f.database)).canCreate).toBe(false);
  });
  it("refreshes account and department revocation on each call",async()=>{
    const f=departmentFixture();expect((await getProjectCreateAccess(actor,"board",f.database)).canCreate).toBe(true);
    f.subject.isBlocked=true;expect((await getProjectCreateAccess(actor,"board",f.database)).canCreate).toBe(false);
    f.subject.isBlocked=false;f.board.department.archivedAt=new Date();expect((await getProjectCreateAccess(actor,"board",f.database)).canCreate).toBe(false);
  });
});
