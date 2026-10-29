import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { getProjectCreationPolicy, isCreationColumnAllowed } from "./project-creation-policy";

const actor = { id: "actor", globalRole: "USER" as const };
function fixture() {
  const project = {
    ownerId: "other", members: [{ role: "MEMBER" }], applicantPolicyConfig: null,
    responsibleGroup: null as null | { archivedAt: Date | null; members: { userId: string }[] },
    columns: [{ id: "initial" }],
  };
  const database = { project: { findUnique: vi.fn(async (query: unknown) => { void query; return project; }) }, user: { findUnique: vi.fn() }, responsibleGroupMember: { findMany: vi.fn() } };
  const run = (user: typeof actor | { id: string; globalRole: "ADMIN" } = actor) => getProjectCreationPolicy(user, "board", database as never);
  return { project, database, run };
}
describe("creation column policy from existing access and responsible group", () => {
  it("limits an allowed ordinary applicant to the canonical TODO column", async () => {
    const f = fixture(); const policy = await f.run();
    expect(policy).toEqual({ projectId: "board", canCreate: true, allowedColumnIds: ["initial"] });
    expect(isCreationColumnAllowed(policy, "initial")).toBe(true);
    expect(isCreationColumnAllowed(policy, "later")).toBe(false);
    expect((f.database.project.findUnique.mock.calls as unknown as [unknown, ...unknown[]][])[1][0]).toMatchObject({ select: { columns: {
      where: { workflowKey: "TODO" }, orderBy: [{ position: "asc" }, { id: "asc" }], take: 1,
    } } });
  });
  it("does not exempt a board administrator who is not in the responsible group", async () => {
    const f = fixture(); f.project.members = [{ role: "PROJECT_ADMIN" }];
    expect((await f.run()).allowedColumnIds).toEqual(["initial"]);
  });
  it("preserves available column choice for an already allowed active support member", async () => {
    const f = fixture(); f.project.responsibleGroup = { archivedAt: null, members: [{ userId: actor.id }] };
    expect(isCreationColumnAllowed(await f.run(), "later")).toBe(true);
    f.project.responsibleGroup.members = [];
    expect(isCreationColumnAllowed(await f.run(), "later")).toBe(false);
  });
  it("does not accept archived or unrelated group membership", async () => {
    const f = fixture(); f.project.responsibleGroup = { archivedAt: new Date(), members: [{ userId: actor.id }] };
    expect((await f.run()).allowedColumnIds).toEqual(["initial"]);
    f.project.responsibleGroup = { archivedAt: null, members: [{ userId: "other" }] };
    expect((await f.run()).allowedColumnIds).toEqual(["initial"]);
  });
  it("does not create a permission from support membership when applicant access denies", async () => {
    const f = fixture(); f.project.members = []; f.project.responsibleGroup = { archivedAt: null, members: [{ userId: actor.id }] };
    expect(await f.run()).toEqual({ projectId: "board", canCreate: false, allowedColumnIds: [] });
  });
  it("preserves already permitted global administrator access", async () => {
    const f = fixture();
    expect((await f.run({ id: actor.id, globalRole: "ADMIN" })).allowedColumnIds).toBeNull();
  });
  it("fails closed when an applicant's board has no canonical initial column", async () => {
    const f = fixture(); f.project.columns = [];
    expect(isCreationColumnAllowed(await f.run(), "later")).toBe(false);
  });
});
