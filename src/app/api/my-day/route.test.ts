import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn(), save: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user }));
vi.mock("@/lib/my-day-service", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/my-day-service")>(), createMyDayService: () => ({ read: mocks.read, save: mocks.save }) }));
vi.mock("@/middleware/api-logger", () => ({ withApiLogging: (request: Request, handler: (request: Request, context: object) => Promise<Response>, context: object) => { mocks.log(context); return handler(request, { ...context }); } }));
import { GET, PUT } from "./route";
import { MyDayConflict } from "@/lib/my-day-service";
import { UnauthorizedError } from "@/lib/errors";
import { MY_DAY_ACTOR_HEADER, MY_DAY_SESSION_CHANGED } from "@/lib/my-day-contract";

const origin = "http://localhost:3555";
const entry = { date: "2026-10-29", text: "SYNTHETIC_DIARY_SECRET", version: 1, updatedAt: "2026-10-29T12:00:00Z", today: "2026-10-29" };
const input = () => ({ text: entry.text, expectedVersion: 0, operationId: randomUUID() });
function request(method = "GET", query = "date=2026-10-29", body: unknown = input(), headers = {}) {
  return new Request(`${origin}/api/my-day?${query}`, { method, headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", [MY_DAY_ACTOR_HEADER]: "alice", ...headers }, ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: "alice", globalRole: "ADMIN" }); mocks.read.mockResolvedValue(entry); mocks.save.mockResolvedValue(entry); vi.stubEnv("NEXT_PUBLIC_APP_URL", origin); });

describe("private diary route (mock auth/repository)", () => {
  it.each(["GET", "PUT"])("rejects cookie B with stale UI actor A before reading data or body (%s)", async method => {
    mocks.user.mockResolvedValue({ id: "bob", globalRole: "ADMIN" });
    const stale = request(method);
    const bodyRead = vi.spyOn(stale, "body", "get");
    const response = await (method === "GET" ? GET(stale) : PUT(stale));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const payload = await response.json();
    expect(payload.error.code).toBe(MY_DAY_SESSION_CHANGED);
    expect(JSON.stringify(payload)).not.toContain(entry.text);
    expect(payload.error.details).toBeUndefined();
    expect(bodyRead).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["GET", "PUT"])("requires an explicit UI actor binding before reading data or body (%s)", async method => {
    const missing = request(method); missing.headers.delete(MY_DAY_ACTOR_HEADER);
    const bodyRead = vi.spyOn(missing, "body", "get");
    const response = await (method === "GET" ? GET(missing) : PUT(missing));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(MY_DAY_SESSION_CHANGED);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("selects the authenticated owner, with no ADMIN override and private caching", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).toHaveBeenCalledWith("alice", "2026-10-29");
    expect(await response.json()).toEqual({ success: true, data: entry });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(entry.text);
  });
  it.each(["date=2026-10-29&ownerId=bob", "date=2026-10-29&date=2026-10-28", "date=2026-02-29", ""])("rejects malformed or foreign query %s", async query => {
    expect((await GET(request("GET", query))).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("denies unauthenticated and revoked sessions before diary access", async () => {
    mocks.user.mockRejectedValue(new UnauthorizedError());
    for (const response of [await GET(request()), await PUT(request("PUT"))]) { expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toContain("no-store"); }
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects bearer credentials even for reads", async () => {
    expect((await GET(request("GET", undefined, undefined, { authorization: "Bearer synthetic" }))).status).toBe(403);
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("requires same origin before reading the write body", async () => {
    const response = await PUT(request("PUT", undefined, input(), { origin: "https://other.invalid" }));
    expect(response.status).toBe(403); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("saves the owner's exact input", async () => {
    const body = input(); expect((await PUT(request("PUT", undefined, body))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith("alice", "2026-10-29", body);
  });
  it("returns the current owner version on conflict", async () => {
    mocks.save.mockRejectedValue(new MyDayConflict(entry)); const response = await PUT(request("PUT"));
    expect(response.status).toBe(409); expect((await response.json()).error.details).toEqual({ current: entry });
  });
  it.each([{ ...input(), ownerId: "bob" }, { ...input(), text: "x".repeat(50001) }, { ...input(), expectedVersion: -1 }, { ...input(), operationId: "bad" }])("rejects invalid bodies without reflecting secret values", async body => {
    const response = await PUT(request("PUT", undefined, body)); expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(entry.text); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not reflect raw database errors, nested data or parser failures", async () => {
    mocks.save.mockRejectedValue(Object.assign(new Error(entry.text), { cause: { text: entry.text } }));
    const failure = await PUT(request("PUT")); expect(failure.status).toBe(500); expect(await failure.text()).not.toContain(entry.text);
    const malformed = new Request(`${origin}/api/my-day?date=2026-10-29`, { method: "PUT", headers: { origin, "content-type": "application/json", [MY_DAY_ACTOR_HEADER]: "alice" }, body: `{${entry.text}` });
    const response = await PUT(malformed); expect(response.status).toBe(400); expect(await response.text()).not.toContain(entry.text);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(entry.text);
  });
});
