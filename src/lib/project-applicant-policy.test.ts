import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { normalizeOrganizationApplicantPolicy, decodeOrganizationApplicantPolicy, decodeOrganizationResult } from "./organization-command";
import { evaluateProjectApplicantPolicy } from "./access-policy";
import { createOrganizationService } from "./organization";

const selected = () => ({ allEmployees: false, userIds: ["userB", "userA"], departmentIds: ["dept"], groupIds: ["group"] });
const facts = { userId: "subject", activePrimaryDepartmentId: null, activeGroupIds: [] as string[] };

describe("closed applicant policy normalization and stored decoding", () => {
  it("keeps sensitive policy JSON off Project scalar fields and in an explicit optional relation", () => {
    const project = Prisma.dmmf.datamodel.models.find(model => model.name === "Project")!;
    expect(project.fields.some(field => field.name === "applicantPolicy" && field.kind === "scalar")).toBe(false);
    expect(project.fields.find(field => field.name === "applicantPolicyConfig")).toMatchObject({ kind: "object", type: "ProjectApplicantPolicy", isRequired: false });
    const policy = Prisma.dmmf.datamodel.models.find(model => model.name === "ProjectApplicantPolicy")!;
    expect(policy.fields.find(field => field.name === "projectId")).toMatchObject({ isId: true });
    expect(policy.fields.find(field => field.name === "policy")).toMatchObject({ kind: "scalar", type: "Json" });
  });
  it("deduplicates and lexically sorts bounded input lists without mutating frozen inputs", () => {
    const input = { allEmployees: false, userIds: ["b", "Z", "a", "b"], departmentIds: ["d2", "d1", "d2"], groupIds: ["g2", "g1"] };
    for (const list of [input.userIds, input.departmentIds, input.groupIds]) Object.freeze(list); Object.freeze(input);
    const normalized = normalizeOrganizationApplicantPolicy(input);
    expect(normalized).toEqual({ allEmployees: false, userIds: ["Z", "a", "b"], departmentIds: ["d1", "d2"], groupIds: ["g1", "g2"] });
    expect(input.userIds).toEqual(["b", "Z", "a", "b"]); expect(normalized).not.toBe(input);
    expect(normalized!.groupIds).not.toBe(input.groupIds);
  });
  it("distinguishes null/unconfigured, configured nobody and all employees", () => {
    expect(normalizeOrganizationApplicantPolicy(null)).toBeNull();
    for (const allEmployees of [true, false]) {
      const policy = { allEmployees, userIds: [], departmentIds: [], groupIds: [] };
      expect(normalizeOrganizationApplicantPolicy(policy)).toEqual(policy); expect(decodeOrganizationApplicantPolicy(policy)).toEqual(policy);
    }
  });
  it("accepts twenty IDs per input list and rejects twenty-one before deduplication", () => {
    const policy = { ...selected(), userIds: Array.from({ length: 20 }, (_, i) => `u${String(i).padStart(2, "0")}`) };
    expect(normalizeOrganizationApplicantPolicy(policy)).toEqual({ ...policy, userIds: [...policy.userIds] });
    expect(() => normalizeOrganizationApplicantPolicy({ ...policy, userIds: Array(21).fill("one") })).toThrowError(expect.objectContaining({ name: "ValidationError" }));
  });
  it.each([
    undefined, [], "all", { allEmployees: false, userIds: [], departmentIds: [] },
    { ...selected(), allEmployees: "false" }, { ...selected(), allEmployees: true },
    { ...selected(), userIds: ["../private"] }, { ...selected(), departmentIds: [""] },
    { ...selected(), groupIds: ["x".repeat(129)] }, { ...selected(), userIds: [123] },
    { ...selected(), globalRole: "ADMIN" }, { ...selected(), userIds: "subject" },
  ])("rejects malformed or privileged configured input %#", input => {
    expect(() => normalizeOrganizationApplicantPolicy(input)).toThrowError(expect.objectContaining({ name: "ValidationError" }));
  });
  it.each([
    { ...selected(), userIds: ["b", "a"] }, { ...selected(), userIds: ["a", "a"] },
    { allEmployees: false, userIds: [], departmentIds: [], groupIds: [], email: "synthetic-private" },
    { allEmployees: true, userIds: ["subject"], departmentIds: [], groupIds: [] },
  ])("stored malformed/noncanonical policy fails closed instead of silently normalizing %#", input => {
    expect(() => decodeOrganizationApplicantPolicy(input)).toThrowError(expect.objectContaining({ name: "ConflictError" }));
  });
});

