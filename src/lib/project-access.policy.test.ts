import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findUnique: mocks.findUnique } } }));
import { NotFoundError } from "./errors";
import { getProjectReadWhere, getProjectAccess, requireProjectRead, requireProjectWrite, requireProjectMemberAdmin } from "./project-access";

const actor = { id: "actor", globalRole: "USER" as const };
function row(ownerId = "other", role: "MEMBER" | "PROJECT_ADMIN" | null = null) { return { id: "project", ownerId, members: role ? [{ role }] : [] }; }
const denied = { projectId: "project", canRead: false, canWrite: false, canManageMembers: false };
beforeEach(() => { mocks.findUnique.mockReset(); mocks.findUnique.mockResolvedValue(row()); });

describe("project access adapter retains its existing boolean-only contract", () => {
  it("ADMIN allows even an unloaded/missing project ID without default or injected DB queries", async () => {
    mocks.findUnique.mockRejectedValue(Error("Default database must not be queried"));
    const findUnique = vi.fn().mockRejectedValue(Error("Injected database must not be queried"));
    const database = { project: { findUnique } } as unknown as Pick<Prisma.TransactionClient, "project" | "user">;
    const expected = { projectId: "nonexistent", canRead: true, canWrite: true, canManageMembers: true };
    expect(await getProjectAccess({ ...actor, globalRole: "ADMIN" }, "nonexistent")).toEqual(expected);
    expect(await getProjectAccess({ ...actor, globalRole: "ADMIN" }, "nonexistent", database)).toEqual(expected);
    expect(mocks.findUnique).not.toHaveBeenCalled(); expect(findUnique).not.toHaveBeenCalled();
  });
  it.each([
    ["missing project", null, false, false, false],
    ["non-member", row(), false, false, false],
    ["ordinary member", row("other", "MEMBER"), true, true, false],
    ["project administrator", row("other", "PROJECT_ADMIN"), true, true, true],
    ["owner", row("actor"), true, true, true],
    ["owner with ordinary membership", row("actor", "MEMBER"), true, true, true],
  ] as const)("%s returns exactly projectId and three booleans", async (_title, project, canRead, canWrite, canManageMembers) => {
    mocks.findUnique.mockResolvedValue(project);
    const result = await getProjectAccess(actor, "project");
    expect(result).toEqual({ projectId: "project", canRead, canWrite, canManageMembers });
    expect(Object.keys(result).sort()).toEqual(["canManageMembers", "canRead", "canWrite", "projectId"]);
    expect(mocks.findUnique).toHaveBeenCalledOnce();
  });
  it("uses the supplied transaction's owner and bounded actor/group facts without global fallback or raw metadata grants", async () => {
    const findUnique = vi.fn().mockResolvedValue(Object.freeze({ ...row(), departmentId: "department", responsibleGroupId: "group", leaderId: "actor" }));
    const database = { project: { findUnique } } as unknown as Pick<Prisma.TransactionClient, "project" | "user">;
    const actorWithMetadata = { ...actor, primaryDepartmentId: "department" };
    expect(await getProjectAccess(actorWithMetadata, "project", database)).toEqual(denied);
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "project" }, select: {
      id: true, department: { select: { id: true, archivedAt: true } }, ownerId: true, members: { where: { userId: "actor" }, select: { role: true }, take: 1 },
      responsibleGroup: { select: { archivedAt: true, members: { where: { userId: "actor" }, select: { userId: true }, take: 1 } } },
    } });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
  it("propagates injected DB failures without successful fallback, retries or another identity query", async () => {
    const failure = Error("Synthetic transaction read failure"); const findUnique = vi.fn().mockRejectedValue(failure);
    const database = { project: { findUnique } } as unknown as Pick<Prisma.TransactionClient, "project" | "user">;
    await expect(getProjectAccess(actor, "project", database)).rejects.toBe(failure);
    expect(findUnique).toHaveBeenCalledOnce(); expect(mocks.findUnique).not.toHaveBeenCalled();
  });
  it("does not mutate frozen project membership facts returned by the database", async () => {
    const project = Object.freeze({ id: "project", ownerId: "other", members: Object.freeze([Object.freeze({ role: "MEMBER" })]) });
    mocks.findUnique.mockResolvedValue(project);
    expect(await getProjectAccess(Object.freeze(actor), "project")).toEqual({ ...denied, canRead: true, canWrite: true });
    expect(project.members[0].role).toBe("MEMBER");
  });
});

