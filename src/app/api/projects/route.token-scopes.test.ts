import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(), used: vi.fn(), session: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { apiToken: { findUnique: mocks.token, update: mocks.used } } }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.session, isGlobalAdmin: (user: { globalRole: string }) => user.globalRole === "ADMIN" }));
vi.mock("@/lib/auth", () => ({ isAccountAllowed: async () => true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: vi.fn() }));
vi.mock("./board-creation", async original => ({ ...await original<typeof import("./board-creation")>(), createAuditedBoard: mocks.create }));
import { generateApiToken } from "@/lib/api-tokens";
import { POST } from "./route";
const user = { id: "admin", globalRole: "ADMIN" };
const token = generateApiToken().token;
const request = (bearer = true) => new Request("https://app.test/api/projects", { method: "POST",
  headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ name: "Board", departmentId: "department" }),
});
beforeEach(() => {
  vi.resetAllMocks(); mocks.used.mockResolvedValue({}); mocks.session.mockResolvedValue(user);
  mocks.token.mockResolvedValue({ id: "token", user, scopes: [], expiresAt: null, revokedAt: null });
  mocks.create.mockResolvedValue({ id: "board", columns: [], tags: [] });
});
describe("legacy board POST authentication boundary", () => {
  it("returns 401 for an expired token even with board.create", async () => {
    mocks.token.mockResolvedValue({ id: "token", user, scopes: ["board.create"], expiresAt: new Date(0), revokedAt: null });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it.each([{ scopes: [] }, { scopes: ["request.create"] }])("returns 403 without board.create: %j", async ({ scopes }) => {
    mocks.token.mockResolvedValue({ id: "token", user, scopes, expiresAt: null, revokedAt: null });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("writes successfully with board.create", async () => {
    mocks.token.mockResolvedValue({ id: "token", user, scopes: ["board.create"], expiresAt: null, revokedAt: null });
    expect((await POST(request())).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("keeps session creation working without token scopes", async () => {
    expect((await POST(request(false))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.token).not.toHaveBeenCalled();
  });
});
