import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { evaluateScopedPrivileges } from "./access-policy";
import { normalizePrivilegePermissions, decodePrivilegePermissions, normalizePrivilegeScope, privilegeAssignmentId, decodeOrganizationResult } from "./organization-command";
import { createOrganizationService } from "./organization";
import { safeOrganizationHistory } from "./organization-reader";
import type { OrganizationOperation } from "@prisma/client";
import type { OrganizationPrivilegeAssignment } from "./organization-contract";
import { ORGANIZATION_PRIVILEGE_PERMISSIONS, ORGANIZATION_PRIVILEGE_MATRIX } from './organization-contract';
import { decodePrivilegeProfileSettings } from './organization-command';
import { evaluatePrivilegeMatrix } from './organization-access-explanation';

type Grant = Parameters<typeof evaluateScopedPrivileges>[1][number];
const facts = { globalAdmin: false, projectId: "board", activeDepartmentId: "dept" };
function grant(id: string, overrides: Partial<Grant> = {}): Grant {
  return { id, profileId: "profile", scopeKind: "organization", departmentId: null, projectId: null, permissions: ["request.read"], profileArchived: false, ...overrides };
}
const none = () => ({ allowed: false, source: "none", assignmentIds: [] });

describe("closed privilege permission/scope normalization and natural assignment identity", () => {
  it("normalizes catalog permissions, preserving frozen input and canonical stored representation", () => {
    const input = Object.freeze(["request.read", "request.internal.read"]);
    expect(normalizePrivilegePermissions(input)).toEqual(["request.internal.read", "request.read"]);
    expect(normalizePrivilegePermissions(["request.read", "request.read"])).toEqual(["request.read"]);
    expect(normalizePrivilegePermissions([])).toEqual([]);
    expect(decodePrivilegePermissions(["request.internal.read", "request.read"])).toEqual(["request.internal.read", "request.read"]);
    expect(input).toEqual(["request.read", "request.internal.read"]);
  });
  it.each([null, {}, "request.read", ["request.write"], ["ADMIN"], Array.from({ length: ORGANIZATION_PRIVILEGE_PERMISSIONS.length + 1 }, () => "request.read")].map(permissions => ({ permissions })))("rejects unknown or over-long raw permissions %#", ({ permissions }) => {
    expect(() => normalizePrivilegePermissions(permissions)).toThrowError(expect.objectContaining({ name: "ValidationError" }));
  });
  it.each([["request.read", "request.internal.read"], ["request.read", "request.read"], ["unknown"]].map(permissions => ({ permissions })))("stored noncanonical permissions fail closed %#", ({ permissions }) => {
    expect(() => decodePrivilegePermissions(permissions)).toThrowError(expect.objectContaining({ name: "ConflictError" }));
  });
  it.each([
    ["organization", null, null], ["department", "dept", null], ["board", null, "board"],
  ] as const)("accepts only the complete %s scope shape", (scopeKind, departmentId, projectId) => {
    expect(normalizePrivilegeScope(scopeKind, departmentId, projectId)).toEqual({ scopeKind, departmentId, projectId });
    const id = privilegeAssignmentId("user", "profile", scopeKind, departmentId, projectId);
    expect(id).toBe(createHash("sha256").update(JSON.stringify(["user", "profile", scopeKind, departmentId, projectId])).digest("hex"));
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(privilegeAssignmentId("other", "profile", scopeKind, departmentId, projectId)).not.toBe(id);
    expect(privilegeAssignmentId("user", "other", scopeKind, departmentId, projectId)).not.toBe(id);
  });
  it.each([
    ["organization", "dept", null], ["organization", null, "board"], ["department", null, null],
    ["department", "dept", "board"], ["board", "dept", "board"], ["board", null, null], ["own", null, null], ["department", "../bad", null],
  ])("rejects invalid or inherited scope shape %#", (kind, departmentId, projectId) => {
    expect(() => normalizePrivilegeScope(kind, departmentId, projectId)).toThrowError(expect.objectContaining({ name: "ValidationError" }));
  });
});