describe("legacy require wrappers", () => {
  it.each([requireProjectRead, requireProjectWrite, requireProjectMemberAdmin])("keeps NotFound on denied/missing access", async requireAccess => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(requireAccess(actor, "project")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("allows legacy member read/write but denies member administration", async () => {
    mocks.findUnique.mockResolvedValue(row("other", "MEMBER"));
    const expected = { ...denied, canRead: true, canWrite: true };
    expect(await requireProjectRead(actor, "project")).toEqual(expected);
    await expect(requireProjectWrite(actor, "project")).resolves.toEqual(expected);
    await expect(requireProjectMemberAdmin(actor, "project")).rejects.toBeInstanceOf(NotFoundError);
  });
  it.each([requireProjectRead, requireProjectWrite, requireProjectMemberAdmin])("allows owner management through the unchanged wrapper signature", async requireAccess => {
    mocks.findUnique.mockResolvedValue(row("actor"));
    expect(await requireAccess(actor, "project")).toEqual({ projectId: "project", canRead: true, canWrite: true, canManageMembers: true });
  });
  it.each([requireProjectRead, requireProjectWrite, requireProjectMemberAdmin])("propagates database errors instead of converting them to authorization decisions", async requireAccess => {
    const failure = Error("Synthetic database failure"); mocks.findUnique.mockRejectedValue(failure);
    await expect(requireAccess(actor, "project")).rejects.toBe(failure);
  });
});


describe("active department discovery is distinct from task authority", () => {
  it.each([null, { id: "actor", isBlocked: true, blockedAt: null }, { id: "actor", isBlocked: false, blockedAt: new Date() }, { id: "actor", isBlocked: false, blockedAt: null }])("uses a fresh persisted employee %#", async employee => {
    const user = vi.fn().mockResolvedValue(employee); const project = vi.fn().mockResolvedValue({ ...row(), department: { archivedAt: null } });
    const tx = { project: { findUnique: project }, user: { findUnique: user } } as unknown as Pick<Prisma.TransactionClient, "project" | "user">;
    expect(await getProjectAccess(actor, "project", tx)).toEqual({ ...denied, canRead: employee !== null && !employee.isBlocked && employee.blockedAt === null });
    expect(user).toHaveBeenCalledWith({ where: { id: actor.id }, select: { id: true, isBlocked: true, blockedAt: true } });
  });
  it("does not add universal discovery for archived departments", async () => {
    const user = vi.fn(); const project = vi.fn().mockResolvedValue({ ...row(), department: { archivedAt: new Date() } });
    const tx = { project: { findUnique: project }, user: { findUnique: user } } as unknown as Pick<Prisma.TransactionClient, "project" | "user">;
    expect(await getProjectAccess(actor, "project", tx)).toEqual(denied); expect(user).not.toHaveBeenCalled();
  });
});


describe("read-only role board discovery", () => {
  it.each(["personal", "group"] as const)("uses %s scoped read without write/admin access and refreshes revocation", async source => {
    const grant = { id: "assignment", userId: actor.id, groupId: "group", profileId: "profile", scopeKind: "board", projectId: "project", departmentId: null,
      profile: { id: "profile", archivedAt: null, permissions: ["request.read"] }, group: { archivedAt: null, members: [{ userId: actor.id }] } };
    const grants = vi.fn().mockResolvedValue([grant]);
    const database = { project: { findUnique: vi.fn().mockResolvedValue(row()) },
      user: { findUnique: vi.fn().mockResolvedValue({ id: actor.id, isBlocked: false, blockedAt: null }) },
      ...(source === "personal" ? { scopedPrivilegeAssignment: { findMany: grants } } : { groupPrivilegeAssignment: { findMany: grants } }),
    } as unknown as Parameters<typeof getProjectAccess>[2];
    expect(await getProjectAccess(actor, "project", database)).toEqual({ ...denied, canRead: true });
    expect(await getProjectReadWhere(actor, database)).toMatchObject({ OR: expect.arrayContaining([{ id: "project" }]) });
    grants.mockResolvedValue([{ ...grant, profile: { ...grant.profile, permissions: { permissions: ["request.read"], visibility: "own" } } }]);
    expect(await getProjectAccess(actor, "project", database)).toEqual(denied);
    grants.mockResolvedValue([{ ...grant, projectId: "other" }]);
    expect(await getProjectAccess(actor, "project", database)).toEqual(denied);
    grants.mockResolvedValue([]);
    expect(await getProjectAccess(actor, "project", database)).toEqual(denied);
    expect(await getProjectReadWhere(actor, database)).not.toMatchObject({ OR: expect.arrayContaining([{ id: "project" }]) });
  });
});
