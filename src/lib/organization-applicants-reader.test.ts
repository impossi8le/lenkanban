import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationReader } from "./organization-reader";

type Policy = { allEmployees: boolean; userIds: string[]; departmentIds: string[]; groupIds: string[] };
const selected = (): Policy => ({ allEmployees: false, userIds: [], departmentIds: ["dept1"], groupIds: ["group1", "group2"] });
const input = { actorId: "admin", projectId: "project", userId: "subject" };
function fixture() {
  let actorRole: string | null = "ADMIN";
  const project: { id: string; name: string; applicantPolicyConfig: { policy: unknown } | null; description: string } = {
    id: "project", name: ` ${"n".repeat(200)} `, applicantPolicyConfig: { policy: selected() }, description: "synthetic-private-description",
  };
  const users = new Map(["subject", "admin"].map(id => [id, { id, primaryDepartment: { id: "dept1", archivedAt: null as Date | null } as { id: string; archivedAt: Date | null } | null,
    email: "synthetic-private@example.invalid", globalRole: "ADMIN" }]));
  const memberships = [{ userId: "subject", groupId: "group1", active: true }, { userId: "subject", groupId: "group2", active: false }, { userId: "subject", groupId: "unrelated", active: true }, { userId: "other", groupId: "group1", active: true }];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select: { globalRole?: boolean } }) => select.globalRole
      ? actorRole === null ? null : { globalRole: actorRole } : users.get(where.id) ?? null), update: vi.fn() },
    project: { findUnique: vi.fn(async (): Promise<typeof project | null> => project), update: vi.fn() },
    responsibleGroupMember: { findMany: vi.fn(async ({ where, take }: { where: { userId: string; groupId: { in: string[] }; group: { archivedAt: null } }; take: number }) => memberships.filter(row => row.userId === where.userId && where.groupId.in.includes(row.groupId) && row.active).slice(0, take).map(row => ({ groupId: row.groupId }))) },
    organizationState: { findUnique: vi.fn().mockResolvedValue({ version: 6 }), upsert: vi.fn(), update: vi.fn() },
    organizationOperation: { create: vi.fn() },
    projectApplicantPolicy: { upsert: vi.fn(), deleteMany: vi.fn() },
  };
  const transaction = vi.fn(async (read: (value: typeof tx) => Promise<unknown>) => read(tx));
  const reader = createOrganizationReader({ $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">);
  return { reader, tx, transaction, project, users, memberships, setActor: (value: string | null) => { actorRole = value; } };
}

describe("fresh administrative applicant config/preview reader (mock DB protocol)", () => {
  it("locks shared topology then actor SHARE, fresh ADMIN and version before project/subject facts", async () => {
    const f = fixture(); await f.reader.projectApplicants(input);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(f.tx.$queryRaw.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock_shared"); expect(f.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(["organization-topology-v1"]);
    expect(f.tx.$queryRaw.mock.calls[1][0].join("?")).toContain('FROM "User" WHERE "id" = ? FOR SHARE');
    expect(f.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(f.tx.user.findUnique.mock.invocationCallOrder[0]);
    expect(f.tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(f.tx.organizationState.findUnique.mock.invocationCallOrder[0]);
    expect(f.tx.organizationState.findUnique.mock.invocationCallOrder[0]).toBeLessThan(f.tx.project.findUnique.mock.invocationCallOrder[0]);
  });
  it.each([null, "USER", "PROJECT_ADMIN"])("denies %s before configuration or preview data reads", async role => {
    const f = fixture(); f.setActor(role); await expect(f.reader.projectApplicants(input)).rejects.toMatchObject({ name: role === null ? "NotFoundError" : "ForbiddenError" }); expect(f.tx.project.findUnique).not.toHaveBeenCalled(); expect(f.tx.organizationState.findUnique).not.toHaveBeenCalled();
  });
  it("checks the actor after a delayed shared lock instead of trusting the earlier role", async () => {
    const f = fixture(); let release!: () => void; f.tx.$queryRaw.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const pending = f.reader.projectApplicants(input); expect(f.tx.user.findUnique).not.toHaveBeenCalled(); f.setActor("USER"); release(); await expect(pending).rejects.toMatchObject({ name: "ForbiddenError" }); expect(f.tx.project.findUnique).not.toHaveBeenCalled();
  });
  it("returns a bounded project label and canonical saved policy without preview when no user is requested", async () => {
    const f = fixture(); const result = await f.reader.projectApplicants({ actorId: "admin", projectId: "project" });
    expect(result).toEqual({ project: { id: "project", displayName: "n".repeat(120) }, policy: selected(), preview: null, version: 6 });
    expect(f.tx.user.findUnique).toHaveBeenCalledOnce(); expect(f.tx.responsibleGroupMember.findMany).not.toHaveBeenCalled();
    expect(f.tx.project.findUnique).toHaveBeenCalledWith({ where: { id: "project" }, select: { id: true, name: true, applicantPolicyConfig: { select: { policy: true } } } });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|email|globalRole|description/);
  });
  it("queries only active matching groups within policy IDs, and uses an exact active primary department", async () => {
    const f = fixture(); expect((await f.reader.projectApplicants(input)).preview).toEqual({ userId: "subject", allowed: true, source: "primary_department" });
    expect(f.tx.user.findUnique).toHaveBeenLastCalledWith({ where: { id: "subject" }, select: { id: true, primaryDepartment: { select: { id: true, archivedAt: true } } } });
    expect(f.tx.responsibleGroupMember.findMany).toHaveBeenCalledWith({ where: { userId: "subject", groupId: { in: ["group1", "group2"] }, group: { archivedAt: null } }, select: { groupId: true }, take: 20 });
    f.users.get("subject")!.primaryDepartment!.archivedAt = new Date();
    expect((await f.reader.projectApplicants(input)).preview).toMatchObject({ allowed: true, source: "responsible_group" });
    f.memberships.find(row => row.groupId === "group1" && row.userId === "subject")!.active = false;
    const denied = await f.reader.projectApplicants(input); expect(denied.preview).toMatchObject({ allowed: false, source: "not_in_policy" }); expect(denied.policy).toEqual(selected());
  });
  it("does not inherit a parent/leader department or unrelated group and gives ADMIN subjects no override", async () => {
    const f = fixture(); f.users.get("admin")!.primaryDepartment = { id: "child", archivedAt: null };
    expect((await f.reader.projectApplicants({ ...input, userId: "admin" })).preview).toEqual({ userId: "admin", allowed: false, source: "not_in_policy" });
  });
  it("distinguishes missing policy row from a configured nobody and skips unneeded group queries", async () => {
    const f = fixture(); f.project.applicantPolicyConfig = null; f.tx.organizationState.findUnique.mockResolvedValue(null);
    expect(await f.reader.projectApplicants(input)).toMatchObject({ policy: null, version: 0, preview: { userId: "subject", allowed: null, source: "unconfigured" } });
    expect(f.tx.responsibleGroupMember.findMany).not.toHaveBeenCalled();
    f.project.applicantPolicyConfig = { policy: { allEmployees: false, userIds: [], departmentIds: [], groupIds: [] } };
    expect((await f.reader.projectApplicants(input)).preview).toMatchObject({ allowed: false, source: "not_in_policy" }); expect(f.tx.responsibleGroupMember.findMany).not.toHaveBeenCalled();
    for (const write of [f.tx.user.update, f.tx.project.update, f.tx.projectApplicantPolicy.upsert, f.tx.projectApplicantPolicy.deleteMany, f.tx.organizationState.upsert, f.tx.organizationState.update, f.tx.organizationOperation.create]) expect(write).not.toHaveBeenCalled();
  });
  it.each(["project", "user"])("requires the selected %s to exist even for unconfigured policy", async missing => {
    const f = fixture(); f.project.applicantPolicyConfig = null; if (missing === "project") f.tx.project.findUnique.mockResolvedValue(null); else f.users.delete("subject");
    await expect(f.reader.projectApplicants(input)).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it.each([null, { ...selected(), email: "synthetic-private" }, { ...selected(), groupIds: ["group2", "group1"] }, { ...selected(), groupIds: ["group1", "group1"] }])("rejects malformed stored policy row %# instead of unconfigured/all fallback", async policy => {
    const f = fixture(); f.project.applicantPolicyConfig = { policy }; await expect(f.reader.projectApplicants(input)).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.user.findUnique).toHaveBeenCalledOnce(); expect(f.tx.responsibleGroupMember.findMany).not.toHaveBeenCalled();
  });
  it("propagates database failures and rejects unsafe IDs before opening a transaction", async () => {
    const f = fixture(), failure = Error("Synthetic project query failure"); f.tx.project.findUnique.mockRejectedValue(failure); await expect(f.reader.projectApplicants(input)).rejects.toBe(failure); f.transaction.mockClear();
    for (const override of [{ actorId: "../bad" }, { projectId: "../bad" }, { userId: "../bad" }]) expect(() => f.reader.projectApplicants({ ...input, ...override })).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(f.transaction).not.toHaveBeenCalled();
  });
});
