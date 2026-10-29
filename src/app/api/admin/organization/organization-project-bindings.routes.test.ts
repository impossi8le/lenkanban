import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), bind: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.user }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/organization-reader", () => ({ createOrganizationReader: () => ({ projects: mocks.list }) }));
vi.mock("@/lib/organization", () => ({ createOrganizationService: () => ({ bindProject: mocks.bind }) }));
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { GET } from "./projects/route";
import { PATCH } from "./projects/[id]/route";

const endpoint = "/api/admin/organization/projects";
const meta = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 9 };
const body = { ...meta, departmentId: "department1", responsibleGroupId: "group1" };
const mutation = { result: { id: "project1", departmentId: "department1", responsibleGroupId: "group1" }, version: 10, replayed: false };
const page = { items: [{ id: "project1", displayName: "Synthetic board", departmentId: "department1", responsibleGroupId: "group1" }], version: 9, nextCursor: null };
function request(value: unknown = body, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${endpoint}/project1`, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
}
function patch(input = request(), id = "project1") { return PATCH(input, { params: Promise.resolve({ id }) }); }
function noStore(response: Response) { expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/i); }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false");
  mocks.user.mockResolvedValue({ id: "authenticated-admin", globalRole: "ADMIN" });
  mocks.list.mockResolvedValue(page); mocks.bind.mockResolvedValue(mutation);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("project binding HTTP boundary with real organizationApi/schema/JSON/middleware", () => {
  it.each(["GET", "PATCH"] as const)("%s authenticates before body/params or data access", async method => {
    mocks.user.mockRejectedValue(new UnauthorizedError());
    const input = request({ rawPrivate: "synthetic-private" }); const reader = vi.spyOn(input.body!, "getReader");
    const then = vi.fn(() => { throw Error("Must not await before auth"); });
    const response = method === "GET" ? await GET(input) : await PATCH(input, { params: { then } as unknown as Promise<{ id: string }> });
    expect(response.status).toBe(401); noStore(response); expect(then).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.bind).not.toHaveBeenCalled();
  });
  it.each(["USER", "PROJECT_ADMIN"])("denies %s on both GET and PATCH before reading metadata", async globalRole => {
    mocks.user.mockResolvedValue({ id: "authenticated-admin", globalRole });
    for (const handler of [GET, patch]) { const response = await handler(request()); expect(response.status).toBe(403); noStore(response); }
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("forwards bounded GET parameters only to the reader and emits a minimized no-store envelope", async () => {
    const response = await GET(new Request(`https://app.test${endpoint}?q=synthetic-private-search&limit=2&cursor=opaque`));
    expect(response.status).toBe(200); noStore(response);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ actorId: "authenticated-admin", q: "synthetic-private-search", limit: 2, cursor: "opaque" });
    expect(await response.json()).toEqual({ success: true, data: page }); expect(mocks.bind).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("synthetic-private-search");
  });
  it.each(["?limit=101", "?limit=1&limit=2", "?q=", "?cursor=", "?ownerId=other"])("rejects invalid GET query %s before reader", async query => {
    const response = await GET(new Request(`https://app.test${endpoint}${query}`));
    expect(response.status).toBe(400); noStore(response); expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([
    { departmentId: "department1", responsibleGroupId: "group1" },
    { departmentId: null, responsibleGroupId: "group1" },
    { departmentId: "department1", responsibleGroupId: null },
    { departmentId: null, responsibleGroupId: null },
  ])("forwards both explicit nullable links as one complete command %j", async links => {
    const result = { ...mutation, result: { id: "project1", ...links } }; mocks.bind.mockResolvedValue(result);
    const response = await patch(request({ ...meta, ...links }));
    expect(response.status).toBe(200); noStore(response);
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith({ actorId: "authenticated-admin", projectId: "project1", ...meta, ...links });
    expect(await response.json()).toEqual({ success: true, data: result }); expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([
    { ...meta, departmentId: null }, { ...meta, responsibleGroupId: null },
    { ...body, departmentId: undefined }, { ...body, responsibleGroupId: false },
    { ...body, departmentId: "../private" }, { ...body, actorId: "other" },
    { ...body, projectId: "other" }, { ...body, ownerId: "other", members: ["person1"] },
    { ...body, operationId: "bad" }, { ...body, expectedVersion: -1 }, { ...body, expectedVersion: 2147483648 },
  ])("rejects incomplete, privileged or malformed binding commands %#", async invalid => {
    const response = await patch(request(invalid)); expect(response.status).toBe(400); noStore(response); expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("awaits path identity and never derives project identity from caller fields", async () => {
    let resolve!: (value: { id: string }) => void;
    const params = new Promise<{ id: string }>(done => { resolve = done; });
    const pending = PATCH(request(), { params }); await Promise.resolve(); expect(mocks.bind).not.toHaveBeenCalled();
    resolve({ id: "path-project" }); expect((await pending).status).toBe(200);
    expect(mocks.bind.mock.calls[0][0]).toEqual({ actorId: "authenticated-admin", projectId: "path-project", ...body });
    mocks.bind.mockClear(); const invalidPath = request(); const getReader = vi.spyOn(invalidPath.body!, "getReader");
    expect((await patch(invalidPath, "../private")).status).toBe(400); expect(getReader).not.toHaveBeenCalled(); expect(mocks.bind).not.toHaveBeenCalled();
  });
  it.each([
    { taskId: 'business-request', destinationProjectId: 'other-board' },
    { taskIds: ['business-request'], projectId: 'other-board' },
    { action: 'moveTask', targetBoardId: 'other-board' },
    { automation: { action: 'moveTask', projectId: 'other-board' } },
  ])("cannot smuggle request relocation through an administrative board binding %#", async extra => {
    const response = await patch(request({ ...body, ...extra }));
    expect(response.status).toBe(400); noStore(response);
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("preserves exact retry body and historical receipt metadata without inferring a partial patch", async () => {
    mocks.bind.mockRejectedValueOnce(Error("Synthetic lost ACK")).mockResolvedValueOnce({ ...mutation, version: 10, replayed: true });
    expect((await patch()).status).toBe(500); const retry = await patch();
    expect(retry.status).toBe(200); expect(await retry.json()).toEqual({ success: true, data: { ...mutation, replayed: true } });
    expect(mocks.bind.mock.calls[0][0]).toEqual(mocks.bind.mock.calls[1][0]); expect(mocks.bind.mock.calls[1][0]).toMatchObject(body);
  });
  it.each(["foreign-origin", "cookie-no-origin", "cross-site-bearer"])("rejects %s before JSON and service", async scenario => {
    const input = request();
    if (scenario === "foreign-origin") input.headers.set("origin", "https://foreign.invalid"); else input.headers.delete("origin");
    if (scenario === "cross-site-bearer") { input.headers.set("authorization", "Bearer synthetic-verified-token"); input.headers.set("sec-fetch-site", "cross-site"); }
    const getReader = vi.spyOn(input.body!, "getReader"); const response = await patch(input);
    expect(response.status).toBe(403); noStore(response); expect(getReader).not.toHaveBeenCalled(); expect(mocks.bind).not.toHaveBeenCalled();
  });
  it.each([[new ConflictError("synthetic-private"), 409], [new ForbiddenError("synthetic-private"), 403],
    [new NotFoundError("synthetic-private"), 404], [Error("synthetic-private"), 500]] as const)("maps service errors to fixed private no-store responses", async (error, expected) => {
    mocks.bind.mockRejectedValue(error); const response = await patch();
    expect(response.status).toBe(expected); noStore(response); expect(response.headers.get("x-error-id")).toBeTruthy();
    expect(await response.text()).not.toContain("synthetic-private");
  });
  it("preserves reader version conflicts as409 rather than an empty successful project page", async () => {
    mocks.list.mockRejectedValue(new ConflictError("synthetic-private-reader"));
    const response = await GET(new Request(`https://app.test${endpoint}?cursor=opaque`));
    expect(response.status).toBe(409); noStore(response); expect(await response.text()).not.toContain("synthetic-private-reader"); expect(mocks.bind).not.toHaveBeenCalled();
  });
  it("uses the existing JSON size boundary and omits rejected nested body/query fields from technical logs", async () => {
    expect((await patch(request({ ...body, privateField: "x".repeat(17000) }))).status).toBe(413);
    const input = new Request(`https://app.test${endpoint}/project1?q=synthetic-private-query`, { method: "PATCH",
      headers: { origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({ ...body, nested: { description: "synthetic-private-description", email: "synthetic-private@example.invalid" } }) });
    expect((await patch(input)).status).toBe(400); expect(mocks.bind).not.toHaveBeenCalled();
    expect(JSON.stringify([...mocks.info.mock.calls, ...mocks.warn.mock.calls])).not.toContain("synthetic-private");
  });
});
