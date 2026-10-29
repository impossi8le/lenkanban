import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), read: vi.fn(), save: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.actor }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/organization-reader", () => ({ createOrganizationReader: () => ({ projectApplicants: mocks.read }) }));
vi.mock("@/lib/organization", () => ({ createOrganizationService: () => ({ setProjectApplicantPolicy: mocks.save }) }));
import { ConflictError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { GET, PATCH } from "./projects/[id]/applicants/route";

const path = "https://app.test/api/admin/organization/projects/project1/applicants";
const meta = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 4 };
const policy = { allEmployees: false, userIds: ["person1"], departmentIds: ["dept1"], groupIds: ["group1"] };
const result = { result: { id: "project1", policy }, version: 5, replayed: false };
const report = { project: { id: "project1", displayName: "Synthetic board" }, policy, preview: { userId: "subject", allowed: false, source: "not_in_policy" }, version: 4 };
const context = () => ({ params: Promise.resolve({ id: "project1" }) });
function request(body: unknown = { policy, ...meta }, query = "") { return new Request(path + query, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body) }); }
const patch = (input = request()) => PATCH(input, context());
function safe(response: Response) { expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-request-id")).toBeTruthy(); }
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false"); mocks.actor.mockResolvedValue({ id: "actor", globalRole: "ADMIN" }); mocks.read.mockResolvedValue(report); mocks.save.mockResolvedValue(result); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("applicant policy configuration/preview transport, not legacy access activation", () => {
  it.each([GET, PATCH])("authenticates before params, body, subject preview or mutation", async handler => {
    mocks.actor.mockRejectedValue(new UnauthorizedError()); const input = request({ raw: "synthetic-private" }); const read = vi.spyOn(input.body!, "getReader");
    const then = vi.fn(() => { throw Error("Must not inspect before authentication"); });
    const response = await handler(input, { params: { then } as unknown as Promise<{ id: string }> }); expect(response.status).toBe(401); safe(response);
    expect(then).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([GET, PATCH])("denies a current ordinary user before configuration facts", async handler => {
    mocks.actor.mockResolvedValue({ id: "actor", globalRole: "USER" }); expect((await handler(request(), context())).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("GET forwards only optional subject ID and path project, returning the saved minimized preview", async () => {
    const response = await GET(new Request(path + "?userId=subject"), context()); expect(response.status).toBe(200); safe(response);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ actorId: "actor", projectId: "project1", userId: "subject" }); expect(await response.json()).toEqual({ success: true, data: report }); expect(mocks.save).not.toHaveBeenCalled();
    mocks.read.mockClear(); await GET(new Request(path), context()); expect(mocks.read).toHaveBeenCalledWith({ actorId: "actor", projectId: "project1" });
  });
  it.each(["?userId=", "?userId=a&userId=b", "?userId=../bad", "?globalRole=ADMIN", "?policy=all", "?activeGroupIds=group1"])("rejects supplied subject facts or invalid GET query %s", async query => {
    const response = await GET(new Request(path + query), context()); expect(response.status).toBe(400); safe(response); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([null, policy, { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] }, { allEmployees: false, userIds: [], departmentIds: [], groupIds: [] }])("dispatches explicit complete policy including null/nobody/all %j", async inputPolicy => {
    mocks.save.mockResolvedValue({ ...result, result: { id: "project1", policy: inputPolicy } });
    const response = await patch(request({ policy: inputPolicy, ...meta })); expect(response.status).toBe(200); safe(response);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ actorId: "actor", projectId: "project1", policy: inputPolicy, ...meta });
    expect(await response.json()).toEqual({ success: true, data: { ...result, result: { id: "project1", policy: inputPolicy } } });
  });
  it.each([
    { ...meta }, { policy, ...meta, actorId: "other" }, { policy: { ...policy, denyUserIds: [] }, ...meta },
    { policy: { allEmployees: false, userIds: [], departmentIds: [] }, ...meta },
    { policy: { ...policy, allEmployees: true }, ...meta }, { policy: { ...policy, userIds: Array(21).fill("person1") }, ...meta },
    { policy: { ...policy, groupIds: ["../bad"] }, ...meta }, { policy, ...meta, operationId: "bad" }, { policy, ...meta, expectedVersion: -1 },
  ])("rejects malformed, mixed or unbounded policy body %#", async body => {
    const response = await patch(request(body)); expect(response.status).toBe(400); safe(response); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("accepts twenty raw IDs while preserving duplicates/order for the authoritative service normalization", async () => {
    const inputPolicy = { ...policy, userIds: Array(20).fill("person1") };
    expect((await patch(request({ policy: inputPolicy, ...meta }))).status).toBe(200); expect(mocks.save.mock.calls[0][0].policy).toEqual(inputPolicy);
  });
  it("rejects unrelated PATCH query fields before opening JSON reader", async () => {
    const input = request(undefined, "?userId=subject"); const read = vi.spyOn(input.body!, "getReader");
    expect((await patch(input)).status).toBe(400); expect(read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("awaits path params and rejects invalid targets before reading body", async () => {
    let resolve!: (value: { id: string }) => void; const params = new Promise<{ id: string }>(done => { resolve = done; });
    const pending = PATCH(request(), { params }); await Promise.resolve(); expect(mocks.save).not.toHaveBeenCalled(); resolve({ id: "path-target" }); await pending;
    expect(mocks.save.mock.calls[0][0].projectId).toBe("path-target"); mocks.save.mockClear();
    const input = request(); const read = vi.spyOn(input.body!, "getReader"); expect((await PATCH(input, { params: Promise.resolve({ id: "../bad" }) })).status).toBe(400); expect(read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["foreign", "missing", "cross-site-bearer"])("rejects %s Origin before policy persistence", async scenario => {
    const input = request(); if (scenario === "foreign") input.headers.set("origin", "https://foreign.invalid"); else input.headers.delete("origin");
    if (scenario === "cross-site-bearer") { input.headers.set("authorization", "Bearer synthetic-verified-token"); input.headers.set("sec-fetch-site", "cross-site"); }
    const read = vi.spyOn(input.body!, "getReader"); const response = await patch(input); expect(response.status).toBe(403); safe(response); expect(read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("passes exact historical replay metadata without issuing a changed policy intent", async () => {
    mocks.save.mockRejectedValueOnce(Error("Synthetic lost ACK")).mockResolvedValueOnce({ ...result, replayed: true });
    expect((await patch()).status).toBe(500); const response = await patch(); expect(await response.json()).toEqual({ success: true, data: { ...result, replayed: true } }); expect(mocks.save.mock.calls[0][0]).toEqual(mocks.save.mock.calls[1][0]);
  });
  it.each([[new ConflictError("synthetic-private"), 409], [new NotFoundError("synthetic-private"), 404], [Error("synthetic-private"), 500]] as const)("keeps policy read/save errors generic and no-store", async (failure, status) => {
    mocks.save.mockRejectedValue(failure); mocks.read.mockRejectedValue(failure);
    for (const response of [await patch(), await GET(new Request(path), context())]) { expect(response.status).toBe(status); safe(response); expect(response.headers.get("x-error-id")).toBeTruthy(); expect(await response.text()).not.toContain("synthetic-private"); }
  });
  it("enforces shared JSON size and omits raw policy payload/query values from technical logs", async () => {
    expect((await patch(request({ policy, ...meta, private: "x".repeat(17000) }))).status).toBe(413);
    expect((await patch(request({ policy, ...meta, private: { email: "synthetic-private@example.invalid" } }))).status).toBe(400);
    await GET(new Request(path + "?userId=synthetic-private-subject"), context());
    expect(mocks.save).not.toHaveBeenCalled(); expect(JSON.stringify([...mocks.info.mock.calls, ...mocks.warn.mock.calls])).not.toContain("synthetic-private");
  });
});
