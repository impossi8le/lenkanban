import { Prisma, type PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrganizationReader } from "./organization-reader";
import { privilegeAssignmentId } from "./organization-command";
import { ORGANIZATION_PRIVILEGE_PERMISSIONS } from "./organization-contract";

const actorId = "admin";
afterEach(() => vi.unstubAllEnvs());
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
type Profile = { id: string; name: string; permissions: unknown; archivedAt: Date | null };
type Assignment = { id: string; userId: string; profileId: string; scopeKind: string; departmentId: string | null; projectId: string | null; profile: { id: string; permissions: unknown; archivedAt: Date | null } };
type ListQuery = { where: { userId?: string | { in: string[] }; id?: { gt: string }; archivedAt?: null | { not: null } }; take?: number; select?: { profile?: unknown } };
function assignment(index: number): Assignment {
  const profileId = `profile${String(index).padStart(3, "0")}`;
  return { id: privilegeAssignmentId("subject", profileId, "organization", null, null), userId: "subject", profileId, scopeKind: "organization", departmentId: null, projectId: null,
    profile: { id: profileId, permissions: ["request.read"], archivedAt: null } };
}
function fixture() {
  let actorRole: string | null = "ADMIN";
  const profiles: Profile[] = Array.from({ length: 123 }, (_, index) => ({ id: `profile${String(index).padStart(3, "0")}`, name: `Profile ${index}`, permissions: ["request.read"], archivedAt: null }));
  const assignments = Array.from({ length: 75 }, (_, index) => assignment(index)).sort((a, b) => a.id.localeCompare(b.id));
  const subject = { id: "subject", name: ` ${"n".repeat(200)} `, globalRole: "USER", primaryDepartment: { id: "other-dept", archivedAt: null as Date | null }, email: "synthetic-private@example.invalid" };
  const project = { id: "board", name: " Board ", ownerId: "other", departmentId: "dept", department: { id: "dept", archivedAt: null as Date | null }, members: [] as { role: "MEMBER" | "PROJECT_ADMIN" }[],
    responsibleGroup: null as { archivedAt: Date | null; members: { userId: string }[] } | null,
    applicantPolicyConfig: { policy: { allEmployees: false, userIds: [] as string[], departmentIds: [] as string[], groupIds: [] as string[] } } as { policy: unknown } | null, description: "synthetic-private-description" };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select: { name?: boolean; globalRole?: boolean } }) => select.globalRole && !select.name
      ? actorRole === null ? null : { globalRole: actorRole } : where.id === "subject" ? subject : null), update: vi.fn() },
    project: { findUnique: vi.fn(async (): Promise<typeof project | null> => project), update: vi.fn() },
    privilegeProfile: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => profiles.find(row => row.id === where.id) ?? null),
      findMany: vi.fn(async ({ where, take }: ListQuery) => profiles.filter(row => (!where.id || row.id > where.id.gt)
      && (where.archivedAt === undefined || (where.archivedAt === null ? row.archivedAt === null : row.archivedAt !== null))).slice(0, take)), create: vi.fn(), update: vi.fn() },
    scopedPrivilegeAssignment: { findMany: vi.fn(async ({ where, take, select }: ListQuery) => assignments.filter(row => (typeof where.userId === 'object' ? where.userId.in.includes(row.userId) : row.userId === where.userId) && (!where.id || row.id > where.id.gt)).slice(0, take)
      .map(row => select?.profile ? row : Object.fromEntries(Object.entries(row).filter(([key]) => key !== "profile")))), create: vi.fn(), deleteMany: vi.fn() },
    responsibleGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    organizationState: { findUnique: vi.fn().mockResolvedValue({ version: 4 }), upsert: vi.fn(), update: vi.fn() },
    organizationOperation: { create: vi.fn() },
  };
  const transaction = vi.fn(async (read: (value: typeof tx) => Promise<unknown>) => read(tx));
  const reader = createOrganizationReader({ $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">);
  const run = (kind: "profiles" | "assignments" | "preview") => kind === "profiles" ? reader.privilegeProfiles({ actorId }) : kind === "assignments"
    ? reader.privilegeAssignments({ actorId, userId: "subject" }) : reader.privilegePreview({ actorId, userId: "subject", projectId: "board" });
  return { reader, run, tx, transaction, profiles, assignments, project, subject, setRole: (value: string | null) => { actorRole = value; } };
}

describe("privilege saved configuration/preview readers (mock DB protocol)", () => {
  it.each([
    ["USER", "other", null, false, false, false, "no_project_access"],
    ["USER", "subject", null, true, true, true, "project_owner"],
    ["USER", "other", "PROJECT_ADMIN", true, true, true, "project_admin"],
    ["USER", "other", "MEMBER", true, true, false, "project_member"],
    ["ADMIN", "other", null, true, true, true, "global_admin"],
  ] as const)("explains current project rights for %s/%s/%s with and without OWN", async (role, ownerId, membershipRole, canRead, canWrite, canManageMembers, source) => {
    const f = fixture(); f.subject.globalRole = role; f.project.ownerId = ownerId;
    f.project.members = membershipRole ? [{ role: membershipRole }] : [];
    for (const own of [false, true]) {
      vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", own ? "board" : "");
      const result = await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" });
      expect(result.legacy).toEqual({ canRead, canWrite, canManageMembers });
      expect(result.effective).toMatchObject({
        project: {
          canRead: { allowed: canRead, source },
          canWrite: { allowed: canWrite && (!own || role === "ADMIN"), source: own && role !== "ADMIN" && canWrite ? "own_write_restricted" : source },
          canManageMembers: { allowed: canManageMembers, source },
        },
        taskReadPolicy: "personal_or_executor",
        scopedRequestReadApplied: false,
        taskAndDiscussionAccess: "requires_resource_check",
      });
    }
  });
  it("explains every assignment including archived and outside-scope profiles without interpreting names as rights", async () => {
    const f = fixture(); vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "board");
    f.assignments.splice(3);
    const [org, department, board] = f.assignments;
    org.profile.permissions = ["request.internal.read"];
    department.scopeKind = "department"; department.departmentId = "other-dept";
    department.id = privilegeAssignmentId("subject", department.profileId, "department", "other-dept", null);
    board.scopeKind = "board"; board.projectId = "board"; board.profile.archivedAt = new Date();
    board.id = privilegeAssignmentId("subject", board.profileId, "board", null, "board");
    const result = await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" });
    expect(result.effective?.assignmentSources).toEqual([
      { source: 'personal', groupId: null, assignmentId: org.id, profileId: org.profileId, scopeKind: "organization", departmentId: null, projectId: null, permissions: ["request.internal.read"], reason: "matching" },
      { source: 'personal', groupId: null, assignmentId: department.id, profileId: department.profileId, scopeKind: "department", departmentId: "other-dept", projectId: null, permissions: ["request.read"], reason: "outside_scope" },
      { source: 'personal', groupId: null, assignmentId: board.id, profileId: board.profileId, scopeKind: "board", departmentId: null, projectId: "board", permissions: ["request.read"], reason: "profile_archived" },
    ]);
    expect(result.scoped.internalRead).toEqual({ allowed: false, source: "requires_request_read", assignmentIds: [org.id] });
    expect(result.effective?.scopedRequestReadApplied).toBe(false);
    expect(result.effective?.project.canWrite.allowed).toBe(false);
  });
  it("does not return a successful explanation for malformed OWN configuration", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "board,*");
    await expect(fixture().run("preview")).rejects.toThrow("INVALID_OWN_TASK_POLICY");
  });
  it.each(["profiles", "assignments", "preview"] as const)("%s uses shared topology/actor lock then fresh ADMIN/version", async kind => {
    const f = fixture(); await f.run(kind);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(f.tx.$queryRaw.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock_shared"); expect(f.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(["organization-topology-v1"]);
    expect(f.tx.$queryRaw.mock.calls[1][0].join("?")).toContain('FROM "User" WHERE "id" = ? FOR SHARE');
    expect(f.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(f.tx.user.findUnique.mock.invocationCallOrder[0]); expect(f.tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(f.tx.organizationState.findUnique.mock.invocationCallOrder[0]);
  });
  it.each(["profiles", "assignments", "preview"] as const)("%s denies ordinary identity before version or saved facts", async kind => {
    const f = fixture(); f.setRole("USER"); await expect(f.run(kind)).rejects.toMatchObject({ name: "ForbiddenError" }); expect(f.tx.organizationState.findUnique).not.toHaveBeenCalled(); expect(f.tx.privilegeProfile.findMany).not.toHaveBeenCalled(); expect(f.tx.scopedPrivilegeAssignment.findMany).not.toHaveBeenCalled();
  });
  it.each(["profiles", "assignments"] as const)("walks more than fifty %s without losing sentinel or duplicate rows", async kind => {
    const f = fixture(); const ids: string[] = [], sizes: number[] = []; let cursor: string | undefined;
    do {
      const page = kind === "profiles" ? await f.reader.privilegeProfiles({ actorId, cursor }) : await f.reader.privilegeAssignments({ actorId, userId: "subject", cursor });
      ids.push(...page.items.map(row => row.id)); sizes.push(page.items.length); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(sizes).toEqual(kind === "profiles" ? [50, 50, 23] : [50, 25]); expect(ids).toEqual((kind === "profiles" ? f.profiles : f.assignments).map(row => row.id)); expect(new Set(ids).size).toBe(ids.length);
  });
  it("binds profile cursors to kind/archive/version and assignment cursors to exact user", async () => {
    const f = fixture(); const first = await f.reader.privilegeProfiles({ actorId, archived: "active", limit: 1 });
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual({ kind: "privilegeProfiles", id: "profile000", archived: "active", version: 4 });
    const assignments = await f.reader.privilegeAssignments({ actorId, userId: "subject", limit: 1 }); f.transaction.mockClear();
    for (const run of [() => f.reader.privilegeProfiles({ actorId, archived: "all", cursor: first.nextCursor! }),
      () => f.reader.privilegeAssignments({ actorId, userId: "other", cursor: assignments.nextCursor! }),
      () => f.reader.privilegeAssignments({ actorId, userId: "subject", cursor: first.nextCursor! })]) expect(run).toThrowError(expect.objectContaining({ name: "ValidationError" }));
    expect(f.transaction).not.toHaveBeenCalled();
    f.tx.organizationState.findUnique.mockResolvedValue({ version: 5 }); f.tx.privilegeProfile.findMany.mockClear(); await expect(f.reader.privilegeProfiles({ actorId, archived: "active", cursor: first.nextCursor! })).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.privilegeProfile.findMany).not.toHaveBeenCalled();
  });
  it("filters archive state, requires canonical saved permissions and exact assignment identities", async () => {
    const f = fixture(); f.profiles[0].archivedAt = new Date(); expect((await f.reader.privilegeProfiles({ actorId, archived: "archived" })).items).toHaveLength(1);
    expect(f.tx.privilegeProfile.findMany).toHaveBeenCalledWith({ where: { archivedAt: { not: null } }, select: { id: true, name: true, permissions: true, archivedAt: true }, orderBy: { id: "asc" }, take: 51 });
    f.profiles[0].permissions = ["request.read", "request.read"]; await expect(f.reader.privilegeProfiles({ actorId })).rejects.toMatchObject({ name: "ConflictError" });
    f.assignments[0].id = "f".repeat(64); await expect(f.reader.privilegeAssignments({ actorId, userId: "subject" })).rejects.toMatchObject({ name: "ConflictError" });
  });
  it("explains explicit bound-group read without inventing legacy or scoped write grants", async () => {
    const f = fixture();f.assignments.splice(0);
    f.project.responsibleGroup = { archivedAt: null, members: [{ userId: "subject" }] };
    const result = await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" });
    expect(result.effective.project).toEqual({
      canRead: { allowed: true, source: "responsible_group_read" },
      canWrite: { allowed: false, source: "no_project_access" },
      canManageMembers: { allowed: false, source: "no_project_access" },
    });
    expect(result.legacy).toEqual({ canRead: false, canWrite: false, canManageMembers: false });
    expect(result.scoped.requestRead.allowed).toBe(false);
    f.project.responsibleGroup.archivedAt = new Date();
    expect((await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" })).effective.project.canRead.allowed).toBe(false);
  });
  it("keeps legacy/applicant/scoped decisions separate with minimized user/project DTOs", async () => {
    const f = fixture(); const result = await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" });
    expect(result).toMatchObject({ project: { id: "board", displayName: "Board", departmentId: "dept" }, subject: { id: "subject", displayName: "n".repeat(120) }, legacy: { canRead: false, canWrite: false, canManageMembers: false }, applicant: { allowed: false, source: "not_in_policy" }, scoped: { requestRead: { allowed: true, source: "assignment" }, internalRead: { allowed: false, source: "none" } }, version: 4 });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|email|globalRole|description|ownerId/);
    expect(f.tx.scopedPrivilegeAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "subject" }, select: { id: true, userId: true, profileId: true, scopeKind: true, departmentId: true, projectId: true, profile: { select: { id: true, permissions: true, archivedAt: true } } } }));
    f.subject.globalRole = "ADMIN"; const admin = await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" }); expect(admin.scoped.requestRead.source).toBe("global_admin"); expect(admin.legacy.canRead).toBe(true); expect(admin.applicant.allowed).toBe(false);
  });
  it("rejects more than100 grants, accepts100, and never returns a truncated permission decision", async () => {
    const f = fixture(); f.assignments.splice(0, f.assignments.length, ...Array.from({ length: 101 }, (_, i) => assignment(i)).sort((a, b) => a.id.localeCompare(b.id)));
    await expect(f.run("preview")).rejects.toMatchObject({ name: "ConflictError" }); f.assignments.pop();
    expect((await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" })).scoped.requestRead.assignmentIds).toHaveLength(100);
  });
  it("archived profiles and inactive project departments stop matching without inheriting subject department", async () => {
    const f = fixture(); f.assignments.splice(1); const grant = f.assignments[0]; grant.scopeKind = "department"; grant.departmentId = "dept"; grant.id = privilegeAssignmentId("subject", grant.profileId, "department", "dept", null);
    f.project.department.archivedAt = new Date(); f.subject.primaryDepartment.id = "dept";
    expect((await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" })).scoped.requestRead.allowed).toBe(false);
    f.project.department.archivedAt = null; grant.profile.archivedAt = new Date(); expect((await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" })).scoped.requestRead.allowed).toBe(false);
  });
  it("fails closed on malformed profile permissions or relation mismatch even if the profile is archived", async () => {
    const f = fixture(); f.assignments[0].profile.permissions = ["unknown"]; f.assignments[0].profile.archivedAt = new Date();
    await expect(f.run("preview")).rejects.toMatchObject({ name: "ConflictError" }); f.assignments[0].profile.permissions = [];
    f.assignments[0].profile.id = "other"; await expect(f.run("preview")).rejects.toMatchObject({ name: "ConflictError" });
  });
  it("requires subject/project existence, returns initial0 and performs no writes", async () => {
    const f = fixture(); f.tx.organizationState.findUnique.mockResolvedValue(null); expect((await f.run("preview")).version).toBe(0); await f.run("profiles"); await f.run("assignments");
    for (const write of [f.tx.user.update, f.tx.project.update, f.tx.privilegeProfile.create, f.tx.privilegeProfile.update, f.tx.scopedPrivilegeAssignment.create, f.tx.scopedPrivilegeAssignment.deleteMany, f.tx.organizationState.upsert, f.tx.organizationState.update, f.tx.organizationOperation.create]) expect(write).not.toHaveBeenCalled();
    f.tx.project.findUnique.mockResolvedValue(null); await expect(f.run("preview")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(f.reader.privilegeAssignments({ actorId, userId: "missing" })).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it("explains the effective action matrix separately from the legacy/applicant layers", async () => {
    const f = fixture();
    f.assignments.splice(1);
    f.assignments[0].profile.permissions = ["request.internal.read", "request.read"];
    const result = await f.reader.privilegePreview({ actorId, userId: "subject", projectId: "board" });
    expect(result.effective.matrix.denyByDefault).toBe(true);
    expect(result.effective.matrix.inheritance).toEqual(["organization", "department", "board"]);
    expect(result.effective.matrix.actions.map(row => row.action)).toEqual([...ORGANIZATION_PRIVILEGE_PERMISSIONS]);
    expect(result.effective.matrix.actions.find(row => row.action === "request.read")).toMatchObject({
      allowed: true, source: "assignment", scopeKind: "organization" });
    expect(result.effective.matrix.actions.find(row => row.action === "request.internal.read")).toMatchObject({
      allowed: true, source: "assignment", scopeKind: "organization" });
  });
  it("bounds delegation checks by saved permissions and validates the profile first", async () => {
    const f = fixture();
    const globalAdmin = await f.reader.privilegeDelegationCheck({ actorId, profileId: "profile000",
      scopeKind: "organization", departmentId: null, projectId: null });
    expect(globalAdmin).toEqual({ allowed: true, reason: "allowed", deniedPermissions: [] });
    await expect(f.reader.privilegeDelegationCheck({ actorId, profileId: "missing",
      scopeKind: "organization", departmentId: null, projectId: null })).rejects.toMatchObject({ name: "NotFoundError" });
    f.profiles[0].permissions = ["request.read", "request.read"];
    await expect(f.reader.privilegeDelegationCheck({ actorId, profileId: "profile000",
      scopeKind: "organization", departmentId: null, projectId: null })).rejects.toMatchObject({ name: "ConflictError" });
    expect(() => f.reader.privilegeDelegationCheck({ actorId, profileId: "profile000",
      scopeKind: "department", departmentId: null, projectId: null })).toThrowError(expect.objectContaining({ name: "ValidationError" }));
  });
  it("rejects unsafe/bounded params before transactions and preserves query failures", async () => {
    const f = fixture();
    for (const run of [() => f.reader.privilegeProfiles({ actorId, limit: 101 }), () => f.reader.privilegeProfiles({ actorId, cursor: encode({ kind: "people", id: "row", archived: "all", version: 4 }) }), () => f.reader.privilegePreview({ actorId, userId: "../bad", projectId: "board" })]) expect(run).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(f.transaction).not.toHaveBeenCalled();
    const failure = Error("Synthetic query failure"); f.tx.privilegeProfile.findMany.mockRejectedValue(failure); await expect(f.run("profiles")).rejects.toBe(failure);
  });
});
