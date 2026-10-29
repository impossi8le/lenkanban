import type { TelemetryEvent } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ findMany: vi.fn(), user: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), comment: vi.fn() }));
vi.mock("@/lib/problem-report-comment-store", () => ({ readProblemReportComment: mocked.comment }));
vi.mock("@/lib/prisma", () => ({ prisma: { telemetryEvent: { findMany: mocked.findMany } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocked.info, warn: mocked.warn, error: mocked.error } }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocked.user, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/require-user", () => ({ isGlobalAdmin: (user: { role: string }) => user.role === "ADMIN" }));
import { getTelemetrySummary, parseTelemetryReportFilters, readTelemetryError } from "./reports";
import { readAdminTelemetry, telemetryActorKey, telemetryReportWindow } from "./store";
import { TELEMETRY_RETENTION_MS } from "./http";
import { GET as summaryRoute } from "@/app/api/admin/telemetry/summary/route";
import { GET as errorRoute } from "@/app/api/admin/telemetry/errors/[errorId]/route";
import { UnauthorizedError } from "@/lib/require-api-user";

const now = new Date("2026-10-20T12:00:00.000Z");
const requestId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const errorId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-hmac-secret-at-least-32-characters");
  mocked.findMany.mockResolvedValue([]);
  mocked.comment.mockResolvedValue(undefined);
  mocked.user.mockResolvedValue({ id: "actorA", role: "ADMIN" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function server(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    id: "server1", actorKey: telemetryActorKey("actorA")!, eventId: requestId,
    receivedAt: new Date(now.getTime() - 1000), occurredAt: new Date(now.getTime() - 1000),
    event: "api.request.completed", category: "diagnostic", source: "server", trust: "server_observed",
    actionId, requestId, errorId, operationId: null, sessionId: null, projectId: "project1", taskId: null,
    payload: { schemaVersion: 1, route: "/api/tasks/:id/checklist/:itemId", method: "PATCH",
      statusCode: 500, durationMs: 10, env: "test", revision: "abcdef0", message: "PRIVATE" }, ...overrides,
  };
}
function client(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return server({ id: "client1", eventId: actionId, event: "client.request.result", source: "client", trust: "client_reported",
    sessionId, projectId: null,
    payload: { schemaVersion: 1, action: "task.checklist.toggle", seq: 8, outcome: "failure", durationMs: 10, statusCode: 500 }, ...overrides });
}

describe("telemetry bounded reports with mocked queries", () => {
  it("does not let a manual report shadow a trusted server error, including beyond the mixed seed cap", async () => {
    const reports = Array.from({ length: 101 }, (_, i) => client({ id: `report${i}`,
      eventId: `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`, event: "client.problem.reported", requestId: null,
      actorKey: telemetryActorKey("actorB")!, payload: { schemaVersion: 1, action: "app.problem.report", seq: 1,
        reason: "other", screen: "home", breadcrumbs: [] } }));
    const trusted = server();
    mocked.findMany.mockResolvedValueOnce(reports).mockResolvedValueOnce([trusted])
      .mockResolvedValueOnce([trusted]).mockResolvedValueOnce([trusted]);
    const detail = await readTelemetryError(errorId, {}, now);
    expect(detail?.linkage).toBe("server_verified");
    expect(detail?.problemReport).toBeUndefined();
    expect(detail?.events).toEqual([expect.objectContaining({ id: trusted.id, actorKey: trusted.actorKey })]);
    expect(detail?.truncated).toBe(true);
    expect(mocked.findMany.mock.calls[1][0].where.AND[1]).toMatchObject({ source: "server", trust: "server_observed", errorId });
  });

  it("returns an explicit conflict instead of choosing another actor's ambiguous manual report", async () => {
    const a = client({ event: "client.problem.reported", requestId: null, payload: {
      schemaVersion: 1, action: "app.problem.report", seq: 1, reason: "slow", screen: "home", breadcrumbs: [] } });
    const b = { ...a, actorKey: telemetryActorKey("actorB")!, eventId: sessionId };
    mocked.findMany.mockResolvedValueOnce([b, a]).mockResolvedValueOnce([]);
    await expect(readTelemetryError(errorId, {}, now)).rejects.toMatchObject({ status: 409, code: "TELEMETRY_REPORT_ID_CONFLICT" });
  });
  it("returns the persisted report snapshot without mixing other actors or fabricating a server error", async () => {
    mocked.comment.mockResolvedValue("Explicit private business comment");
    const report = client({ event: "client.problem.reported", requestId: null,
      payload: { schemaVersion: 1, action: "app.problem.report", seq: 3, reason: "slow", screen: "home",
        breadcrumbs: [{ eventId: sessionId, seq: 1, occurredAt: new Date(now.getTime() - 2000).toISOString(),
          kind: "navigation", name: "root" }] } });
    mocked.findMany.mockResolvedValueOnce([report]).mockResolvedValueOnce([]);
    const detail = await readTelemetryError(errorId, {}, now);
    expect(detail).toMatchObject({ linkage: "client_reported", problemReport: {
      reportId: errorId, reason: "slow", screen: "home", breadcrumbCount: 1, comment: "Explicit private business comment" } });
    expect(mocked.comment).toHaveBeenCalledWith(report.id, errorId);
    expect(JSON.stringify(detail?.events)).not.toContain("Explicit private business comment");
    expect(JSON.stringify(detail?.breadcrumbs)).not.toContain("Explicit private business comment");
    expect(detail?.events).toHaveLength(1);
    expect(detail?.breadcrumbs).toMatchObject([{ actorKey: report.actorKey, sessionId,
      trust: "client_reported", payload: { seq: 1, kind: "navigation", name: "root" } }]);
    expect(mocked.findMany).toHaveBeenCalledTimes(2);
    expect(mocked.findMany.mock.calls[0][0].where.AND[0].receivedAt.gt)
      .toEqual(new Date(now.getTime() - TELEMETRY_RETENTION_MS));
    mocked.findMany.mockResolvedValue([]); // expired reports are filtered by the database window
    expect(await readTelemetryError(errorId, {}, now)).toBeNull();
  });
  it("applies release and revision conjunctively to summary, event listing and error-chain queries", async () => {
    const filters = parseTelemetryReportFilters(new URLSearchParams("release=lenkanban@1.2.3&revision=ABCDEF0"));
    expect(filters).toEqual({ release: "lenkanban@1.2.3", revision: "ABCDEF0" });
    const { where } = telemetryReportWindow(filters, now);
    expect(where).toMatchObject({ payload: { path: ["revision"], equals: "abcdef0" },
      AND: [{ payload: { path: ["release"], equals: "lenkanban@1.2.3" } }] });
    await getTelemetrySummary(filters, now);
    expect(mocked.findMany.mock.calls[0][0].where).toEqual(where);
    await readAdminTelemetry(filters, now);
    expect(mocked.findMany.mock.calls[1][0].where).toEqual(where);
    mocked.findMany.mockResolvedValueOnce([client()]).mockResolvedValueOnce([server()])
      .mockResolvedValueOnce([client(), server()]).mockResolvedValueOnce([]);
    await readTelemetryError(errorId, filters, now);
    for (const [query] of mocked.findMany.mock.calls.slice(2)) expect(query.where.AND[0]).toEqual(where);
  });

  it.each(["", "private?token=value", "a".repeat(129)])("rejects invalid release %j before querying", async release => {
    await expect(getTelemetrySummary({ release }, now)).rejects.toMatchObject({ status: 400 });
    expect(mocked.findMany).not.toHaveBeenCalled();
  });

  it("rejects duplicate release filters", () => {
    expect(() => parseTelemetryReportFilters(new URLSearchParams("release=a&release=b"))).toThrow();
  });

  it("excludes production-shaped synthetic rows from summary and error anchors", async () => {
    const synthetic = server({ payload: { schemaVersion: 1, synthetic: true, env: "production",
      route: "/api/tasks/:id", method: "PATCH", statusCode: 500, durationMs: 10 } });
    mocked.findMany.mockResolvedValue([synthetic]);
    const summary = await getTelemetrySummary({}, now);
    expect(summary.collection.observedRows).toBe(0);
    expect(summary.diagnostics.failureRate).toBeNull();
    expect(await readTelemetryError(errorId, {}, now)).toBeNull();
    expect(mocked.findMany).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "unconfigured"])("returns labelled %s summary without touching database", async (state) => {
    if (state === "disabled") vi.stubEnv("TELEMETRY_ENABLED", "false");
    else vi.stubEnv("TELEMETRY_HMAC_SECRET", "");
    const summary = await getTelemetrySummary({}, now);
    expect(summary.collection.state).toBe(state);
    expect(summary.collection.observedRows).toBe(0);
    expect(summary.diagnostics.requestCount).toBe(0);
    expect(summary.diagnostics.failureRate).toBeNull();
    expect(mocked.findMany).not.toHaveBeenCalled();
  });

  it("queries UTC half-open windows with an independent strict retention cutoff", async () => {
    const to = new Date(now.getTime() - 1000).toISOString();
    const from = new Date(new Date(to).getTime() - TELEMETRY_RETENTION_MS).toISOString();
    await getTelemetrySummary({ from, to, projectId: "project1", revision: "ABCDEF0" }, now);
    expect(mocked.findMany).toHaveBeenCalledWith({
      where: { receivedAt: { gte: new Date(from), lt: new Date(to), gt: new Date(now.getTime() - TELEMETRY_RETENTION_MS) },
        projectId: "project1", payload: { path: ["revision"], equals: "abcdef0" } },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 10001,
    });
  });

  it.each([
    { from: "2026-10-20" }, { to: "2026-10-20T12:00:00Z" },
    { to: "2026-10-20T12:00:00.001Z" }, { from: now.toISOString() },
    { from: new Date(now.getTime() - TELEMETRY_RETENTION_MS - 1).toISOString() },
    { projectId: "private/path" }, { revision: "private?secret" },
  ])("rejects invalid report filters %# before querying", async (filters) => {
    await expect(getTelemetrySummary(filters, now)).rejects.toMatchObject({ status: 400 });
    expect(mocked.findMany).not.toHaveBeenCalled();
  });

  it.each(["from=a&from=b", "unknown=private", "projectId=", "limit=1"])("rejects unexpected/duplicate/empty query %s", (query) => {
    expect(() => parseTelemetryReportFilters(new URLSearchParams(query))).toThrow();
  });

  it("does not turn active database failure into an empty healthy summary", async () => {
    mocked.findMany.mockRejectedValue(Error("PRIVATE"));
    await expect(getTelemetrySummary({}, now)).rejects.toThrow("PRIVATE");
  });

  it("marks capped scans truncated and summarizes only safe rows", async () => {
    const rows = Array.from({ length: 10001 }, (_, i) => server({ id: `row${i}`,
      eventId: `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` }));
    rows[0] = server({ id: "invalid", trust: "client_reported" });
    mocked.findMany.mockResolvedValue(rows);
    const summary = await getTelemetrySummary({}, now);
    expect(summary.collection.truncated).toBe(true);
    expect(summary.collection.limit).toBe(10000);
    expect(summary.collection.observedRows).toBe(9999);
    expect(JSON.stringify(summary)).not.toContain("PRIVATE");
  });

  it("requires exact same actor+request+action to upgrade a client error", async () => {
    mocked.findMany.mockResolvedValueOnce([client()]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const detail = await readTelemetryError(errorId, {}, now);
    expect(detail?.linkage).toBe("client_reported");
    expect(mocked.findMany.mock.calls[1][0].where.AND[1]).toEqual({
      source: "server", trust: "server_observed", errorId,
      OR: [{ actorKey: telemetryActorKey("actorA"), requestId, actionId }],
    });
    expect(JSON.stringify(mocked.findMany.mock.calls[1])).not.toContain(telemetryActorKey("actorB"));
    expect(mocked.findMany.mock.calls[2][0].where.AND[1].OR[0]).toEqual({
      actorKey: telemetryActorKey("actorA"), sessionId, source: "client", trust: "client_reported",
      payload: { path: ["seq"], lte: 8 },
    });
  });

  it("returns verified server anchors and bounded safe breadcrumbs without broad UUID joins", async () => {
    const crumb = client({ id: "crumb1", event: "ui.action", category: "usage", requestId: null, errorId: null,
      payload: { schemaVersion: 1, action: "task.checklist.toggle", seq: 7, text: "PRIVATE" } });
    mocked.findMany.mockResolvedValueOnce([client()]).mockResolvedValueOnce([server()])
      .mockResolvedValueOnce([server(), client()]).mockResolvedValueOnce(Array.from({ length: 41 }, (_, i) => ({ ...crumb, id: `crumb${i}` })));
    const detail = await readTelemetryError(errorId, {}, now);
    expect(detail?.linkage).toBe("server_verified"); expect(detail?.events).toHaveLength(2);
    expect(detail?.breadcrumbs).toHaveLength(40); expect(detail?.truncated).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("PRIVATE");
    expect(mocked.findMany.mock.calls[2][0].where.AND[1]).toEqual({ OR: [
      { actorKey: telemetryActorKey("actorA"), requestId, actionId },
    ] });
  });

  it("cannot verify a forged errorId using a known successful server request", async () => {
    const successful = server({ errorId: null, payload: {
      schemaVersion: 1, route: "/api/tasks/:id/checklist/:itemId", method: "PATCH", statusCode: 200, durationMs: 10,
    } });
    mocked.findMany.mockResolvedValueOnce([client()]).mockImplementationOnce(async query => {
      // A successful request has no server errorId. The database predicate must
      // exclude it even when actor, request and action match the forged claim.
      return query.where.AND[1].errorId === errorId ? [] : [successful];
    }).mockResolvedValueOnce([]);
    expect((await readTelemetryError(errorId, {}, now))?.linkage).toBe("client_reported");
  });

  it("accepts direct trusted server error without actionId and returns 404-equivalent null for absent retained events", async () => {
    mocked.findMany.mockResolvedValueOnce([server({ actionId: null })]);
    expect((await readTelemetryError(errorId, {}, now))?.linkage).toBe("server_verified");
    mocked.findMany.mockResolvedValueOnce([]);
    expect(await readTelemetryError(errorId, {}, now)).toBeNull();
    expect(mocked.findMany.mock.calls[0][0].where.AND[0]).toEqual(telemetryReportWindow({}, now).where);
  });
});

describe("report API authorization precedes all collection states", () => {
  it("unauthenticated summary receives 401 even when disabled", async () => {
    vi.stubEnv("TELEMETRY_ENABLED", "false"); mocked.user.mockRejectedValue(new UnauthorizedError());
    expect((await summaryRoute(new Request("https://app.test/api/admin/telemetry/summary"))).status).toBe(401);
    expect(mocked.findMany).not.toHaveBeenCalled();
  });

  it.each(["USER", "PROJECT_ADMIN"])("non-global %s receives 403 for summary and detail", async (role) => {
    vi.stubEnv("TELEMETRY_ENABLED", "false"); mocked.user.mockResolvedValue({ id: "actorA", role });
    expect((await summaryRoute(new Request("https://app.test/api/admin/telemetry/summary"))).status).toBe(403);
    expect((await errorRoute(new Request(`https://app.test/api/admin/telemetry/errors/${errorId}`), { params: Promise.resolve({ errorId }) })).status).toBe(403);
    expect(mocked.findMany).not.toHaveBeenCalled();
  });

  it("ADMIN sees disabled summary with no-store and fixed audit metadata", async () => {
    vi.stubEnv("TELEMETRY_ENABLED", "false");
    const response = await summaryRoute(new Request("https://app.test/api/admin/telemetry/summary"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ data: { collection: { state: "disabled" } } });
    expect(mocked.info).toHaveBeenCalledWith(expect.objectContaining({ event: "telemetry.admin.viewed", actorId: "actorA", operation: "summary" }));
  });

  it("active storage failures receive safe 503 and absent error receives 404", async () => {
    mocked.findMany.mockRejectedValueOnce(Error("PRIVATE"));
    const failed = await summaryRoute(new Request("https://app.test/api/admin/telemetry/summary"));
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("PRIVATE");
    expect((await errorRoute(new Request(`https://app.test/api/admin/telemetry/errors/${errorId}`), { params: Promise.resolve({ errorId }) })).status).toBe(404);
  });
});