const command = (expectedVersion = 0, operationId = randomUUID()) => ({ actorId: "admin", expectedVersion, operationId });
const assignmentCommand = () => ({ ...command(), userId: "subject", profileId: "profile", scopeKind: "organization" as const, departmentId: null, projectId: null, assigned: true });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  type Profile = { id: string; name: string; permissions: unknown; archivedAt: Date | null };
  const profiles = new Map<string, Profile>([["profile", { id: "profile", name: "Profile", permissions: ["request.read"], archivedAt: null }]]);
  const assignments = new Map<string, Omit<OrganizationPrivilegeAssignment, "assigned">>();
  const users = new Map(["admin", "subject"].map(id => [id, { id, globalRole: id === "admin" ? "ADMIN" : "USER" }]));
  const departments = new Map([["dept", { id: "dept", archivedAt: null as Date | null }]]);
  const receipts = new Map<string, Record<string, unknown>>(); const state = { version: 0 }; let countOverride: number | undefined;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select: Record<string, boolean> }) => { const user = users.get(where.id); return user ? Object.fromEntries(Object.entries(user).filter(([key]) => select[key])) : null; }), update: vi.fn() },
    project: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === "board" ? { id: "board" } : null) },
    department: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => departments.get(where.id) ?? null) },
    privilegeProfile: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => profiles.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: { name: string; permissions: unknown } }) => { const row = { id: "created-profile", ...data, archivedAt: null }; profiles.set(row.id, row); return row; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Profile> }) => { const row = profiles.get(where.id)!; Object.assign(row, data); return { id: row.id }; }),
    },
    scopedPrivilegeAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => assignments.get(where.id) ?? null),
      count: vi.fn(async ({ where }: { where: { userId?: string; profileId?: string; scopeKind?: { not: string } } }) => countOverride ?? [...assignments.values()].filter(row =>
        (where.userId === undefined || row.userId === where.userId)
        && (where.profileId === undefined || row.profileId === where.profileId)
        && (where.scopeKind === undefined || row.scopeKind !== where.scopeKind.not)).length),
      create: vi.fn(async ({ data }: { data: Omit<OrganizationPrivilegeAssignment, "assigned"> }) => { assignments.set(data.id, structuredClone(data)); return data; }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({ count: assignments.delete(where.id) ? 1 : 0 })),
    },
    groupPrivilegeAssignment: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    organizationState: { upsert: vi.fn(async () => ({ id: "organization", ...state })), update: vi.fn(async ({ data }: { data: { version: number } }) => { state.version = data.version; return { ...state }; }) },
    organizationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { actorId_operationId: { actorId: string; operationId: string } } }) => receipts.get(`${where.actorId_operationId.actorId}/${where.actorId_operationId.operationId}`) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = structuredClone({ ...data, before: data.before === Prisma.JsonNull ? null : data.before }); receipts.set(`${data.actorId}/${data.operationId}`, row); return row; }),
    },
  };
  const transaction = vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx));
  const service = createOrganizationService({ $transaction: transaction } as unknown as Parameters<typeof createOrganizationService>[0]);
  return { service, tx, transaction, profiles, assignments, users, departments, receipts, state, setCount: (value: number) => { countOverride = value; } };
}

