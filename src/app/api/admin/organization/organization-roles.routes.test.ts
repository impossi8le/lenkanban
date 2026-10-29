import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), list: vi.fn(), role: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.actor }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/organization", () => ({ createOrganizationService: () => ({ setGlobalRole: mocks.role }) }));
vi.mock("@/lib/organization-reader", () => ({ createOrganizationReader: () => ({ roles: mocks.list }) }));
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { GET } from "./roles/route";
import { PATCH } from "../users/[id]/route";

const meta = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 3 };
const command = { globalRole: "ADMIN", ...meta };
const result = { result: { id: "target", globalRole: "ADMIN" }, version: 4, replayed: false };
function input(body: unknown = command) { return new Request("https://app.test/api/admin/users/target", { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body) }); }
const patch = (request = input(), id = "target") => PATCH(request, { params: Promise.resolve({ id }) });
function headers(response: Response) { expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/i); }
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false"); mocks.actor.mockResolvedValue({ id: "current-admin", globalRole: "ADMIN" }); mocks.role.mockResolvedValue(result); mocks.list.mockResolvedValue({ items: [{ id: "target", displayName: "Synthetic", globalRole: "USER" }], version: 3, nextCursor: null }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("global role read and audited legacy PATCH route transport", () => {
  it.each(["unauthenticated", "USER", "PROJECT_ADMIN"])("denies %s before JSON/path/reader or role command", async role => {
    if (role === "unauthenticated") mocks.actor.mockRejectedValue(new UnauthorizedError()); else mocks.actor.mockResolvedValue({ id: "current-admin", globalRole: role });
    const request = input({ private: "synthetic-private" }); const read = vi.spyOn(request.body!, "getReader"); const then = vi.fn(() => { throw Error("Must authenticate before path"); });
    const response = await PATCH(request, { params: { then } as unknown as Promise<{ id: string }> });
    expect(response.status).toBe(role === "unauthenticated" ? 401 : 403); headers(response); expect(read).not.toHaveBeenCalled(); expect(then).not.toHaveBeenCalled();
    const list = await GET(new Request("https://app.test/api/admin/organization/roles")); expect(list.status).toBe(response.status); headers(list);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.role).not.toHaveBeenCalled();
  });
  it("GET forwards bounded name/id search only to the minimized reader and omits query from logs", async () => {
    const response = await GET(new Request("https://app.test/api/admin/organization/roles?q=synthetic-private-search&limit=2&cursor=opaque"));
    expect(response.status).toBe(200); headers(response);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ actorId: "current-admin", q: "synthetic-private-search", limit: 2, cursor: "opaque" });
    expect(await response.json()).toMatchObject({ success: true, data: { version: 3, items: [{ id: "target", globalRole: "USER", displayName: "Synthetic" }] } });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("synthetic-private-search"); expect(mocks.role).not.toHaveBeenCalled();
  });
  it.each(["?limit=101", "?q=a&q=b", "?actorId=other", "?cursor="])("rejects invalid role list query %s", async query => {
    expect((await GET(new Request(`https://app.test/api/admin/organization/roles${query}`))).status).toBe(400); expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(["USER", "ADMIN"])("PATCH delegates %s with current actor, path target and exact command metadata", async globalRole => {
    mocks.role.mockResolvedValue({ ...result, result: { id: "target", globalRole } });
    const response = await patch(input({ ...meta, globalRole })); expect(response.status).toBe(200); headers(response);
    expect(mocks.role).toHaveBeenCalledExactlyOnceWith({ actorId: "current-admin", userId: "target", globalRole, ...meta });
    expect(await response.json()).toEqual({ success: true, data: { ...result, result: { id: "target", globalRole } } });
  });
  it.each([
    { globalRole: "ADMIN" }, { ...command, operationId: "bad" }, { ...command, expectedVersion: -1 },
    { ...command, expectedVersion: 2147483648 }, { ...command, globalRole: "admin" },
    { ...command, actorId: "other" }, { ...command, userId: "other" }, { ...command, email: "synthetic-private" },
  ])("rejects legacy, malformed or privileged payload %# without unaudited compatibility", async body => {
    const response = await patch(input(body)); expect(response.status).toBe(400); headers(response); expect(mocks.role).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("synthetic-private");
  });
  it("awaits async target params and rejects malformed target before body", async () => {
    let resolve!: (value: { id: string }) => void; const params = new Promise<{ id: string }>(done => { resolve = done; });
    const pending = PATCH(input(), { params }); await Promise.resolve(); expect(mocks.role).not.toHaveBeenCalled(); resolve({ id: "path-target" }); await pending;
    expect(mocks.role.mock.calls[0][0].userId).toBe("path-target"); mocks.role.mockClear();
    const request = input(); const read = vi.spyOn(request.body!, "getReader"); expect((await patch(request, "../bad")).status).toBe(400); expect(read).not.toHaveBeenCalled(); expect(mocks.role).not.toHaveBeenCalled();
  });
  it.each(["foreign", "missing", "cross-site-bearer"])("blocks %s Origin before JSON or service", async scenario => {
    const request = input(); if (scenario === "foreign") request.headers.set("origin", "https://foreign.invalid"); else request.headers.delete("origin");
    if (scenario === "cross-site-bearer") { request.headers.set("authorization", "Bearer synthetic-verified-token"); request.headers.set("sec-fetch-site", "cross-site"); }
    const read = vi.spyOn(request.body!, "getReader"); const response = await patch(request); expect(response.status).toBe(403); headers(response); expect(read).not.toHaveBeenCalled(); expect(mocks.role).not.toHaveBeenCalled();
  });
  it("passes historical replay ACK without issuing another role intent or widening its DTO", async () => {
    mocks.role.mockRejectedValueOnce(Error("Synthetic unknown ACK")).mockResolvedValueOnce({ ...result, replayed: true });
    expect((await patch()).status).toBe(500); const response = await patch();
    expect(await response.json()).toEqual({ success: true, data: { ...result, replayed: true } }); expect(mocks.role.mock.calls[0][0]).toEqual(mocks.role.mock.calls[1][0]);
  });
  it.each([[new ConflictError("synthetic-private"), 409], [new ForbiddenError(), 403], [new NotFoundError(), 404], [Error("synthetic-private"), 500]] as const)("returns generic correlated no-store command errors", async (error, status) => {
    mocks.role.mockRejectedValue(error); const response = await patch(); expect(response.status).toBe(status); headers(response); expect(response.headers.get("x-error-id")).toBeTruthy(); expect(await response.text()).not.toContain("synthetic-private");
  });
  it("keeps cursor version conflict distinct from empty successful role inventory", async () => {
    mocks.list.mockRejectedValue(new ConflictError()); const response = await GET(new Request("https://app.test/api/admin/organization/roles?cursor=opaque")); expect(response.status).toBe(409); headers(response); expect(mocks.role).not.toHaveBeenCalled();
  });
  it("uses shared JSON bounds and excludes rejected private body fields from technical context", async () => {
    expect((await patch(input({ ...command, raw: "x".repeat(17000) }))).status).toBe(413);
    expect((await patch(input({ ...command, private: { email: "synthetic-private@example.invalid" } }))).status).toBe(400);
    expect(mocks.role).not.toHaveBeenCalled(); expect(JSON.stringify([...mocks.info.mock.calls, ...mocks.warn.mock.calls])).not.toContain("synthetic-private");
  });
});
