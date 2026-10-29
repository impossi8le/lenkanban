import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { getTaskReadWhere } from "./project-access";
import { getProjectRequestExecutionPolicy } from "./project-request-execution-policy";

// Independent fixture evaluator, not PostgreSQL evidence. Unknown operators fail.
type Row = Record<string, unknown>;
function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === "OR") return (value as unknown[]).some(part => matches(row, part));
    if (key === "has") return Array.isArray(row) && row.includes(value);
    if (key === "isEmpty") return Array.isArray(row) && (row.length === 0) === value;
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item, value));
    if (key === "none") return Array.isArray(row) && !row.some(item => matches(item, value));
    if (key === "not") return !matches(row, value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (key === "notIn") return !(value as unknown[]).includes(row);
    if (!row || typeof row !== "object" || !(key in row)) throw new Error(`Unsupported fixture field ${key}`);
    return matches((row as Row)[key], value);
  });
}
const actor = { id: "reader", globalRole: "USER" as const };
const canonical = { contractVersion: 1, state: "SUBMITTED", authorId: "other", executorId: null, deletedAt: null, audienceUserIds: [] as string[] };
const project = { id: "board", ownerId: "owner", members: [], departmentId: "dept",
  department: { employees: [{ id: actor.id, isBlocked: false, blockedAt: null }], archivedAt: null, leaderId: null }, responsibleGroup: { leaderId: null, archivedAt: null, members: [] } };
