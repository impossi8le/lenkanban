import type { TelemetryEvent } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ telemetryEvent: { createMany: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { recordServerRequestTelemetry, safeAdminEvent, telemetryActorKey } from "./store";
import type { ServerRequestTelemetry } from "./report-contract";

const requestId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const errorId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-20T12:00:00.000Z");
const input: ServerRequestTelemetry = {
  actorId: "actorA", requestId, actionId, errorId, route: "/api/tasks/:id/checklist/:itemId",
  method: "PATCH", statusCode: 500, durationMs: 10, event: "api.request.completed",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-hmac-secret-at-least-32-characters");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "aBc1234");
  vi.useFakeTimers(); vi.setSystemTime(now);
  db.telemetryEvent.createMany.mockResolvedValue({ count: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("server observed telemetry writer and closed report DTO", () => {
  it("marks synthetic server observations and excludes them from the report DTO", async () => {
    vi.stubEnv("TELEMETRY_SYNTHETIC", "true");
    vi.stubEnv("SENTRY_RELEASE", "lenkanban@1.2.3");
    await recordServerRequestTelemetry(input);
    const stored = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    expect(stored.payload).toMatchObject({ synthetic: true, release: "lenkanban@1.2.3" });
    expect(safeAdminEvent({ id: "synthetic1", ...stored } as TelemetryEvent)).toBeNull();
  });

  it("keeps a successful task command server_observed rather than authoritative", async () => {
    await recordServerRequestTelemetry({ ...input, route: "/api/tasks/:id", statusCode: 200 });
    const data = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    expect(data).toMatchObject({ category: "diagnostic", source: "server", trust: "server_observed",
      payload: { route: "/api/tasks/:id", outcome: "success" } });
    expect(data).not.toHaveProperty("operationId");
    expect(safeAdminEvent({ id: "task-request", ...data } as TelemetryEvent)).toMatchObject({ trust: "server_observed" });
  });

  it("derives authority, outcome and fixed error code without persisting raw errors", async () => {
    await recordServerRequestTelemetry({ ...input, err: new TypeError("PRIVATE request body cookie"), projectId: "project1" });
    expect(db.telemetryEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ actorKey: telemetryActorKey("actorA"), eventId: expect.any(String), requestId, actionId,
        errorId, projectId: "project1", event: "api.request.completed", category: "diagnostic", source: "server", trust: "server_observed",
        payload: { schemaVersion: 1, route: input.route, method: "PATCH", statusCode: 500, durationMs: 10,
          outcome: "failure", errorCode: "HTTP_5XX", errorType: "TypeError", env: "test", revision: "abc1234" } })],
      skipDuplicates: true,
    });
    expect(JSON.stringify(db.telemetryEvent.createMany.mock.calls)).not.toMatch(/PRIVATE|stack|cookie/);
    expect(db.telemetryEvent.createMany.mock.calls[0][0].data[0].eventId).not.toBe(requestId);
  });

  it.each([
    [200, "success", undefined], [400, "rejected", "HTTP_REJECTED"],
    [409, "conflict", "HTTP_CONFLICT"], [503, "failure", "HTTP_5XX"],
  ])("derives completed status %s", async (statusCode, outcome, errorCode) => {
    await recordServerRequestTelemetry({ ...input, statusCode });
    const payload = db.telemetryEvent.createMany.mock.calls[0][0].data[0].payload;
    expect(payload.outcome).toBe(outcome); expect(payload.errorCode).toBe(errorCode);
  });

  it("distinguishes unhandled exceptions without accepting caller-provided labels", async () => {
    await recordServerRequestTelemetry({ ...input, event: "api.request.failed", err: "PRIVATE" });
    expect(db.telemetryEvent.createMany.mock.calls[0][0].data[0].payload).toMatchObject({
      outcome: "failure", errorCode: "UNHANDLED_EXCEPTION", errorType: "UnknownError",
    });
  });

  it.each([
    { route: "/api/admin/telemetry" }, { route: "/api/tasks/private/checklist/1" }, { actorId: "private@email.test" },
    { requestId: "invalid" }, { actionId: "invalid" }, { errorId: "invalid" }, { method: "PRIVATE" },
    { statusCode: 99 }, { statusCode: 600 }, { statusCode: 200.5 }, { durationMs: NaN },
    { durationMs: -1 }, { durationMs: 86400001 }, { projectId: "private/path" },
  ])("rejects invalid metadata %# without persistence", async (override) => {
    await expect(recordServerRequestTelemetry({ ...input, ...override })).resolves.toBeUndefined();
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
  });

  it("fails open for disabled config, hostile inputs and rejected persistence", async () => {
    vi.stubEnv("TELEMETRY_ENABLED", "false");
    const hostile = new Proxy(input, { get() { throw Error("PRIVATE"); } });
    await expect(recordServerRequestTelemetry(hostile)).resolves.toBeUndefined();
    expect(db.telemetryEvent.createMany).not.toHaveBeenCalled();
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    await expect(recordServerRequestTelemetry(hostile)).resolves.toBeUndefined();
    db.telemetryEvent.createMany.mockRejectedValue(Error("PRIVATE"));
    await expect(recordServerRequestTelemetry(input)).resolves.toBeUndefined();
  });

  it("drops invalid release metadata rather than persisting untrusted strings", async () => {
    vi.stubEnv("NODE_ENV", "PRIVATE"); vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "PRIVATE/path?secret");
    await recordServerRequestTelemetry(input);
    const payload = db.telemetryEvent.createMany.mock.calls[0][0].data[0].payload;
    expect(payload).not.toHaveProperty("env"); expect(payload).not.toHaveProperty("revision");
  });

  it("reconstructs server DTO and refuses forged trust, routes and request identities", async () => {
    await recordServerRequestTelemetry(input);
    const data = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    const row = { id: "row1", actionId: null, requestId: null, errorId: null, operationId: null, sessionId: null,
      projectId: null, taskId: null, ...data, payload: { ...data.payload, message: "PRIVATE", stack: "PRIVATE", outcome: "success" } } as TelemetryEvent;
    const safe = safeAdminEvent(row);
    expect(safe?.payload.outcome).toBe("failure");
    expect(safe?.receivedAt).toBe(now.toISOString());
    expect(JSON.stringify(safe)).not.toContain("PRIVATE");
    expect(safeAdminEvent({ ...row, trust: "client_reported" })).toBeNull();
    expect(safeAdminEvent({ ...row, payload: { ...data.payload, schemaVersion: 2 } })).toBeNull();
    expect(safeAdminEvent({ ...row, payload: null })).toBeNull();
    expect(safeAdminEvent({ ...row, event: "task.checklist.updated", category: "usage", trust: "authoritative", payload: { schemaVersion: 2 } })).toBeNull();
    expect(safeAdminEvent({ ...row, requestId: "invalid" })).toBeNull();
    expect(safeAdminEvent({ ...row, payload: { ...data.payload, route: "/api/secret" } })).toBeNull();
  });
});
