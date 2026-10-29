import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ actor: vi.fn(), fresh: vi.fn(), project: vi.fn(), state: vi.fn(), save: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/prisma", () => { const tx = { $queryRaw: m.query, user: { findUnique: m.fresh }, project: { findUnique: m.project }, organizationState: { findUnique: m.state } }; return { prisma: { ...tx, $transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx) } }; });
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: m.actor }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: m.info, warn: m.warn, error: m.error } }));
vi.mock("@/lib/organization", () => ({ createOrganizationService: () => ({ setProjectLifecycleColumns: m.save }) }));
vi.mock("@/socket/board-events", () => ({ emitColumnCreated: vi.fn() }));
import { GET, PUT } from "./[id]/columns/route";
const map = { contractVersion: 1, submittedColumnId: "new", inProgressColumnId: "work", needsInfoColumnId: "wait", completedColumnId: "resolved", closedColumnId: "closed" };
const body = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 3, lifecycleColumnMap: map };
const path = "https://app.test/api/projects/project/columns";
const context = () => ({ params: Promise.resolve({ id: "project" }) });
const request = (value: unknown = body) => new Request(path, { method: "PUT", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(value) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false"); vi.stubEnv("NEXT_PUBLIC_APP_URL", ""); vi.stubEnv("APP_URL", ""); vi.stubEnv("NEXTAUTH_URL", "https://app.test");
  m.actor.mockResolvedValue({ id: "admin", globalRole: "ADMIN" }); m.fresh.mockResolvedValue({ globalRole: "ADMIN" });
  m.project.mockResolvedValue({ lifecycleColumnMap: map }); m.state.mockResolvedValue({ version: 3 }); m.save.mockResolvedValue({ result: { id: "project", lifecycleColumnMap: map }, version: 4, replayed: false });
});
afterEach(() => vi.unstubAllEnvs());
describe("strict ADMIN lifecycle column configuration transport", () => {
  it("returns explicit persisted mapping and version only after fresh ADMIN check", async () => {
    const response = await GET(new Request(path + "?lifecycle=1"), context());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: { lifecycleColumnMap: map, version: 3 } });
    m.fresh.mockResolvedValue({ globalRole: "USER" }); m.project.mockClear();
    expect((await GET(new Request(path + "?lifecycle=1"), context())).status).toBe(403); expect(m.project).not.toHaveBeenCalled();
  });
  it("forwards normalized complete intent to the audited service", async () => {
    expect((await PUT(request(), context())).status).toBe(200);
    expect(m.save).toHaveBeenCalledExactlyOnceWith({ actorId: "admin", projectId: "project", ...body });
  });
  it.each([{ ...body, actorId: "forged" }, { ...body, lifecycleColumnMap: { ...map, unknown: true } }, { ...body, lifecycleColumnMap: { ...map, needsInfoColumnId: "work" } }, { ...body, expectedVersion: -1 }])("rejects unknown fields and malformed mapping %# before service", async value => {
    expect((await PUT(request(value), context())).status).toBe(400); expect(m.save).not.toHaveBeenCalled();
  });
  it("rejects ordinary session roles and foreign origins before configuration persistence", async () => {
    m.actor.mockResolvedValue({ id: "ordinary", globalRole: "USER" });
    expect((await PUT(request(), context())).status).toBe(403);
    m.actor.mockResolvedValue({ id: "admin", globalRole: "ADMIN" }); const input = request(); input.headers.set("origin", "https://foreign.invalid");
    expect((await PUT(input, context())).status).toBe(403); expect(m.save).not.toHaveBeenCalled();
  });
});