describe("audited profile and natural scoped assignment commands (mock flow only)", () => {
  it('assigns a new catalog action and checks its effective scope', async () => {
    const f = fixture();
    const created = await f.service.createPrivilegeProfile({ ...command(), name: 'Exporter', permissions: ['request.export'] });
    await f.service.setPrivilegeAssignment({ ...assignmentCommand(), ...command(1), profileId: created.result.id });
    const matrix = evaluatePrivilegeMatrix(facts, [grant('export', { permissions: created.result.permissions })]);
    expect(matrix.actions.find(row => row.action === 'request.export')).toMatchObject({ allowed: true, assignmentIds: ['export'] });
    expect(Object.keys(ORGANIZATION_PRIVILEGE_MATRIX).sort()).toEqual([...ORGANIZATION_PRIVILEGE_PERMISSIONS]);
    for (const row of Object.values(ORGANIZATION_PRIVILEGE_MATRIX)) {
      expect(row.description.length).toBeGreaterThan(0);
      expect(row.scopeKinds.length).toBeGreaterThan(0);
    }
  });
  it('rejects unknown actions before opening a transaction', () => {
    const f = fixture();
    expect(() => f.service.createPrivilegeProfile({ ...command(), name: 'Unknown', permissions: ['request.unknown' as never] })).toThrow('Invalid privilege permissions');
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('persists OWN in profile JSON, returns it and replays the command', async () => {
    const f = fixture();
    const input = { ...command(), name: 'Own', permissions: ['request.read'] as const, visibility: 'own' as const };
    const first = await f.service.createPrivilegeProfile(input);
    expect(first.result.visibility).toBe('own');
    expect(f.profiles.get(first.result.id)?.permissions).toEqual({ permissions: ['request.read'], visibility: 'own' });
    expect(await f.service.createPrivilegeProfile(input)).toEqual({ ...first, replayed: true });
    const assignment = { ...assignmentCommand(), ...command(1), profileId: first.result.id, scopeKind: 'board' as const, projectId: 'board' };
    expect((await f.service.setPrivilegeAssignment(assignment)).result.scopeKind).toBe('board');
  });
  it.each(['organization', 'department'] as const)('rejects OWN assignment at %s scope without a write', async scopeKind => {
    const f = fixture();
    f.profiles.get('profile')!.permissions = { permissions: ['request.read'], visibility: 'own' };
    await expect(f.service.setPrivilegeAssignment({ ...assignmentCommand(), scopeKind, departmentId: scopeKind === 'department' ? 'dept' : null })).rejects.toMatchObject({ name: 'ValidationError' });
    expect(f.tx.scopedPrivilegeAssignment.create).not.toHaveBeenCalled();
    expect(f.tx.organizationOperation.create).not.toHaveBeenCalled();
  });
  it('rejects changing an organization-assigned profile to OWN', async () => {
    const f = fixture();
    await f.service.setPrivilegeAssignment(assignmentCommand());
    await expect(f.service.updatePrivilegeProfile({ ...command(1), profileId: 'profile', name: 'Profile', permissions: ['request.read'], archived: false, visibility: 'own' })).rejects.toMatchObject({ name: 'ValidationError' });
    expect(f.tx.privilegeProfile.update).not.toHaveBeenCalled();
  });
  it('decodes legacy profiles as BOARD and rejects malformed saved visibility', () => {
    expect(decodePrivilegeProfileSettings(['request.read'])).toEqual({ permissions: ['request.read'], visibility: 'board' });
    expect(() => decodePrivilegeProfileSettings({ permissions: ['request.read'], visibility: 'other' })).toThrow();
    expect(() => decodePrivilegeProfileSettings({ permissions: ['request.read'], visibility: 'own', extra: true })).toThrow();
  });
  it("creates canonical permissions and replays a reordered full command with the same normalized hash", async () => {
    const f = fixture(), meta = command();
    const first = await f.service.createPrivilegeProfile({ ...meta, name: " Profile ", permissions: ["request.read", "request.internal.read"] });
    expect(first).toMatchObject({ version: 1, replayed: false, result: { permissions: ["request.internal.read", "request.read"], name: "Profile", archived: false } });
    expect(await f.service.createPrivilegeProfile({ ...meta, name: "Profile", permissions: ["request.internal.read", "request.read"] })).toEqual({ ...first, replayed: true });
    expect(f.tx.privilegeProfile.create).toHaveBeenCalledOnce(); expect([...f.receipts.values()][0]).toMatchObject({ before: null, targetKind: "profile", changed: true });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  });
  it("records unchanged full profile updates without entity write or increment and archives without deleting assignments", async () => {
    const f = fixture(); await f.service.setPrivilegeAssignment(assignmentCommand()); vi.clearAllMocks();
    expect(await f.service.updatePrivilegeProfile({ ...command(1), profileId: "profile", name: "Profile", permissions: ["request.read", "request.read"], archived: false })).toMatchObject({ version: 1 });
    expect(f.tx.privilegeProfile.update).not.toHaveBeenCalled(); expect(f.tx.organizationState.update).not.toHaveBeenCalled();
    await f.service.updatePrivilegeProfile({ ...command(1), profileId: "profile", name: "Archived", permissions: [], archived: true });
    expect(f.assignments.size).toBe(1); expect(f.tx.scopedPrivilegeAssignment.deleteMany).not.toHaveBeenCalled(); expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("grants, no-ops, revokes and regrants the same natural identity with full before snapshots", async () => {
    const f = fixture(), input = assignmentCommand(); const first = await f.service.setPrivilegeAssignment(input);
    const id = privilegeAssignmentId("subject", "profile", "organization", null, null);
    expect(first).toMatchObject({ result: { id, assigned: true }, version: 1 }); expect([...f.receipts.values()][0]).toMatchObject({ before: { id, assigned: false }, targetKind: "privilegeAssignment" });
    vi.clearAllMocks(); expect(await f.service.setPrivilegeAssignment({ ...input, ...command(1) })).toMatchObject({ version: 1, replayed: false }); expect(f.tx.scopedPrivilegeAssignment.create).not.toHaveBeenCalled(); expect(f.tx.organizationState.update).not.toHaveBeenCalled();
    await f.service.setPrivilegeAssignment({ ...input, ...command(1), assigned: false }); expect(f.assignments.size).toBe(0);
    expect(await f.service.setPrivilegeAssignment({ ...input, ...command(2) })).toMatchObject({ result: { id, assigned: true }, version: 3 }); expect(f.users.get("subject")!.globalRole).toBe("USER"); expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("returns a historical grant receipt after revoke without regranting", async () => {
    const f = fixture(), input = assignmentCommand(); const first = await f.service.setPrivilegeAssignment(input); await f.service.setPrivilegeAssignment({ ...input, ...command(1), assigned: false }); vi.clearAllMocks();
    expect(await f.service.setPrivilegeAssignment(input)).toEqual({ ...first, replayed: true }); expect(f.assignments.size).toBe(0); expect(f.tx.scopedPrivilegeAssignment.create).not.toHaveBeenCalled(); expect(f.tx.privilegeProfile.findUnique).not.toHaveBeenCalled();
  });
  it.each(["profile", "department"])("allows revocation of archived %s but refuses new grant/no-op regrant", async resource => {
    const f = fixture(), input = { ...assignmentCommand(), scopeKind: "department" as const, departmentId: "dept" };
    await f.service.setPrivilegeAssignment(input);
    if (resource === "profile") f.profiles.get("profile")!.archivedAt = new Date(); else f.departments.get("dept")!.archivedAt = new Date();
    await expect(f.service.setPrivilegeAssignment({ ...input, ...command(1) })).rejects.toMatchObject({ name: "ConflictError" });
    expect(await f.service.setPrivilegeAssignment({ ...input, ...command(1), assigned: false })).toMatchObject({ result: { assigned: false }, version: 2 });
  });
  it.each(["user", "profile", "department", "board"])("requires existing %s even for a new no-op revoke", async resource => {
    const f = fixture(); if (resource === "user") f.users.delete("subject"); if (resource === "profile") f.profiles.clear(); if (resource === "department") f.departments.clear();
    const input = { ...assignmentCommand(), assigned: false, scopeKind: resource === "board" ? "board" as const : resource === "department" ? "department" as const : "organization" as const,
      departmentId: resource === "department" ? "dept" : null, projectId: resource === "board" ? "missing-board" : null };
    await expect(f.service.setPrivilegeAssignment(input)).rejects.toMatchObject({ name: "NotFoundError" }); expect(f.receipts.size).toBe(0);
  });
  it("locks an assigned board before reading it and validates limits only for a new grant", async () => {
    const f = fixture(), input = { ...assignmentCommand(), scopeKind: "board" as const, projectId: "board" };
    f.setCount(100); await expect(f.service.setPrivilegeAssignment(input)).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.scopedPrivilegeAssignment.create).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw.mock.calls[2][0].join("?")).toContain('FROM "Project"'); expect(f.tx.$queryRaw.mock.calls[2][0].join("?")).toContain("FOR UPDATE");
    f.setCount(99); await f.service.setPrivilegeAssignment(input); f.setCount(100); vi.clearAllMocks();
    expect(await f.service.setPrivilegeAssignment({ ...input, ...command(1) })).toMatchObject({ version: 1 }); expect(f.tx.scopedPrivilegeAssignment.count).not.toHaveBeenCalled();
    await f.service.setPrivilegeAssignment({ ...input, ...command(1), assigned: false }); expect(f.tx.scopedPrivilegeAssignment.count).not.toHaveBeenCalled();
  });
  it("requires fresh ADMIN on replay and rejects stale version or reused ID with changed fields", async () => {
    const f = fixture(), input = assignmentCommand(); await f.service.setPrivilegeAssignment(input);
    await expect(f.service.setPrivilegeAssignment({ ...input, assigned: false })).rejects.toMatchObject({ name: "ConflictError" });
    await expect(f.service.setPrivilegeAssignment({ ...input, ...command(), assigned: false })).rejects.toMatchObject({ name: "ConflictError" });
    f.users.get("admin")!.globalRole = "USER"; vi.clearAllMocks(); await expect(f.service.setPrivilegeAssignment(input)).rejects.toMatchObject({ name: "ForbiddenError" }); expect(f.tx.organizationOperation.findUnique).not.toHaveBeenCalled();
  });
  it("captures deep permissions and actor metadata before an asynchronous lock wait", async () => {
    const f = fixture(), gate = deferred(); f.tx.$queryRaw.mockImplementationOnce(() => gate.promise);
    const input = { ...command(), name: "Original", permissions: ["request.read"] as ("request.read" | "request.internal.read")[] }; const operationId = input.operationId;
    const pending = f.service.createPrivilegeProfile(input); input.permissions[0] = "request.internal.read"; input.actorId = "subject"; input.name = "Changed"; input.operationId = randomUUID(); input.expectedVersion = 99;
    gate.resolve(); expect(await pending).toMatchObject({ result: { name: "Original", permissions: ["request.read"] }, version: 1 }); expect([...f.receipts.values()][0]).toMatchObject({ actorId: "admin", operationId, expectedVersion: 0 });
  });
  it.each(["natural-id", "result-extra", "snapshot-scope", "version"])("rejects corrupted assignment receipt %s", async corruption => {
    const f = fixture(), input = assignmentCommand(); await f.service.setPrivilegeAssignment(input); const row = [...f.receipts.values()][0];
    if (corruption === "natural-id") row.result = { ...(row.result as object), id: "f".repeat(64) };
    if (corruption === "result-extra") row.result = { ...(row.result as object), email: "synthetic-private" };
    if (corruption === "snapshot-scope") row.before = { ...(row.before as object), departmentId: "dept" };
    if (corruption === "version") row.committedVersion = 9;
    vi.clearAllMocks(); await expect(f.service.setPrivilegeAssignment(input)).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.scopedPrivilegeAssignment.create).not.toHaveBeenCalled();
  });
  it("rejects malformed profile permissions and conflicting raw assignment identity", async () => {
    const f = fixture(); f.profiles.get("profile")!.permissions = ["request.read", "request.read"];
    await expect(f.service.setPrivilegeAssignment(assignmentCommand())).rejects.toMatchObject({ name: "ConflictError" });
    expect(() => decodeOrganizationResult("setPrivilegeAssignment", { ...assignmentCommand(), id: "f".repeat(64) })).toThrowError(expect.objectContaining({ name: "ConflictError" }));
  });
  it("keeps create-profile and assignment history closed with their distinct target kinds", async () => {
    const f = fixture(); await f.service.createPrivilegeProfile({ ...command(), name: "New", permissions: [] }); await f.service.setPrivilegeAssignment({ ...assignmentCommand(), ...command(1) });
    for (const [index, row] of [...f.receipts.values()].entries()) {
      const history = safeOrganizationHistory({ ...row, id: `audit${index}`, committedAt: new Date("2026-10-21T00:00:00Z") } as unknown as OrganizationOperation);
      expect(history).toMatchObject({ targetKind: index === 0 ? "profile" : "privilegeAssignment" });
    }
  });
  it("does not resolve before mandatory audit completes and propagates its rejection", async () => {
    const f = fixture(), gate = deferred(); let settled = false;
    f.tx.organizationOperation.create.mockImplementationOnce(async () => { await gate.promise; throw Error("Synthetic audit rejection"); });
    const pending = f.service.setPrivilegeAssignment(assignmentCommand()).finally(() => { settled = true; }); const rejected = expect(pending).rejects.toThrow("Synthetic audit rejection");
    await vi.waitFor(() => expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce()); expect(settled).toBe(false); gate.resolve(); await rejected;
  });
});

describe("prospective scoped grants, separate from legacy and applicant decisions", () => {
  it("has no implicit department/leader/owner/group grant without a matching assignment", () => {
    const extraFacts = { ...facts, leaderId: "subject", primaryDepartmentId: "dept", groupIds: ["group"] };
    expect(evaluateScopedPrivileges(extraFacts, []))
      .toEqual({ requestRead: none(), internalRead: none() });
  });
  it.each([
    ["organization", grant("g"), true],
    ["exact board", grant("g", { scopeKind: "board", projectId: "board" }), true],
    ["other board", grant("g", { scopeKind: "board", projectId: "other" }), false],
    ["exact active department", grant("g", { scopeKind: "department", departmentId: "dept" }), true],
    ["parent/other department", grant("g", { scopeKind: "department", departmentId: "parent" }), false],
    ["archived profile", grant("g", { profileArchived: true }), false],
  ] as const)("%s", (_label, assignment, allowed) => {
    expect(evaluateScopedPrivileges(facts, [assignment])).toEqual({ requestRead: allowed ? { allowed: true, source: "assignment", assignmentIds: ["g"] } : none(), internalRead: none() });
  });
  it("deactivates department scope when project department is absent/archived without widening to organization", () => {
    expect(evaluateScopedPrivileges({ ...facts, activeDepartmentId: null }, [grant("g", { scopeKind: "department", departmentId: "dept" })]))
      .toEqual({ requestRead: none(), internalRead: none() });
  });
  it("requires aggregate request.read for internal candidates and keeps their explanation IDs", () => {
    const internal = grant("internal", { permissions: ["request.internal.read"] });
    expect(evaluateScopedPrivileges(facts, [internal])).toEqual({ requestRead: none(), internalRead: { allowed: false, source: "requires_request_read", assignmentIds: ["internal"] } });
    expect(evaluateScopedPrivileges(facts, [internal, grant("read")])).toEqual({ requestRead: { allowed: true, source: "assignment", assignmentIds: ["read"] }, internalRead: { allowed: true, source: "assignment", assignmentIds: ["internal"] } });
  });
  it("ORs independent profiles and sorts every matching source instead of selecting just one", () => {
    const grants = [grant("z", { permissions: ["request.internal.read", "request.read"] }), grant("a"), grant("ignored", { projectId: "other", scopeKind: "board" })];
    expect(evaluateScopedPrivileges(facts, grants)).toEqual({ requestRead: { allowed: true, source: "assignment", assignmentIds: ["a", "z"] }, internalRead: { allowed: true, source: "assignment", assignmentIds: ["z"] } });
    expect(evaluateScopedPrivileges(facts, grants.slice(1)).requestRead).toEqual({ allowed: true, source: "assignment", assignmentIds: ["a"] });
  });
  it("uses global ADMIN as a separate source without inventing assignment provenance", () => {
    expect(evaluateScopedPrivileges({ ...facts, globalAdmin: true }, [grant("archived", { profileArchived: true })])).toEqual({
      requestRead: { allowed: true, source: "global_admin", assignmentIds: [] }, internalRead: { allowed: true, source: "global_admin", assignmentIds: [] },
    });
  });
  it("preserves frozen facts/grants/permission arrays and returns independent decision arrays", () => {
    const item = grant("g", { permissions: ["request.internal.read", "request.read"] }); Object.freeze(item.permissions); Object.freeze(item);
    const input = Object.freeze([item]); const actor = Object.freeze({ ...facts });
    const first = evaluateScopedPrivileges(actor, input), second = evaluateScopedPrivileges(actor, input);
    expect(second).toEqual(first); expect(second).not.toBe(first); expect(second.requestRead.assignmentIds).not.toBe(first.requestRead.assignmentIds);
    expect(item.permissions).toEqual(["request.internal.read", "request.read"]);
  });
});
