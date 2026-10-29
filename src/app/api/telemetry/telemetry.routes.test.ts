import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), consume: vi.fn(), start: vi.fn(), ingest: vi.fn(), admin: vi.fn(), cleanup: vi.fn(), repair: vi.fn(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.user,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/require-user", () => ({ isGlobalAdmin: (actor: { role: string }) => actor.role === "ADMIN" }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/telemetry/store", () => ({
  telemetryActorKey: (id: string) => `v1:${id}`,
  consumeTelemetryRateLimits: mocks.consume, startTelemetrySession: mocks.start,
  ingestTelemetryBatch: mocks.ingest, readAdminTelemetry: mocks.admin,
  cleanupTelemetry: mocks.cleanup, projectPendingChecklistTelemetry: mocks.repair,
}));
import { UnauthorizedError } from "@/lib/require-api-user";
import { POST } from "./route";
import { GET } from "../admin/telemetry/route";
import { POST as CLEANUP } from "./cleanup/route";

const sessionId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("NEXTAUTH_URL", "");
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-secret-with-at-least-32-characters");
  vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
  mocks.user.mockResolvedValue({ id: "actor1", role: "ADMIN" });
  mocks.start.mockResolvedValue({ sessionId, expiresAt: "2026-10-21T00:00:00.000Z", sessionToken: "proof" });
  mocks.admin.mockResolvedValue({ items: [], nextCursor: null });
  mocks.cleanup.mockResolvedValue({ eventsDeleted: 1, sessionsDeleted: 2 });
});
afterEach(() => vi.unstubAllEnvs());

function request(path = "/api/telemetry", body: unknown = { kind: "session.start", sessionId }) {
  return new Request(`https://app.test${path}`, {
    method: "POST", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("telemetry route authorization and technical outcomes (store separately tested)", () => {
  it.each([POST, GET, CLEANUP])("disabled collector avoids persistence; admin still authenticates", async (handler) => {
    vi.stubEnv("TELEMETRY_ENABLED", "false");
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-error-id")).toBeTruthy();
    if (handler === GET) expect(mocks.user).toHaveBeenCalledOnce();
    else expect(mocks.user).not.toHaveBeenCalled();
    for (const fn of [mocks.consume, mocks.start, mocks.ingest, mocks.admin, mocks.cleanup, mocks.repair]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("authenticates before acquiring or reading the request body", async () => {
    const input = request();
    const reader = vi.spyOn(input.body!, "getReader");
    mocks.user.mockRejectedValue(new UnauthorizedError());
    const response = await POST(input);
    expect(response.status).toBe(401);
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("rejects cross origin before auth/body and never projects collector events", async () => {
    const input = request(); input.headers.set("origin", "https://evil.test");
    expect((await POST(input)).status).toBe(403);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("starts the verified actor session and logs only sanitized technical metadata", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.consume).toHaveBeenCalledWith("v1:actor1");
    expect(mocks.start).toHaveBeenCalledWith("v1:actor1", sessionId);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ route: "/api/telemetry", actorId: "actor1", event: "api.request.completed" }));
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("proof");
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("accepts a closed batch and returns duplicate acknowledgements", async () => {
    const eventId = "22222222-2222-4222-8222-222222222222";
    mocks.ingest.mockResolvedValue([eventId]);
    const response = await POST(request("/api/telemetry", {
      sessionId, sessionToken: `v1.1792540800000.${"a".repeat(64)}`,
      events: [{ schemaVersion: 1, event: "ui.action", action: "task.checklist.toggle", eventId,
        sessionId, actionId: eventId, seq: 1, occurredAt: "2026-10-20T00:00:00.000Z" }],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { accepted: [eventId] } });
  });

  it.each(["USER", "MANAGER", "PROJECT_ADMIN"])("denies non-global role %s before telemetry reads", async (role) => {
    mocks.user.mockResolvedValue({ id: "actor1", role });
    expect((await GET(new Request("https://app.test/api/admin/telemetry"))).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(["limit=0", "limit=101", "limit=1&limit=2", "actorId=private", "category=server", "cursor="])("rejects admin filter %s", async (query) => {
    expect((await GET(new Request(`https://app.test/api/admin/telemetry?${query}`))).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("passes bounded admin filters and logs verified actor", async () => {
    expect((await GET(new Request("https://app.test/api/admin/telemetry?limit=100&category=diagnostic&cursor=abc"))).status).toBe(200);
    expect(mocks.admin).toHaveBeenCalledWith({ limit: 100, category: "diagnostic", cursor: "abc" });
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ route: "/api/admin/telemetry", actorId: "actor1" }));
  });

  it.each([undefined, "Bearer wrong"])("cleanup rejects missing/invalid bearer %s before repair/query", async (authorization) => {
    const input = request("/api/telemetry/cleanup");
    if (authorization) input.headers.set("authorization", authorization);
    expect((await CLEANUP(input)).status).toBe(401);
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("cleanup requires configured secret and then repairs before bounded purge", async () => {
    const input = request("/api/telemetry/cleanup");
    input.headers.set("authorization", "Bearer synthetic-cron-secret");
    vi.stubEnv("CRON_SECRET", "");
    expect((await CLEANUP(input)).status).toBe(503);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
    expect((await CLEANUP(input)).status).toBe(200);
    expect(mocks.repair).toHaveBeenCalledWith(50);
    expect(mocks.cleanup).toHaveBeenCalledWith(expect.any(Date), 5000);
    expect(mocks.repair.mock.invocationCallOrder[0]).toBeLessThan(mocks.cleanup.mock.invocationCallOrder[0]);
  });
});
