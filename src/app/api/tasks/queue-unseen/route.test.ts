import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), counts: vi.fn(), limit: vi.fn(), prisma: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.actor, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueUnseenCounts: mocks.counts }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: mocks.limit, rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/middleware/api-logger", () => ({ withApiLogging: (request: Request, handler: (request: Request, trace: object) => unknown) => handler(request, {}) }));
import { GET } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.counts.mockResolvedValue({ byProject: { board: 2 }, total: 2 });
  mocks.limit.mockResolvedValue(undefined);
});

describe("actor-specific unseen queue counts", () => {
  it("uses only the authenticated actor and returns a noncacheable computed count", async () => {
    const response = await GET(new Request("http://localhost/api/tasks/queue-unseen"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).data).toEqual({ byProject: { board: 2 }, total: 2 });
    expect(mocks.counts).toHaveBeenCalledExactlyOnceWith(mocks.prisma, "actor");
    expect(mocks.limit).toHaveBeenCalledExactlyOnceWith("tasks:list", "actor");
  });
  it("rejects forged actor query parameters before the protected read", async () => {
    expect((await GET(new Request("http://localhost/api/tasks/queue-unseen?actorId=other"))).status).toBe(400);
    expect(mocks.counts).not.toHaveBeenCalled();
  });
  it("does not read counts without authentication or after quota failure", async () => {
    mocks.actor.mockRejectedValueOnce(new UnauthorizedError());
    expect((await GET(new Request("http://localhost/api/tasks/queue-unseen"))).status).toBe(401);
    mocks.limit.mockRejectedValueOnce(new Error("quota"));
    expect((await GET(new Request("http://localhost/api/tasks/queue-unseen"))).status).toBe(429);
    expect(mocks.counts).not.toHaveBeenCalled();
  });
  it("does not fall back to global counts when fresh projection fails", async () => {
    mocks.counts.mockRejectedValueOnce(new Error("sensitive failure"));
    const response = await GET(new Request("http://localhost/api/tasks/queue-unseen"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive failure");
  });
});