function command(expectedVersion = 0, operationId = randomUUID()) { return { actorId: "admin", operationId, expectedVersion, projectId: "project" }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function serviceFixture() {
  let savedPolicy: unknown = null;
  const state = { version: 0 };
  const users = new Map(["admin", "userA", "userB"].map(id => [id, { id, globalRole: id === "admin" ? "ADMIN" : "USER" }]));
  const departments = new Map([["dept", { id: "dept", archivedAt: null as Date | null }]]);
  const groups = new Map([["group", { id: "group", archivedAt: null as Date | null }]]);
  const receipts = new Map<string, Record<string, unknown>>();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select: Record<string, boolean> }) => {
      const user = users.get(where.id); return user ? Object.fromEntries(Object.entries(user).filter(([key]) => select[key])) : null;
    }) },
    department: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => departments.get(where.id) ?? null) },
    responsibleGroup: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => groups.get(where.id) ?? null) },
    project: { findUnique: vi.fn(async () => ({ id: "project", applicantPolicyConfig: savedPolicy === null ? null : { policy: structuredClone(savedPolicy) } })), update: vi.fn() },
    projectApplicantPolicy: {
      upsert: vi.fn(async ({ create }: { create: { projectId: string; policy: unknown } }) => { savedPolicy = structuredClone(create.policy); return create; }),
      deleteMany: vi.fn(async () => { savedPolicy = null; return { count: 1 }; }),
    },
    organizationState: { upsert: vi.fn(async () => ({ id: "organization", ...state })), update: vi.fn(async ({ data }: { data: { version: number } }) => { state.version = data.version; return { ...state }; }) },
    organizationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { actorId_operationId: { actorId: string; operationId: string } } }) => receipts.get(`${where.actorId_operationId.actorId}/${where.actorId_operationId.operationId}`) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = structuredClone(data); receipts.set(`${data.actorId}/${data.operationId}`, row); return row; }),
    },
  };
  const transaction = vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx));
  const service = createOrganizationService({ $transaction: transaction } as unknown as Parameters<typeof createOrganizationService>[0]);
  return { service, tx, transaction, state, users, departments, groups, receipts, saved: () => savedPolicy, setSaved: (value: unknown) => { savedPolicy = value; } };
}