function task(overrides: Row = {}): Row {
  return { projectId: "board", createdById: "other", request: null, assignees: [], watchers: [], project, ...overrides };
}
function fixture(ids = ["board", "other-board"]) {
  const boards = vi.fn(async (input: { where?: { id: string } }) => ids
    .filter(id => !input.where || id === input.where.id).map(id => ({ id })));
  const grants = vi.fn(async () => [] as Row[]);
  const groupGrants = vi.fn(async () => [] as Row[]);
  const database = { groupPrivilegeAssignment: { findMany: groupGrants }, project: { findMany: boards }, scopedPrivilegeAssignment: { findMany: grants } } as unknown as Parameters<typeof getTaskReadWhere>[2];
  return { boards, grants, groupGrants, database };
}
beforeEach(() => vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", ""));
afterEach(() => vi.unstubAllEnvs());

type Facts = { bound?: boolean; inDepartment?: boolean; departmentActive?: boolean; groupActive?: boolean;
  inGroup?: boolean; blocked?: boolean; blockedAt?: Date | null; permissions?: string[];
  scopeKind?: string; grantDepartmentId?: string | null; grantProjectId?: string | null;
  profileArchived?: boolean; visibility?: "own" | "board" };
function setup(facts: Facts = {}) {
  const x = { bound: true, inDepartment: true, departmentActive: true, groupActive: true,
    inGroup: true, blocked: false, blockedAt: null, permissions: ["request.execute"],
    scopeKind: "board", grantDepartmentId: null, grantProjectId: "board", profileArchived: false,
    visibility: "board", ...facts };
  const account = { id: actor.id, isBlocked: x.blocked, blockedAt: x.blockedAt,
    primaryDepartmentId: x.inDepartment ? "dept" : "other-dept",
    responsibleGroupMemberships: x.inGroup ? [{ groupId: "group", group: { archivedAt: x.groupActive ? null : new Date(0) } }] : [] };
  const board = { ...project, departmentId: x.bound ? "dept" : null,
    department: x.bound ? { id: "dept", archivedAt: x.departmentActive ? null : new Date(0), leaderId: null,
      employees: x.inDepartment ? [account] : [] } : null,
    responsibleGroupId: "group", responsibleGroup: { archivedAt: x.groupActive ? null : new Date(0), leaderId: null,
      members: x.inGroup ? [{ userId: actor.id, user: account }] : [] } };
  const f = fixture();
  const grant = { id: "execute", userId: actor.id, profileId: "profile", scopeKind: x.scopeKind,
    departmentId: x.grantDepartmentId, projectId: x.grantProjectId,
    profile: { archivedAt: x.profileArchived ? new Date(0) : null,
      permissions: x.visibility === "own" ? { permissions: x.permissions, visibility: "own" } : x.permissions } };
  f.grants.mockResolvedValue([grant]);
  const database = { ...f.database, project: { findMany: f.boards, findUnique: vi.fn(async () => board) },
    user: { findFirst: vi.fn(async ({ where }: { where: unknown }) => matches(account, where) ? { id: actor.id } : null) } } as unknown as Parameters<typeof getProjectRequestExecutionPolicy>[2] & Parameters<typeof getTaskReadWhere>[2];
  return { ...f, database, board, account, grant };
}

describe("foreign general visibility equals actual executor eligibility on every board", () => {
  it.each([
    ["bound department executor", {}, true],
    ["execute does not imply request.read dependency", { permissions: ["request.execute"] }, true],
    ["ordinary department staff", { permissions: [] }, false],
    ["read profile", { permissions: ["request.read"] }, false],
    ["manage profile", { permissions: ["request.manage"] }, false],
    ["execute outside staff despite group membership", { inDepartment: false }, false],
    ["archived bound department does not fall back to group", { departmentActive: false }, false],
    ["archived unrelated group does not remove valid department staff", { groupActive: false }, true],
    ["department staff need not join group", { inGroup: false }, true],
    ["blocked department staff", { blocked: true }, false],
    ["blocked timestamp department staff", { blockedAt: new Date(0) }, false],
    ["organization execute scope", { scopeKind: "organization", grantProjectId: null }, true],
    ["department execute scope", { scopeKind: "department", grantProjectId: null, grantDepartmentId: "dept" }, true],
    ["foreign department scope", { scopeKind: "department", grantProjectId: null, grantDepartmentId: "other-dept" }, false],
    ["foreign board scope", { grantProjectId: "other-board" }, false],
    ["archived profile", { profileArchived: true }, false],
    ["OWN execution permission uses same execution semantics", { visibility: "own" }, true],
    ["unbound responsible group executor", { bound: false, inDepartment: false }, true],
    ["unbound group needs explicit execute", { bound: false, permissions: ["request.read"] }, false],
    ["unbound nonmember", { bound: false, inGroup: false }, false],
    ["unbound archived group", { bound: false, groupActive: false }, false],
    ["unbound blocked member", { bound: false, blocked: true }, false],
    ["unbound blocked timestamp member", { bound: false, blockedAt: new Date(0) }, false],
    ["department scope never applies to unbound board", { bound: false, scopeKind: "department", grantProjectId: null, grantDepartmentId: "dept" }, false],
  ] as const)("%s", async (_label, facts, expected) => {
    const f = setup(facts as Facts);
    const policy = await getProjectRequestExecutionPolicy(actor.id, "board", f.database);
    const where = await getTaskReadWhere(actor, {}, f.database);
    expect(policy.canExecute).toBe(expected);
    expect(matches(task({ project: f.board, request: canonical }), where)).toBe(expected);
    expect(matches(task({ project: f.board }), where)).toBe(expected);
    // A positive execution fact never widens lifecycle or personal audience.
    for (const request of [{ ...canonical, state: "DRAFT" }, { ...canonical, deletedAt: new Date(0) },
      { ...canonical, audienceUserIds: ["other-recipient"] }]) {
      expect(matches(task({ project: f.board, request }), where)).toBe(false);
    }
    expect(matches(task({ project: f.board, request: { ...canonical, state: "CANCELLED" } }), where)).toBe(expected);
    expect(matches(task({ project: f.board, request: { ...canonical, authorId: actor.id } }), where)).toBe(true);
  });

  it("refreshes personal/group grants and staff on every read; personal participation survives revoke", async () => {
    const f = setup({ bound: false });
    f.grants.mockResolvedValue([]);
    const row = { ...f.grant, groupId: "grant-group", group: { archivedAt: null, members: [{ userId: actor.id }] } };
    f.groupGrants.mockResolvedValue([row]);
    const record = task({ project: f.board, request: canonical });
    expect(matches(record, await getTaskReadWhere(actor, {}, f.database))).toBe(true);
    f.groupGrants.mockResolvedValue([]);
    expect(matches(record, await getTaskReadWhere(actor, {}, f.database))).toBe(false);
    f.grants.mockResolvedValue([f.grant]);
    expect(matches(record, await getTaskReadWhere(actor, {}, f.database))).toBe(true);
    f.board.responsibleGroup.members = [];
    const revoked = await getTaskReadWhere(actor, {}, f.database);
    expect(matches(record, revoked)).toBe(false);
    expect(matches({ ...record, watchers: [{ userId: actor.id }] }, revoked)).toBe(true);
  });

  it("does not promote legacy owners, administrators, group/department leaders or direct audience to a personal grant", async () => {
    const f = setup({ permissions: ["request.read", "request.manage", "request.internal.read"] });
    const board = { ...f.board, ownerId: actor.id, members: [{ userId: actor.id, role: "PROJECT_ADMIN" }],
      department: { ...f.board.department!, leaderId: actor.id }, responsibleGroup: { ...f.board.responsibleGroup, leaderId: actor.id } };
    const where = await getTaskReadWhere(actor, {}, f.database);
    for (const request of [null, canonical, { ...canonical, audienceUserIds: [actor.id] }]) {
      expect(matches(task({ project: board, request }), where)).toBe(false);
    }
  });
});

it("explicit common-read sees submitted/archive common requests without execute, personal or drafts",async()=>{
 const f=setup({permissions:["request.read.common","request.return_for_revision"],bound:false,inGroup:false,inDepartment:false});
 const where=await getTaskReadWhere(actor,{},f.database);
 for(const state of ["SUBMITTED","IN_PROGRESS","NEEDS_INFO","COMPLETED","CLOSED","CANCELLED"]){expect(matches(task({project:f.board,request:{...canonical,state}}),where)).toBe(true);}
 expect(matches(task({project:f.board,request:{...canonical,state:"DRAFT"}}),where)).toBe(false);
 expect(matches(task({project:f.board,request:{...canonical,audienceUserIds:["other"]}}),where)).toBe(false);
 expect((await getProjectRequestExecutionPolicy(actor.id,"board",f.database)).canExecute).toBe(false);
 f.grant.profile.permissions=["request.read"];expect(matches(task({project:f.board,request:canonical}),await getTaskReadWhere(actor,{},f.database))).toBe(false);
});
