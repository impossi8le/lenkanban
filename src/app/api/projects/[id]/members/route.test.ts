import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  manage: vi.fn(),
  findMany: vi.fn(),
  findUniqueMember: vi.fn(),
  upsert: vi.fn(),
  findProject: vi.fn(),
  findUser: vi.fn(),
  findUsers: vi.fn(),
  findPolicyMemberships: vi.fn(),
  notify: vi.fn(),
  emitUpdated: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    projectMember: {
      findMany: mocks.findMany,
      findUnique: mocks.findUniqueMember,
      upsert: mocks.upsert,
    },
    project: { findUnique: mocks.findProject },
    user: { findUnique: mocks.findUser, findMany: mocks.findUsers },
    responsibleGroupMember: { findMany: mocks.findPolicyMemberships },
  },
}));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.auth,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
// The access policy itself is covered by src/lib/project-access.policy.test.ts;
// this suite asserts which boundary each HTTP verb is wired to.
vi.mock("@/lib/project-access", () => ({
  requireProjectRead: mocks.read,
  requireProjectMemberAdmin: mocks.manage,
}));
vi.mock("@/lib/notification-triggers", () => ({ notifyProjectMemberAdded: mocks.notify }));
vi.mock("@/socket/board-events", () => ({ emitProjectMembersUpdated: mocks.emitUpdated }));

import { NotFoundError } from "@/lib/errors";
import { UnauthorizedError } from "@/lib/require-api-user";
import { GET, POST } from "./route";

const createdAt = new Date("2026-10-01T00:00:00.000Z");
const member = {
  id: "member-1",
  role: "MEMBER",
  createdAt,
  user: { id: "user-1", email: "member@example.invalid", name: "Member", avatarUrl: null, globalRole: "USER" },
};
const addedBy = { id: "admin-1", email: "admin@example.invalid", name: "Admin" };
const owner = { id: "owner-1", email: "owner@example.invalid", name: "Owner", avatarUrl: null, globalRole: "USER" };

const params = () => ({ params: Promise.resolve({ id: "project-1" }) });
const read = () => new Request("http://localhost/api/projects/project-1/members");
const add = (body: unknown) =>
  new Request("http://localhost/api/projects/project-1/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "user-1", globalRole: "USER", email: "member@example.invalid", name: "Member" });
  mocks.read.mockResolvedValue({ projectId: "project-1", canRead: true, canWrite: true, canManageMembers: false });
  mocks.manage.mockResolvedValue({ projectId: "project-1", canRead: true, canWrite: true, canManageMembers: true });
  mocks.findMany.mockResolvedValue([member]);
  mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner });
  mocks.findUser.mockResolvedValue({ id: "user-2" });
  mocks.findUsers.mockResolvedValue([]);
  mocks.findPolicyMemberships.mockResolvedValue([]);
  mocks.findUniqueMember.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({ ...member, user: { ...member.user, id: "user-2" } });
  // The route chains .catch() on the notification promise.
  mocks.notify.mockResolvedValue(undefined);
});