describe("audited applicant policy command (mock flow, no rollback claim)", () => {
  it("normalizes hash and saved JSON, then replays reordered/duplicate IDs as the same operation", async () => {
    const f = serviceFixture(), meta = command(); const policy = selected();
    const first = await f.service.setProjectApplicantPolicy({ ...meta, policy });
    expect(first).toMatchObject({ version: 1, replayed: false, result: { id: "project", policy: { ...policy, userIds: ["userA", "userB"] } } });
    expect(await f.service.setProjectApplicantPolicy({ ...meta, policy: { ...policy, userIds: ["userA", "userB", "userA"] } })).toEqual({ ...first, replayed: true });
    expect(f.tx.projectApplicantPolicy.upsert).toHaveBeenCalledOnce(); expect(f.tx.project.update).not.toHaveBeenCalled();
    const raw = f.tx.$queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][];
    expect(raw[0][0].join("?")).toContain("pg_advisory_xact_lock"); expect(raw[1][0].join("?")).toContain('FROM "User"'); expect(raw[2][0].join("?")).toContain('FROM "Project"'); expect(raw[2][0].join("?")).toContain("FOR UPDATE");
    expect([...f.receipts.values()][0]).toMatchObject({ before: { id: "project", policy: null }, targetKind: "project", changed: true, committedVersion: 1 });
  });
  it("writes a new no-op receipt without policy/Project write or version increment", async () => {
    const f = serviceFixture(); await f.service.setProjectApplicantPolicy({ ...command(), policy: selected() }); vi.clearAllMocks();
    expect(await f.service.setProjectApplicantPolicy({ ...command(1), policy: { ...selected(), userIds: ["userA", "userB", "userA"] } })).toMatchObject({ version: 1, replayed: false });
    expect(f.tx.projectApplicantPolicy.upsert).not.toHaveBeenCalled(); expect(f.tx.projectApplicantPolicy.deleteMany).not.toHaveBeenCalled(); expect(f.tx.project.update).not.toHaveBeenCalled(); expect(f.tx.organizationState.update).not.toHaveBeenCalled();
    expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce();
  });
  it("replays historical policy after clear without restoring it", async () => {
    const f = serviceFixture(), meta = command(); const first = await f.service.setProjectApplicantPolicy({ ...meta, policy: selected() });
    await f.service.setProjectApplicantPolicy({ ...command(1), policy: null }); vi.clearAllMocks();
    expect(await f.service.setProjectApplicantPolicy({ ...meta, policy: selected() })).toEqual({ ...first, replayed: true }); expect(f.saved()).toBeNull(); expect(f.state.version).toBe(2); expect(f.tx.project.findUnique).not.toHaveBeenCalled(); expect(f.tx.projectApplicantPolicy.upsert).not.toHaveBeenCalled();
  });
  it("requires fresh ADMIN even for valid replay", async () => {
    const f = serviceFixture(), input = { ...command(), policy: selected() }; await f.service.setProjectApplicantPolicy(input); f.users.get("admin")!.globalRole = "USER"; vi.clearAllMocks();
    await expect(f.service.setProjectApplicantPolicy(input)).rejects.toMatchObject({ name: "ForbiddenError" }); expect(f.tx.organizationOperation.findUnique).not.toHaveBeenCalled();
  });
  it("rejects stale version before Project lock/read and changed body under the same UUID", async () => {
    const f = serviceFixture(), input = { ...command(), policy: selected() }; await f.service.setProjectApplicantPolicy(input); vi.clearAllMocks();
    await expect(f.service.setProjectApplicantPolicy({ ...command(), policy: null })).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.project.findUnique).not.toHaveBeenCalled();
    await expect(f.service.setProjectApplicantPolicy({ ...input, policy: null })).rejects.toMatchObject({ name: "ConflictError" }); expect(f.receipts.size).toBe(1);
  });
  it.each(["user-missing", "department-missing", "group-missing", "department-archived", "group-archived"])("rejects invalid new target %s before policy writes", async reason => {
    const f = serviceFixture(); if (reason === "user-missing") f.users.delete("userA"); if (reason === "department-missing") f.departments.clear(); if (reason === "group-missing") f.groups.clear(); if (reason === "department-archived") f.departments.get("dept")!.archivedAt = new Date(); if (reason === "group-archived") f.groups.get("group")!.archivedAt = new Date();
    await expect(f.service.setProjectApplicantPolicy({ ...command(), policy: selected() })).rejects.toMatchObject({ name: reason.includes("archived") ? "ConflictError" : "NotFoundError" }); expect(f.tx.projectApplicantPolicy.upsert).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
  });
  it("rejects even an unchanged archived target for a new command", async () => {
    const f = serviceFixture(); await f.service.setProjectApplicantPolicy({ ...command(), policy: selected() }); f.groups.get("group")!.archivedAt = new Date();
    await expect(f.service.setProjectApplicantPolicy({ ...command(1), policy: selected() })).rejects.toMatchObject({ name: "ConflictError" }); expect(f.state.version).toBe(1);
  });
  it("clears configuration without requiring its deleted or archived former subjects", async () => {
    const f = serviceFixture(); f.setSaved({ allEmployees: false, userIds: ["missing"], departmentIds: ["deleted"], groupIds: ["archived"] });
    expect(await f.service.setProjectApplicantPolicy({ ...command(), policy: null })).toEqual({ result: { id: "project", policy: null }, version: 1, replayed: false });
    expect(f.tx.projectApplicantPolicy.deleteMany).toHaveBeenCalledWith({ where: { projectId: "project" } }); expect(f.tx.department.findUnique).not.toHaveBeenCalled(); expect(f.tx.responsibleGroup.findUnique).not.toHaveBeenCalled(); expect(f.tx.project.update).not.toHaveBeenCalled();
  });
  it("captures deep policy arrays and command metadata before asynchronous locks", async () => {
    const f = serviceFixture(), gate = deferred(); f.tx.$queryRaw.mockImplementationOnce(async () => { await gate.promise; return []; });
    const input = { ...command(), policy: selected() }; const originalId = input.operationId; const pending = f.service.setProjectApplicantPolicy(input);
    input.policy.userIds.splice(0, 2, "missing"); input.actorId = "other"; input.projectId = "other"; input.operationId = randomUUID(); input.expectedVersion = 99;
    gate.resolve(); expect(await pending).toMatchObject({ result: { id: "project", policy: { userIds: ["userA", "userB"] } }, version: 1 }); expect([...f.receipts.values()][0]).toMatchObject({ actorId: "admin", operationId: originalId, expectedVersion: 0 });
  });
  it.each(["unordered", "extra", "null-before", "wrong-target"])("rejects corrupted stored/replay snapshot %s", async corruption => {
    const f = serviceFixture(), input = { ...command(), policy: selected() }; await f.service.setProjectApplicantPolicy(input);
    const row = [...f.receipts.values()][0]; if (corruption === "unordered") row.result = { id: "project", policy: selected() }; if (corruption === "extra") row.result = { id: "project", policy: null, email: "synthetic-private" }; if (corruption === "null-before") row.before = null; if (corruption === "wrong-target") row.targetId = "other";
    vi.clearAllMocks(); await expect(f.service.setProjectApplicantPolicy(input)).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.projectApplicantPolicy.upsert).not.toHaveBeenCalled();
  });
  it("rejects malformed saved policy rather than treating it as unconfigured", async () => {
    const f = serviceFixture(); f.setSaved({ ...selected(), email: "synthetic-private" });
    await expect(f.service.setProjectApplicantPolicy({ ...command(), policy: null })).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.projectApplicantPolicy.deleteMany).not.toHaveBeenCalled();
    expect(() => decodeOrganizationResult("setProjectApplicantPolicy", { id: "project", policy: selected() })).toThrowError(expect.objectContaining({ name: "ConflictError" }));
  });
  it("awaits mandatory audit persistence and propagates failure", async () => {
    const f = serviceFixture(), gate = deferred(); let settled = false;
    f.tx.organizationOperation.create.mockImplementationOnce(async () => { await gate.promise; throw Error("Synthetic audit rejection"); });
    const pending = f.service.setProjectApplicantPolicy({ ...command(), policy: selected() }).finally(() => { settled = true; }); const rejected = expect(pending).rejects.toThrow("Synthetic audit rejection");
    await vi.waitFor(() => expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce()); expect(settled).toBe(false); gate.resolve(); await rejected;
  });
});

