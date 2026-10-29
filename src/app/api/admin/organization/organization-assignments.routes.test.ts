import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), leader: vi.fn(), primary: vi.fn(), rename: vi.fn(), move: vi.fn(), archive: vi.fn(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.user }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/organization", () => ({ createOrganizationService: () => ({
  setDepartmentLeader: mocks.leader, assignUserDepartment: mocks.primary,
  renameDepartment: mocks.rename, moveDepartment: mocks.move, setDepartmentArchived: mocks.archive,
}) }));

import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { PATCH as LEADER } from "./departments/[id]/route";
import { PATCH as PRIMARY } from "./people/[id]/route";

const meta = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 7 };
const leaderResult = { result: { id: "department1", name: "Synthetic department", parentId: null, leaderId: "person2", archived: false }, version: 8, replayed: false };
const primaryResult = { result: { id: "person1", primaryDepartmentId: "department2" }, version: 8, replayed: false };
const endpoints = [
  { name: "leader", handler: LEADER, path: "/api/admin/organization/departments/department1", id: "department1", write: mocks.leader,
    body: { kind: "leader", leaderId: "person2", ...meta }, result: leaderResult },
  { name: "primary", handler: PRIMARY, path: "/api/admin/organization/people/person1", id: "person1", write: mocks.primary,
    body: { departmentId: "department2", ...meta }, result: primaryResult },
] as const;
type Endpoint = typeof endpoints[number];
function request(endpoint: Endpoint, body: unknown = endpoint.body, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${endpoint.path}`, { method: "PATCH",
    headers: { origin: "https://app.test", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const invoke = (endpoint: Endpoint, input = request(endpoint)) => endpoint.handler(input, context(endpoint.id));
function expectNoWrites() {
  for (const write of [mocks.leader, mocks.primary, mocks.rename, mocks.move, mocks.archive]) expect(write).not.toHaveBeenCalled();
}
function expectSafeHeaders(response: Response, failure = false) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/i);
  if (failure) expect(response.headers.get("x-error-id")).toMatch(/^[a-f0-9-]{36}$/i);
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false");
  mocks.user.mockResolvedValue({ id: "authenticated-admin", globalRole: "ADMIN" });
  mocks.leader.mockResolvedValue(leaderResult); mocks.primary.mockResolvedValue(primaryResult);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each(endpoints)("$name assignment transport with real schemas, JSON and organizationApi", endpoint => {
  it.each(["unauthenticated", "USER", "PROJECT_ADMIN"])("checks fresh auth %s before reading params or body", async role => {
    if (role === "unauthenticated") mocks.user.mockRejectedValue(new UnauthorizedError());
    else mocks.user.mockResolvedValue({ id: "authenticated-admin", globalRole: role });
    const input = request(endpoint, { privateName: "synthetic-private" });
    const getReader = vi.spyOn(input.body!, "getReader");
    const then = vi.fn(() => { throw Error("Path must not be awaited before auth"); });
    const response = await endpoint.handler(input, { params: { then } as unknown as Promise<{ id: string }> });
    expect(response.status).toBe(role === "unauthenticated" ? 401 : 403);
    expectSafeHeaders(response, true); expect(then).not.toHaveBeenCalled(); expect(getReader).not.toHaveBeenCalled(); expectNoWrites();
  });
  it.each(["assign", "clear"])("dispatches %s with authenticated identity and exact metadata", async operation => {
    const value = operation === "clear" ? null : endpoint.name === "leader" ? "person2" : "department2";
    const body = endpoint.name === "leader" ? { ...meta, kind: "leader", leaderId: value } : { ...meta, departmentId: value };
    const result = endpoint.name === "leader" ? { ...leaderResult, result: { ...leaderResult.result, leaderId: value } }
      : { ...primaryResult, result: { ...primaryResult.result, primaryDepartmentId: value } };
    endpoint.write.mockResolvedValue(result);
    const response = await invoke(endpoint, request(endpoint, body));
    expect(response.status).toBe(200); expectSafeHeaders(response);
    expect(await response.json()).toEqual({ success: true, data: result });
    expect(endpoint.write).toHaveBeenCalledExactlyOnceWith(endpoint.name === "leader"
      ? { actorId: "authenticated-admin", departmentId: "department1", userId: value, ...meta }
      : { actorId: "authenticated-admin", userId: "person1", departmentId: value, ...meta });
    expect([mocks.leader, mocks.primary, mocks.rename, mocks.move, mocks.archive].filter(write => write.mock.calls.length)).toHaveLength(1);
  });
  it("awaits asynchronous path params and obtains the target only from the path", async () => {
    let resolve!: (value: { id: string }) => void;
    const params = new Promise<{ id: string }>(done => { resolve = done; });
    const pending = endpoint.handler(request(endpoint), { params });
    await Promise.resolve(); expectNoWrites();
    resolve({ id: "path-selected-target" });
    expect((await pending).status).toBe(200);
    expect(endpoint.write.mock.calls[0][0]).toMatchObject(endpoint.name === "leader"
      ? { departmentId: "path-selected-target", userId: "person2" } : { userId: "path-selected-target", departmentId: "department2" });
  });
  it("preserves unknown-response retry UUID/version and passes through historical replay ACK", async () => {
    endpoint.write.mockRejectedValueOnce(Error("synthetic lost ACK")).mockResolvedValueOnce({ ...endpoint.result, replayed: true });
    expect((await invoke(endpoint)).status).toBe(500);
    const retry = await invoke(endpoint);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ success: true, data: { ...endpoint.result, replayed: true } });
    expect(endpoint.write.mock.calls[0][0]).toEqual(endpoint.write.mock.calls[1][0]);
    expect(endpoint.write.mock.calls[1][0]).toMatchObject(meta);
  });
  it.each([
    { operationId: "not-a-uuid" }, { operationId: null }, { operationId: undefined },
    { expectedVersion: -1 }, { expectedVersion: 2147483648 }, { expectedVersion: 0.5 }, { expectedVersion: "7" }, { expectedVersion: undefined },
  ])("rejects malformed or missing command metadata %j", async override => {
    const response = await invoke(endpoint, request(endpoint, { ...endpoint.body, ...override }));
    expect(response.status).toBe(400); expectSafeHeaders(response, true); expectNoWrites();
  });
  it.each([0, 2147483647])("forwards valid expectedVersion boundary %s without transport coercion", async expectedVersion => {
    expect((await invoke(endpoint, request(endpoint, { ...endpoint.body, expectedVersion }))).status).toBe(200);
    expect(endpoint.write.mock.calls[0][0].expectedVersion).toBe(expectedVersion);
  });
  it.each(["actorId", "globalRole", "userId", "name", "email", "projectRole", "grants"])("rejects privileged or mixed field %s rather than stripping it", async field => {
    const response = await invoke(endpoint, request(endpoint, { ...endpoint.body, [field]: "synthetic-private" }));
    expect(response.status).toBe(400); expectNoWrites();
    expect(await response.text()).not.toContain("synthetic-private");
  });
  it.each(["", "../private", "x".repeat(129), " space", "user@example.invalid"])("rejects invalid path target %j before reading JSON", async id => {
    const input = request(endpoint); const reader = vi.spyOn(input.body!, "getReader");
    const response = await endpoint.handler(input, context(id));
    expect(response.status).toBe(400); expect(reader).not.toHaveBeenCalled(); expectNoWrites();
  });
  it.each([undefined, "", "../private", 123, false, {}, "x".repeat(129)])("rejects missing or invalid nullable assignment value %j", async value => {
    const body = endpoint.name === "leader" ? { ...meta, kind: "leader", leaderId: value } : { ...meta, departmentId: value };
    expect((await invoke(endpoint, request(endpoint, body))).status).toBe(400); expectNoWrites();
  });
  it.each([null, [], "synthetic-private"])("rejects a non-object JSON body %j", async body => {
    expect((await invoke(endpoint, request(endpoint, body))).status).toBe(400); expectNoWrites();
  });
  it.each(["foreign", "missing", "cross-site-bearer", "tab-bearer"])("rejects Origin violation %s before reading body", async scenario => {
    const input = request(endpoint);
    if (scenario === "foreign") input.headers.set("origin", "https://foreign.invalid");
    else input.headers.delete("origin");
    if (scenario === "cross-site-bearer") { input.headers.set("authorization", "Bearer synthetic-verified-token"); input.headers.set("sec-fetch-site", "cross-site"); }
    if (scenario === "tab-bearer") input.headers.set("authorization", "Bearer\tinvalid");
    const reader = vi.spyOn(input.body!, "getReader");
    const response = await invoke(endpoint, input);
    expect(response.status).toBe(403); expectSafeHeaders(response, true); expect(reader).not.toHaveBeenCalled(); expectNoWrites();
  });
  it("permits a previously verified bearer without Origin", async () => {
    const input = request(endpoint, endpoint.body, { authorization: "Bearer synthetic-verified-token" }); input.headers.delete("origin");
    expect((await invoke(endpoint, input)).status).toBe(200); expect(endpoint.write).toHaveBeenCalledOnce();
    // Credential verification itself belongs to actual requireApiUser tests.
  });
  it.each([[new ConflictError("synthetic-private"), 409], [new ForbiddenError("synthetic-private"), 403],
    [new NotFoundError("synthetic-private"), 404], [new ValidationError("synthetic-private"), 400],
    [new Error("synthetic-private-db-detail"), 500]] as const)("returns safe no-store service error status %s", async (failure, status) => {
    endpoint.write.mockRejectedValue(failure);
    const response = await invoke(endpoint);
    expect(response.status).toBe(status); expectSafeHeaders(response, true);
    expect(await response.text()).not.toContain("synthetic-private"); expect(endpoint.write).toHaveBeenCalledOnce();
  });
  it("enforces declared and actual 16KiB JSON body bounds before invoking service", async () => {
    const declared = request(endpoint); declared.headers.set("content-length", "17000");
    const reader = vi.spyOn(declared.body!, "getReader");
    expect((await invoke(endpoint, declared)).status).toBe(413); expect(reader).not.toHaveBeenCalled();
    const actual = request(endpoint, { ...endpoint.body, secret: "x".repeat(17000) });
    expect((await invoke(endpoint, actual)).status).toBe(413); expectNoWrites();
  });
  it("rejects malformed JSON and incompatible content types without persistence", async () => {
    const malformed = new Request(`https://app.test${endpoint.path}`, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json" }, body: "{" });
    expect((await invoke(endpoint, malformed)).status).toBe(400);
    const wrongType = request(endpoint); wrongType.headers.set("content-type", "text/plain");
    expect((await invoke(endpoint, wrongType)).status).toBe(415); expectNoWrites();
  });
  it("hard-bounds a stalled JSON stream at five seconds without mutation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel });
    const input = new Request(`https://app.test${endpoint.path}`, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json" }, body,
      duplex: "half" } as RequestInit);
    const pending = invoke(endpoint, input);
    await vi.advanceTimersByTimeAsync(5001);
    const response = await pending;
    expect(response.status).toBe(408); expectSafeHeaders(response, true); expect(cancel).toHaveBeenCalledOnce(); expectNoWrites();
  });
  it("omits user input and query values from technical log records", async () => {
    const input = new Request(`https://app.test${endpoint.path}?q=synthetic-private-search`, { method: "PATCH",
      headers: { origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({ ...endpoint.body, email: "synthetic-private@example.invalid", nested: { password: "synthetic-private-secret" } }) });
    expect((await invoke(endpoint, input)).status).toBe(400); expectNoWrites();
    expect(JSON.stringify([...mocks.info.mock.calls, ...mocks.warn.mock.calls, ...mocks.error.mock.calls])).not.toContain("synthetic-private");
  });
});

it("rejects leader mixed-kind payloads without routing to a legacy department mutator", async () => {
  const endpoint = endpoints[0];
  for (const body of [{ ...endpoint.body, parentId: "other" }, { ...endpoint.body, archived: true }, { ...endpoint.body, kind: "rename", name: "Synthetic" },
    { ...meta, kind: "leader" }, { ...meta, kind: "unknown", leaderId: null }]) {
    expect((await invoke(endpoint, request(endpoint, body))).status).toBe(400);
  }
  expectNoWrites();
});
