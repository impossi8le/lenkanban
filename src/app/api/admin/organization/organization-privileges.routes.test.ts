import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), profiles: vi.fn(), assignments: vi.fn(), preview: vi.fn(), delegation: vi.fn(), create: vi.fn(), update: vi.fn(), assign: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.actor }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/organization-reader", () => ({ createOrganizationReader: () => ({ privilegeProfiles: mocks.profiles, privilegeAssignments: mocks.assignments, privilegePreview: mocks.preview, privilegeDelegationCheck: mocks.delegation }) }));
vi.mock("@/lib/organization", () => ({ createOrganizationService: () => ({ createPrivilegeProfile: mocks.create, updatePrivilegeProfile: mocks.update, setPrivilegeAssignment: mocks.assign }) }));
import { ConflictError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { ORGANIZATION_PRIVILEGE_PERMISSIONS } from "@/lib/organization-contract";
import { GET as PROFILES, POST as CREATE } from "./privilege-profiles/route";
import { PATCH } from "./privilege-profiles/[id]/route";
import { GET as ASSIGNMENTS, POST as ASSIGN } from "./privilege-assignments/route";
import { GET as PREVIEW } from "./privilege-preview/route";

const base = "https://app.test/api/admin/organization";
const meta = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 4 };
const profile = { id: "profile", name: "Synthetic", permissions: ["request.read"], archived: false };
const result = { result: profile, version: 5, replayed: false };
const assignment = { userId: "subject", profileId: "profile", scopeKind: "organization", departmentId: null, projectId: null, assigned: true, ...meta };
function request(path = "/privilege-profiles", body?: unknown) { return new Request(base + path, body === undefined ? {} : { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body) }); }
const patch = (input: Request) => PATCH(input, { params: Promise.resolve({ id: "profile" }) });
const handlers = [PROFILES, CREATE, patch, ASSIGNMENTS, ASSIGN, PREVIEW];
const noWrites = () => { for (const write of [mocks.create, mocks.update, mocks.assign]) expect(write).not.toHaveBeenCalled(); };
function safe(response: Response) { expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-request-id")).toBeTruthy(); }
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false"); mocks.actor.mockResolvedValue({ id: "actor", globalRole: "ADMIN" }); mocks.profiles.mockResolvedValue({ items: [profile], version: 4, nextCursor: null }); mocks.assignments.mockResolvedValue({ items: [], version: 4, nextCursor: null }); mocks.preview.mockResolvedValue({ version: 4, legacy: { canRead: false }, applicant: { allowed: null }, scoped: { requestRead: { allowed: false }, internalRead: { allowed: false } } }); mocks.delegation.mockResolvedValue({ allowed: true, reason: "allowed", deniedPermissions: [] }); for (const write of [mocks.create, mocks.update, mocks.assign]) write.mockResolvedValue(result); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("prospective privilege configuration/preview HTTP boundary", () => {
  it.each(handlers)("denies missing auth before JSON/query/reader/service", async handler => {
    mocks.actor.mockRejectedValue(new UnauthorizedError()); const input = request(undefined, { private: "synthetic-private" }); const read = vi.spyOn(input.body!, "getReader");
    const response = await handler(input); expect(response.status).toBe(401); safe(response); expect(read).not.toHaveBeenCalled(); noWrites(); expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.profiles).not.toHaveBeenCalled(); expect(mocks.assignments).not.toHaveBeenCalled();
  });
  it.each(handlers)("rejects ordinary USER rather than granting scoped administration", async handler => {
    mocks.actor.mockResolvedValue({ id: "actor", globalRole: "USER" }); expect((await handler(request(undefined, {}))).status).toBe(403); noWrites();
  });
  it("authenticates before awaiting profile path params", async () => {
    mocks.actor.mockRejectedValue(new UnauthorizedError()); const then = vi.fn(() => { throw Error("Must not await"); });
    expect((await PATCH(request(undefined, {}), { params: { then } as unknown as Promise<{ id: string }> })).status).toBe(401); expect(then).not.toHaveBeenCalled();
  });
  it("GETs forward bounded saved-only facts and never write", async () => {
    const profiles = await PROFILES(request("/privilege-profiles?archived=active&limit=2&cursor=opaque")); expect(profiles.status).toBe(200); safe(profiles);
    expect(mocks.profiles).toHaveBeenCalledWith({ actorId: "actor", archived: "active", limit: 2, cursor: "opaque" });
    const payload = await profiles.json();
    expect(payload.data.matrix['request.export']).toEqual({ scopeKinds: ['organization', 'department', 'board'], description: expect.any(String) });
    expect(Object.keys(payload.data.matrix).sort()).toEqual([...ORGANIZATION_PRIVILEGE_PERMISSIONS]);
    expect((await ASSIGNMENTS(request("/privilege-assignments?userId=subject&limit=3&cursor=opaque"))).status).toBe(200); expect(mocks.assignments).toHaveBeenCalledWith({ actorId: "actor", userId: "subject", limit: 3, cursor: "opaque" });
    expect((await PREVIEW(request("/privilege-preview?userId=subject&projectId=board"))).status).toBe(200); expect(mocks.preview).toHaveBeenCalledWith({ actorId: "actor", userId: "subject", projectId: "board" }); noWrites();
  });
  it.each([
    [PROFILES, "/privilege-profiles?archived=unknown"], [PROFILES, "/privilege-profiles?limit=101"],
    [ASSIGNMENTS, "/privilege-assignments"], [ASSIGNMENTS, "/privilege-assignments?userId=a&userId=b"],
    [PREVIEW, "/privilege-preview?userId=subject"], [PREVIEW, "/privilege-preview?projectId=board&userId=subject&globalAdmin=true"],
    [PREVIEW, "/privilege-preview?projectId=board&userId=../bad"],
  ] as const)("rejects malformed/untrusted GET facts %#", async (handler, path) => {
    expect((await handler(request(path))).status).toBe(400); expect(mocks.profiles).not.toHaveBeenCalled(); expect(mocks.assignments).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled(); noWrites();
  });
  it("creates and fully updates profiles through audited commands without forwarding caller identities", async () => {
    const response = await CREATE(request(undefined, { name: "  Synthetic  ", permissions: ["request.read"], ...meta })); expect(response.status).toBe(200); safe(response); expect(await response.json()).toEqual({ success: true, data: result });
    expect(mocks.create).toHaveBeenCalledWith({ actorId: "actor", name: "Synthetic", permissions: ["request.read"], ...meta });
    await patch(request(undefined, { name: "Updated", permissions: [], archived: true, ...meta })); expect(mocks.update).toHaveBeenCalledWith({ actorId: "actor", profileId: "profile", name: "Updated", permissions: [], archived: true, ...meta });
  });
  it('forwards explicit profile visibility and rejects unsupported values', async () => {
    expect((await CREATE(request(undefined, { name: 'Own', permissions: ['request.read'], visibility: 'own', ...meta }))).status).toBe(200);
    expect(mocks.create).toHaveBeenLastCalledWith({ actorId: 'actor', name: 'Own', permissions: ['request.read'], visibility: 'own', ...meta });
    expect((await patch(request(undefined, { name: 'Board', permissions: [], archived: false, visibility: 'board', ...meta }))).status).toBe(200);
    expect(mocks.update).toHaveBeenLastCalledWith({ actorId: 'actor', profileId: 'profile', name: 'Board', permissions: [], archived: false, visibility: 'board', ...meta });
    expect((await CREATE(request(undefined, { name: 'Bad', permissions: [], visibility: 'all', ...meta }))).status).toBe(400);
  });
  it.each([
    ["organization", null, null], ["department", "dept", null], ["board", null, "board"],
  ] as const)("accepts grant and revoke with complete %s scope", async (scopeKind, departmentId, projectId) => {
    for (const assigned of [true, false]) {
      const body = { ...assignment, scopeKind, departmentId, projectId, assigned }; const response = await ASSIGN(request("/privilege-assignments", body)); expect(response.status).toBe(200); safe(response); expect(mocks.assign).toHaveBeenLastCalledWith({ actorId: "actor", ...body });
    }
  });
  it.each([
    { ...assignment, scopeKind: "department" }, { ...assignment, scopeKind: "board", projectId: "board", departmentId: "dept" },
    { ...assignment, scopeKind: "organization", departmentId: "dept" }, { ...assignment, scopeKind: "own" },
    { ...assignment, departmentId: undefined }, { ...assignment, actorId: "other" }, { ...assignment, permissions: ["request.read"] },
    { ...assignment, expectedVersion: -1 }, { ...assignment, operationId: "bad" },
  ])("rejects invalid scope or unauthorized assignment fields %#", async body => {
    expect((await ASSIGN(request("/privilege-assignments", body))).status).toBe(400); expect(mocks.assign).not.toHaveBeenCalled();
  });
  it.each([null, ["request.write"], Array.from({ length: ORGANIZATION_PRIVILEGE_PERMISSIONS.length + 1 }, () => "request.read")])("rejects unknown/unbounded raw profile permissions %j", async permissions => {
    expect((await CREATE(request(undefined, { name: "Synthetic", permissions, ...meta }))).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("accepts every catalog permission and still rejects an unknown one", async () => {
    const permissions = [...ORGANIZATION_PRIVILEGE_PERMISSIONS];
    const accepted = await CREATE(request(undefined, { name: "Synthetic", permissions, ...meta }));
    expect(accepted.status).toBe(200); safe(accepted);
    expect(mocks.create).toHaveBeenCalledWith({ actorId: "actor", name: "Synthetic", permissions, ...meta });
    mocks.create.mockClear();
    for (const removed of ["board.delete", "request.delete", "request.share", "board.manage", "privilege.grant"]) {
      expect((await CREATE(request(undefined, { name: "Synthetic", permissions: [removed], ...meta }))).status).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires every full update field and keeps missing path invalid before JSON", async () => {
    expect((await patch(request(undefined, { name: "Updated", permissions: [], ...meta }))).status).toBe(400);
    const input = request(undefined, {}); const read = vi.spyOn(input.body!, "getReader"); expect((await PATCH(input, { params: Promise.resolve({ id: "../bad" }) })).status).toBe(400); expect(read).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("bounds a new grant by the actor's own scope but still allows revoke", async () => {
    mocks.delegation.mockResolvedValueOnce({ allowed: false, reason: "exceeds_permissions", deniedPermissions: ["request.internal.read"] });
    const denied = await ASSIGN(request("/privilege-assignments", { ...assignment, scopeKind: "board", projectId: "board" }));
    expect(denied.status).toBe(403); safe(denied); expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.delegation).toHaveBeenCalledWith({ actorId: "actor", profileId: "profile", scopeKind: "board", departmentId: null, projectId: "board" });
    mocks.delegation.mockClear();
    expect((await ASSIGN(request("/privilege-assignments", { ...assignment, scopeKind: "board", projectId: "board", assigned: false }))).status).toBe(200);
    expect(mocks.delegation).not.toHaveBeenCalled(); expect(mocks.assign).toHaveBeenCalledOnce();
  });
  it.each([CREATE, patch, ASSIGN])("rejects foreign Origin and unrelated POST/PATCH query before persistence", async handler => {
    const foreign = request(undefined, assignment); foreign.headers.set("origin", "https://foreign.invalid"); expect((await handler(foreign)).status).toBe(403);
    const input = request("/privilege-assignments?userId=other", assignment); const read = vi.spyOn(input.body!, "getReader"); expect((await handler(input)).status).toBe(400); expect(read).not.toHaveBeenCalled(); noWrites();
  });
  it("preserves immutable replay metadata and returns fixed no-store errors without private details", async () => {
    mocks.assign.mockResolvedValueOnce({ ...result, replayed: true }); const response = await ASSIGN(request(undefined, assignment)); expect(await response.json()).toEqual({ success: true, data: { ...result, replayed: true } }); expect(mocks.assign.mock.calls[0][0]).toMatchObject(meta);
    for (const [failure, status] of [[new ConflictError("synthetic-private"), 409], [new NotFoundError("synthetic-private"), 404], [Error("synthetic-private"), 500]] as const) {
      mocks.assign.mockRejectedValue(failure); const rejected = await ASSIGN(request(undefined, assignment)); expect(rejected.status).toBe(status); safe(rejected); expect(rejected.headers.get("x-error-id")).toBeTruthy(); expect(await rejected.text()).not.toContain("synthetic-private");
    }
  });
  it("excludes profile names/raw permission payloads from technical logs and uses JSON bounds", async () => {
    await CREATE(request(undefined, { name: "synthetic-private-name", permissions: [], ...meta })); expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("synthetic-private-name"); mocks.create.mockClear();
    expect((await CREATE(request(undefined, { name: "x".repeat(17000), permissions: [], ...meta }))).status).toBe(413); expect(mocks.create).not.toHaveBeenCalled();
  });
});
