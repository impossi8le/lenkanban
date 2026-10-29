import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), mark: vi.fn(), emit: vi.fn(), origin: vi.fn(), limit: vi.fn(), prisma: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.actor, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/request-queue-unseen", () => ({ markRequestQueueSeen: mocks.mark }));
vi.mock("@/socket/request-queue-events", () => ({ emitRequestQueueSeenInvalidation: mocks.emit }));
vi.mock("@/lib/mutation-origin", () => ({ requireTrustedMutationOrigin: mocks.origin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: mocks.limit, rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/middleware/api-logger", () => ({ withApiLogging: (request: Request, handler: (request: Request, trace: object) => unknown) => handler(request, {}) }));
import { POST } from "./route";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { UnauthorizedError } from "@/lib/require-api-user";

const run = (body: unknown = { queueEpoch: 7, expectedActorId: "actor" }) => POST(new Request("http://localhost/api/tasks/task/queue-seen", {
  method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "task" }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.mark.mockResolvedValue({ changed: true, stale: false });
  mocks.emit.mockResolvedValue(undefined);
  mocks.origin.mockReturnValue(undefined);
  mocks.limit.mockResolvedValue(undefined);
});

describe("explicit queue view acknowledgement", () => {
  it("passes server actor and expected epoch to the core and invalidates only after commit", async () => {
    let committed = false;
    mocks.mark.mockImplementation(async () => { committed = true; return { changed: true, stale: false }; });
    mocks.emit.mockImplementation(async (actorId: string) => { expect(actorId).toBe("actor"); expect(committed).toBe(true); });
    const response = await run();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).data).toEqual({ changed: true, stale: false });
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith(mocks.prisma, { actorId: "actor", expectedActorId: "actor", taskId: "task", queueEpoch: 7 });
    expect(mocks.emit).toHaveBeenCalledOnce();
  });
  it.each([{ changed: false, stale: false }, { changed: false, stale: true }])("keeps repeat/stale ACKs side-effect free: %j", async result => {
    mocks.mark.mockResolvedValueOnce(result);
    expect((await (await run()).json()).data).toEqual(result);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("rejects account rotation before calling the core or emitting", async () => {
    expect((await run({ queueEpoch: 7, expectedActorId: "previous-account" })).status).toBe(403);
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
  });
  it.each([0, -1, 0.5, "7", null, 2147483648])("rejects an invalid queue epoch %j", async queueEpoch => {
    expect((await run({ queueEpoch, expectedActorId: "actor" })).status).toBe(422);
    expect(mocks.mark).not.toHaveBeenCalled();
  });
  it.each([{ queueEpoch: 1 }, { queueEpoch: 1, expectedActorId: "actor", actorId: "other" }, { queueEpoch: 1, expectedActorId: "" }])("rejects missing or forged body fields %j", async body => {
    expect((await run(body)).status).toBe(422);
    expect(mocks.mark).not.toHaveBeenCalled();
  });
  it("requires authentication and the existing trusted origin before mutation", async () => {
    mocks.actor.mockRejectedValueOnce(new UnauthorizedError());
    expect((await run()).status).toBe(401);
    mocks.origin.mockImplementationOnce(() => { throw new ForbiddenError(); });
    expect((await run()).status).toBe(403);
    expect(mocks.mark).not.toHaveBeenCalled();
  });
  it.each([[new BadRequestError(), 400], [new ForbiddenError(), 403], [new NotFoundError(), 404], [new Error("sensitive backend detail"), 500]] as const)("maps a core failure safely to status %s", async (error, status) => {
    mocks.mark.mockRejectedValueOnce(error);
    const response = await run();
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive backend detail");
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("preserves a committed ACK if cache invalidation delivery fails", async () => {
    mocks.emit.mockRejectedValueOnce(new Error("offline"));
    expect((await run()).status).toBe(200);
    expect(mocks.mark).toHaveBeenCalledOnce();
  });
  it("rejects malformed or oversized JSON without a mutation", async () => {
    for (const body of ["{", JSON.stringify({ queueEpoch: 1, expectedActorId: "x".repeat(3000) })]) {
      const response = await POST(new Request("http://localhost/api/tasks/task/queue-seen", { method: "POST", headers: { "content-type": "application/json" }, body }), { params: Promise.resolve({ id: "task" }) });
      expect([400, 413]).toContain(response.status);
    }
    expect(mocks.mark).not.toHaveBeenCalled();
  });
});