describe("reading the roster is part of reading the project", () => {
  it("serves a member who can read but cannot manage the project", async () => {
    const response = await GET(read(), params());

    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1" }), "project-1");
    expect(mocks.manage).not.toHaveBeenCalled();
    const body = await response.json();
    // JSON serialization turns the mocked Date into an ISO string.
    expect(body.data).toEqual({
      projectId: "project-1",
      ownerId: owner.id,
      owner,
      items: [{ ...member, createdAt: createdAt.toISOString() }],
    });
  });

  it("omits management-only fields from the reader's payload", async () => {
    const response = await GET(read(), params());

    const select = mocks.findMany.mock.calls[0][0].select;
    expect(Object.keys(select)).not.toContain("addedBy");
    expect(Object.keys(select.user.select)).not.toContain("globalRole");
    expect(Object.keys(select.user.select)).not.toContain("primaryDepartment");
    expect(mocks.findProject.mock.calls[0][0].select).not.toHaveProperty("responsibleGroup");
    const body = (await response.json()).data;
    expect(body).not.toHaveProperty("responsibleGroup");
    expect(select).toMatchObject({ id: true, role: true, createdAt: true, user: { select: { email: true } } });
    expect(Object.keys(mocks.findProject.mock.calls[0][0].select.owner.select)).not.toContain("globalRole");
    expect(body).not.toHaveProperty("memberFunctions");
    expect(body).not.toHaveProperty("functionContext");
    expect(mocks.findUsers).not.toHaveBeenCalled();
    expect(mocks.findPolicyMemberships).not.toHaveBeenCalled();
  });

  it("reports actual board-scoped leadership and evaluates applicant sources without granting permissions", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canWrite: false, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      department: { id: "department-1", name: "ИТ", leaderId: member.user.id, archivedAt: null },
      responsibleGroup: { id: "group-1", name: "Поддержка", leaderId: owner.id, archivedAt: null, members: [] },
      applicantPolicyConfig: { policy: { allEmployees: false, userIds: [owner.id], departmentIds: ["department-1"], groupIds: ["applicants"] } } });
    mocks.findUsers.mockResolvedValue([
      { id: member.user.id, primaryDepartment: { id: "department-1", archivedAt: null } },
      { id: owner.id, primaryDepartment: null },
    ]);
    const response = await GET(read(), params());
    expect(response.status).toBe(200);
    const body = (await response.json()).data;
    expect(body.memberFunctions).toEqual([
      { userId: member.user.id, leadership: [{ kind: "department", id: "department-1", name: "ИТ" }], applicant: { allowed: true, source: "primary_department" } },
      { userId: owner.id, leadership: [{ kind: "group", id: "group-1", name: "Поддержка" }], applicant: { allowed: true, source: "explicit_user" } },
    ]);
    expect(body.responsibleGroup.memberUserIds).toEqual([]); // leadership never implies group membership
    expect(body.functionContext).toEqual({ applicantPolicyConfigured: true, departmentLeadershipAssigned: true, groupLeadershipAssigned: true });
    expect(mocks.findUsers.mock.calls[0][0].where).toEqual({ id: { in: [member.user.id, owner.id] } });
    expect(mocks.findPolicyMemberships).toHaveBeenCalledWith({ where: { userId: { in: [member.user.id, owner.id] }, groupId: { in: ["applicants"] }, group: { archivedAt: null } }, select: { userId: true, groupId: true } });
    expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled(); expect(mocks.emitUpdated).not.toHaveBeenCalled();
  });

  it("does not invent applicants from MEMBER, ownership, absent policy or unrelated leadership", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    const body = (await (await GET(read(), params())).json()).data;
    expect(body.memberFunctions).toEqual([member.user.id, owner.id].map(userId => ({ userId, leadership: [], applicant: { allowed: null, source: "unconfigured" } })));
    expect(body.functionContext).toEqual({ applicantPolicyConfigured: false, departmentLeadershipAssigned: null, groupLeadershipAssigned: null });
    expect(mocks.findUsers).not.toHaveBeenCalled(); expect(mocks.findPolicyMemberships).not.toHaveBeenCalled();
  });

  it("excludes archived leadership and department applicants and reports an explicit policy denial", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      department: { id: "department-1", name: "Archived", leaderId: member.user.id, archivedAt: createdAt },
      responsibleGroup: { id: "group-1", name: "Archived", leaderId: owner.id, archivedAt: createdAt, members: [] },
      applicantPolicyConfig: { policy: { allEmployees: false, userIds: [], departmentIds: ["department-1"], groupIds: [] } } });
    mocks.findUsers.mockResolvedValue([{ id: member.user.id, primaryDepartment: { id: "department-1", archivedAt: createdAt } }, { id: owner.id, primaryDepartment: null }]);
    const body = (await (await GET(read(), params())).json()).data;
    expect(body.memberFunctions).toEqual([member.user.id, owner.id].map(userId => ({ userId, leadership: [], applicant: { allowed: false, source: "not_in_policy" } })));
    expect(body.responsibleGroup).toBeNull(); expect(body.functionContext.departmentLeadershipAssigned).toBeNull();
  });

  it("uses active policy-group membership rather than the board responsible group to identify an applicant", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      applicantPolicyConfig: { policy: { allEmployees: false, userIds: [], departmentIds: [], groupIds: ["applicants"] } } });
    mocks.findUsers.mockResolvedValue([{ id: member.user.id, primaryDepartment: null }]);
    mocks.findPolicyMemberships.mockResolvedValue([{ userId: member.user.id, groupId: "applicants" }]);
    const body = (await (await GET(read(), params())).json()).data;
    expect(body.memberFunctions[0].applicant).toEqual({ allowed: true, source: "responsible_group" });
    expect(body.memberFunctions[1].applicant).toEqual({ allowed: null, source: "unavailable" });
    expect(body.responsibleGroup).toBeNull();
  });

  it("reports a saved all-employees policy without promoting MEMBER or administrative access", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canWrite: false, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      applicantPolicyConfig: { policy: { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] } } });
    mocks.findUsers.mockResolvedValue([{ id: member.user.id, primaryDepartment: null }, { id: owner.id, primaryDepartment: null }]);
    const body = (await (await GET(read(), params())).json()).data;
    expect(body.memberFunctions.map((fact: { applicant: unknown }) => fact.applicant)).toEqual([
      { allowed: true, source: "all_employees" }, { allowed: true, source: "all_employees" },
    ]);
    expect(mocks.findPolicyMemberships).not.toHaveBeenCalled();
    expect(mocks.manage).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("keeps a failing factual-context read inside the existing safe API failure response", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      applicantPolicyConfig: { policy: { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] } } });
    mocks.findUsers.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_CONTEXT_TOKEN_104"));
    const response = await GET(read(), params());
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Не удалось загрузить участников проекта");
    expect(body).not.toContain("SYNTHETIC_PRIVATE_CONTEXT_TOKEN_104");
    expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled(); expect(mocks.emitUpdated).not.toHaveBeenCalled();
  });

  it.each([null, { allEmployees: true, userIds: ["invalid"], departmentIds: [], groupIds: [] }])("fails safely on invalid saved applicant policy %j", async policy => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner, applicantPolicyConfig: { policy } });
    const response = await GET(read(), params());
    expect(response.status).toBe(500); expect((await response.json()).data).toBeUndefined();
    expect(mocks.findUsers).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("keeps management-only fields for a project admin", async () => {
    mocks.read.mockResolvedValue({ projectId: "project-1", canRead: true, canWrite: true, canManageMembers: true });
    mocks.findMany.mockResolvedValue([{ ...member, addedBy }]);

    const response = await GET(read(), params());

    expect(response.status).toBe(200);
    expect(mocks.findMany.mock.calls[0][0].select.addedBy).toEqual({ select: { id: true, email: true, name: true } });
    expect(mocks.findMany.mock.calls[0][0].select.user.select.globalRole).toBe(true);
    expect(mocks.findProject.mock.calls[0][0].select.owner.select.globalRole).toBe(true);
    expect((await response.json()).data.items[0].addedBy).toEqual(addedBy);
  });

  it("gives managers factual group and department context without unrelated group members", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findMany.mockResolvedValue([{ ...member, user: { ...member.user,
      primaryDepartment: { id: "department-1", name: "Заявители", archivedAt: null } } }]);
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      responsibleGroup: { id: "group-1", name: "Поддержка", archivedAt: null, members: [{ userId: member.user.id }] } });
    const response = await GET(read(), params());
    const body = (await response.json()).data;
    expect(body.responsibleGroup).toEqual({ id: "group-1", name: "Поддержка", memberUserIds: [member.user.id] });
    expect(body.items[0].user.primaryDepartment.name).toBe("Заявители");
    expect(mocks.findProject.mock.calls[1][0].select.responsibleGroup.select.members).toEqual({
      where: { userId: { in: [member.user.id, owner.id] } }, select: { userId: true },
    });
  });

  it("does not present an archived responsible group as active", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      responsibleGroup: { id: "group-1", name: "Archived", archivedAt: createdAt, members: [] } });
    const response = await GET(read(), params());
    expect((await response.json()).data.responsibleGroup).toBeNull();
  });

  it("includes a group member owner without requiring duplicate project membership", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockImplementation(async ({ select }) => {
      if (!select.responsibleGroup) return { id: "project-1", ownerId: owner.id, owner };
      const selectedIds = select.responsibleGroup.select.members.where.userId.in as string[];
      return { responsibleGroup: { id: "group-1", name: "Поддержка", archivedAt: null,
        members: [owner.id, "unrelated-group-member"].filter(id => selectedIds.includes(id)).map(userId => ({ userId })) } };
    });

    const response = await GET(read(), params());
    const body = (await response.json()).data;

    expect(body.items.map((item: typeof member) => item.user.id)).toEqual([member.user.id]);
    expect(body.responsibleGroup.memberUserIds).toEqual([owner.id]);
    expect(mocks.findProject.mock.calls[1][0].select.responsibleGroup.select.members.where.userId.in)
      .toEqual([member.user.id, owner.id]);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not infer group membership for an owner outside the group", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      responsibleGroup: { id: "group-1", name: "Поддержка", archivedAt: null, members: [] } });
    const response = await GET(read(), params());
    expect((await response.json()).data.responsibleGroup.memberUserIds).toEqual([]);
  });

  it("does not expose an owner's membership in an archived group", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      responsibleGroup: { id: "group-1", name: "Archived", archivedAt: createdAt, members: [{ userId: owner.id }] } });
    expect((await (await GET(read(), params())).json()).data.responsibleGroup).toBeNull();
  });

  it("does not duplicate the owner ID when the owner is also in the roster", async () => {
    mocks.read.mockResolvedValue({ canRead: true, canManageMembers: true });
    mocks.findMany.mockResolvedValue([{ ...member, user: owner }]);
    mocks.findProject.mockResolvedValue({ id: "project-1", ownerId: owner.id, owner,
      responsibleGroup: { id: "group-1", name: "Поддержка", archivedAt: null, members: [{ userId: owner.id }] } });
    await GET(read(), params());
    expect(mocks.findProject.mock.calls[1][0].select.responsibleGroup.select.members.where.userId.in).toEqual([owner.id]);
  });

  it("rejects an unauthenticated roster read before querying identities or groups", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    const response = await GET(read(), params());
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.findProject).not.toHaveBeenCalled();
  });

  it("stays a 404 for a project the actor cannot read and reads no roster", async () => {
    mocks.read.mockRejectedValue(new NotFoundError());

    const response = await GET(read(), params());

    expect(response.status).toBe(404);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("managing the roster stays admin-only", () => {
  it("rejects a reader with the same 404 and writes nothing", async () => {
    mocks.manage.mockRejectedValue(new NotFoundError());

    const response = await POST(add({ email: "new@example.invalid" }), params());

    expect(response.status).toBe(404);
    expect(mocks.manage).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1" }), "project-1");
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.emitUpdated).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("adds the member and emits the update for a project admin", async () => {
    const response = await POST(add({ email: "New@Example.invalid", role: "PROJECT_ADMIN" }), params());

    expect(response.status).toBe(201);
    expect(mocks.findUser).toHaveBeenCalledWith(expect.objectContaining({ where: { email: "new@example.invalid" } }));
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ projectId: "project-1", userId: "user-2", role: "PROJECT_ADMIN" }),
    }));
    expect(mocks.emitUpdated).toHaveBeenCalledWith("project-1", expect.objectContaining({ id: "member-1" }));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("keeps unauthenticated roster writes as 401", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());

    const response = await POST(add({ email: "new@example.invalid" }), params());

    expect(response.status).toBe(401);
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