describe("prospective applicant preview only, without legacy grants or ADMIN override", () => {
  it("returns null/unconfigured even with arbitrary matching subject facts", () => {
    expect(evaluateProjectApplicantPolicy(null, { ...facts, activePrimaryDepartmentId: "dept", activeGroupIds: ["group"] })).toEqual({ allowed: null, source: "unconfigured" });
  });
  it.each([
    ["all employees", { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] }, facts, true, "all_employees"],
    ["explicit user", { ...selected(), userIds: ["subject"] }, facts, true, "explicit_user"],
    ["primary department", { ...selected(), userIds: [] }, { ...facts, activePrimaryDepartmentId: "dept" }, true, "primary_department"],
    ["independent group", { ...selected(), userIds: [] }, { ...facts, activePrimaryDepartmentId: "other", activeGroupIds: ["group"] }, true, "responsible_group"],
    ["unmatched", selected(), facts, false, "not_in_policy"],
    ["configured nobody", { allEmployees: false, userIds: [], departmentIds: [], groupIds: [] }, facts, false, "not_in_policy"],
    ["no subtree inheritance", { ...selected(), departmentIds: ["parent"] }, { ...facts, activePrimaryDepartmentId: "child" }, false, "not_in_policy"],
    ["user precedes other OR matches", { ...selected(), userIds: ["subject"] }, { ...facts, activePrimaryDepartmentId: "dept", activeGroupIds: ["group"] }, true, "explicit_user"],
    ["department precedes group", selected(), { ...facts, activePrimaryDepartmentId: "dept", activeGroupIds: ["group"] }, true, "primary_department"],
  ] as const)("%s", (_label, policy, input, allowed, source) => {
    // The read-only fixture is normalized server facts, never caller HTTP data.
    expect(evaluateProjectApplicantPolicy(policy, input)).toEqual({ allowed, source });
  });
  it("ignores ADMIN/owner/member/leader metadata when the configured subjects do not match", () => {
    const actorFacts = { ...facts, globalRole: "ADMIN", ownerId: "subject", membershipRole: "PROJECT_ADMIN", leaderId: "subject", ancestorDepartmentIds: ["dept"] };
    expect(evaluateProjectApplicantPolicy(selected(), actorFacts)).toEqual({ allowed: false, source: "not_in_policy" });
  });
  it("preserves frozen policies/facts and returns independent results", () => {
    const policy = { allEmployees: false, userIds: ["subject"], departmentIds: [], groupIds: [] };
    for (const list of [policy.userIds, policy.departmentIds, policy.groupIds]) Object.freeze(list); Object.freeze(policy);
    const input = Object.freeze({ ...facts, activeGroupIds: Object.freeze(["unrelated"]) });
    const first = evaluateProjectApplicantPolicy(policy, input), second = evaluateProjectApplicantPolicy(policy, input);
    expect(second).toEqual(first); expect(second).not.toBe(first); expect(policy.userIds).toEqual(["subject"]);
  });
});
