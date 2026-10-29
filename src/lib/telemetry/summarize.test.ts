import { describe, expect, it } from "vitest";
import { summarizeTelemetryEvents } from "./summarize";
import type { TelemetryReportEvent } from "./report-contract";

const WINDOW = { from: "2026-10-20T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z", timezone: "UTC" as const };
const TIME = "2026-10-20T12:00:00.000Z";
const A = `v1:${"a".repeat(64)}`;
const B = `v1:${"b".repeat(64)}`;
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
function row(n: number, extra: Partial<TelemetryReportEvent> = {}): TelemetryReportEvent {
  return {
    id: `row-${n}`, actorKey: A, eventId: uuid(n), actionId: uuid(100), sessionId: uuid(200),
    receivedAt: TIME, occurredAt: TIME, event: "ui.action", category: "usage", source: "client", trust: "client_reported",
    payload: { schemaVersion: 1, action: "task.checklist.toggle", seq: n }, ...extra,
  };
}
function result(n: number, outcome: "success" | "failure" | "cancelled" | "rejected" | "conflict", extra: Partial<TelemetryReportEvent> = {}) {
  return row(n, { event: "client.request.result", category: "diagnostic", payload: { schemaVersion: 1, action: "task.checklist.toggle", outcome, durationMs: 5, statusCode: outcome === "failure" ? 500 : 200 }, ...extra });
}
function request(n: number, requestId: string, statusCode: number, extra: Partial<TelemetryReportEvent> = {}) {
  return row(n, { event: "api.request.completed", category: "diagnostic", source: "server", trust: "server_observed", requestId,
    payload: { schemaVersion: 1, route: "/api/tasks/:id/checklist/:itemId", method: "PATCH", statusCode, durationMs: 5 }, ...extra });
}
function commit(n: number, operationId: string, extra: Partial<TelemetryReportEvent> = {}) {
  return row(n, { event: "task.checklist.updated", category: "usage", source: "server", trust: "authoritative", operationId,
    payload: { schemaVersion: 1, action: "task.checklist.toggle" }, ...extra });
}
const summarize = (rows: readonly TelemetryReportEvent[], truncated = false, limit = 10000) => summarizeTelemetryEvents(rows, WINDOW, truncated, limit);
function clientRequest(n: number, durationMs: number, extra: Partial<TelemetryReportEvent> = {}) {
  return row(n, { event: "client.breadcrumb", category: "diagnostic", payload: {
    schemaVersion: 1, action: "app.breadcrumb", kind: "request", name: "/api/tasks/:id/messages", seq: n, durationMs }, ...extra });
}

describe("telemetry aggregates respect provenance, identity and received time", () => {
  it("computes nearest-rank latency percentiles and inclusive one-second slow threshold from measured observations", () => {
    const rows = Array.from({ length: 20 }, (_, i) => clientRequest(i + 1, (i + 1) * 100));
    const summary = summarize(rows);
    expect(summary.requestLatency).toEqual({ coverage: "partial_stored_observations", percentileMethod: "nearest_rank",
      slowThresholdMs: 1000, groups: [{ route: "/api/tasks/:id/messages", source: "client.observed", count: 20,
        p50Ms: 1000, p95Ms: 1900, p99Ms: 2000, maxMs: 2000, slowCount: 11 }] });
    expect(summarize([...rows].reverse()).requestLatency).toEqual(summary.requestLatency);
    expect(summary.diagnostics.requestCount).toBe(0); // no invented server attempts
    expect(summary.requestLatency?.groups[0]).not.toHaveProperty("method");
  });

  it("keeps client and stored handler sources separate and deduplicates server request retries conservatively", () => {
    const route = "/api/tasks/:id/messages";
    const server = request(1, uuid(301), 200, { payload: { schemaVersion: 1, route, method: "POST", statusCode: 200, durationMs: 2500 } });
    const duplicate = { ...server, eventId: uuid(2), payload: { ...server.payload, durationMs: 100 } };
    const second = request(3, uuid(303), 200, { payload: { ...server.payload, durationMs: 500 } });
    const client = clientRequest(4, 40);
    const rows = [server, duplicate, second, client, { ...client }];
    const groups = summarize(rows).requestLatency?.groups;
    expect(groups).toEqual([
      { route, source: "client.observed", count: 1, p50Ms: 40, p95Ms: 40, p99Ms: 40, maxMs: 40, slowCount: 0 },
      { route, source: "server.handler", count: 2, p50Ms: 500, p95Ms: 2500, p99Ms: 2500, maxMs: 2500, slowCount: 1 },
    ]);
    expect(summarize([...rows].reverse()).requestLatency?.groups).toEqual(groups);
  });

  it("never recounts embedded problem snapshots, action results or non-request breadcrumbs as latency samples", () => {
    const report = row(1, { event: "client.problem.reported", category: "diagnostic", errorId: uuid(999), payload: {
      schemaVersion: 1, action: "app.problem.report", reason: "slow", screen: "home", breadcrumbs: [{
        eventId: uuid(2), seq: 1, occurredAt: TIME, kind: "request", name: "/api/tasks", durationMs: 9000 }] } });
    const navigation = clientRequest(3, 400, { payload: { schemaVersion: 1, action: "app.breadcrumb", kind: "navigation", name: "board", durationMs: 400 } });
    expect(summarize([report, navigation, result(4, "failure")]).requestLatency?.groups).toEqual([]);
  });

  it.each([undefined, -1, NaN, Infinity, 86_400_001, "40"])("does not manufacture latency for invalid duration %#", durationMs => {
    const client = clientRequest(1, durationMs as number);
    const server = request(2, uuid(302), 200, { payload: { schemaVersion: 1, route: "/api/tasks/:id", method: "PATCH", statusCode: 200, durationMs: durationMs as number } });
    expect(summarize([client, server]).requestLatency?.groups).toEqual([]);
  });

  it("uses bounded received-time scans and closed route labels without leaking actor or raw URLs", () => {
    const invalid = clientRequest(1, 5, { payload: { schemaVersion: 1, action: "app.breadcrumb", kind: "request", name: "/api/tasks/private?token=SECRET", durationMs: 5 } });
    const valid = clientRequest(2, 0);
    const outOfWindow = clientRequest(3, 10000, { receivedAt: WINDOW.to });
    const summary = summarize([invalid, valid, outOfWindow, clientRequest(4, 5000)], false, 3);
    expect(summary.window).toEqual(WINDOW);
    expect(summary.collection).toMatchObject({ limit: 3, truncated: true });
    expect(summary.requestLatency).toMatchObject({ coverage: "partial_stored_observations", groups: [{ count: 1, p50Ms: 0, maxMs: 0 }] });
    expect(JSON.stringify(summary.requestLatency)).not.toMatch(/SECRET|actorKey|requestId|actionId|sessionId|token/);
  });
  it("observes a problem anchor without counting it as a server failure or a business action", () => {
    const report = row(1, { event: "client.problem.reported", category: "diagnostic", errorId: uuid(9),
      payload: { schemaVersion: 1, action: "app.problem.report", seq: 1, reason: "error", screen: "home", breadcrumbs: [] } });
    const summary = summarize([report]);
    expect(summary.collection.observedRows).toBe(1);
    expect(summary.diagnostics.requestCount).toBe(0);
    expect(summary.diagnostics.renderFailures).toBe(0);
    expect(summary.diagnostics.failureRate).toBeNull();
    expect(summary.usage.uniqueActions).toBe(0);
  });
  it("splits screens and features by unique actor/action, with stable closed labels", () => {
    const board = row(1, { payload: { schemaVersion: 1, action: "screen.view", screen: "board" } });
    const search = row(2, { actionId: uuid(102), payload: { schemaVersion: 1, action: "board.search" } });
    const rows = [board, { ...board, eventId: uuid(3) }, search, { ...search, eventId: uuid(4), actorKey: B },
      row(5, { actionId: uuid(105), payload: { schemaVersion: 1, action: "screen.view", screen: "task.detail" } }),
      row(6, { payload: { schemaVersion: 1, action: "screen.view", screen: "PRIVATE" } }), result(7, "success")];
    const summary = summarize(rows);
    expect(summary.usage).toEqual({ uniqueActions: 4, clientSessions: 2, clientActors: 2, committedChanges: 0,
      screens: [{ screen: "board", uniqueActions: 1 }, { screen: "task.detail", uniqueActions: 1 }],
      features: [{ action: "board.search", uniqueActions: 2 }] });
    expect(summarize([...rows].reverse())).toEqual(summary);
    expect(JSON.stringify(summary)).not.toContain("PRIVATE");
  });

  it("excludes explicitly marked synthetic records even with production-shaped identities and operations", () => {
    const rows = [row(1), request(2, uuid(302), 500), commit(3, uuid(403)), result(4, "failure")]
      .map(event => ({ ...event, payload: { ...event.payload, synthetic: true, env: "production" } }));
    expect(summarize(rows)).toEqual(summarize([]));
  });

  it("reports no probabilistic sampling and never promotes HTTP success to a commit", () => {
    const summary = summarize([
      ...["task.create", "task.update", "task.move"].map((action, index) => result(index + 1, "success", {
        payload: { schemaVersion: 1, action, outcome: "success", durationMs: 1, statusCode: 200 },
      })),
      request(4, uuid(304), 200, { payload: {
        schemaVersion: 1, route: "/api/tasks/:id", method: "PATCH", statusCode: 200, durationMs: 1,
      } }),
    ]);
    expect(summary.collection.sampling).toEqual({ mode: "none", rate: 1, metricBasis: "observed_events" });
    expect(summary.usage.committedChanges).toBe(0);
    expect(summary.diagnostics.requestCount).toBe(1);
    expect(summarize([]).collection.sampling).toEqual(summary.collection.sampling);
  });

  it("counts a mixed synthetic dataset without double-counting attempts, sessions, commits or client failures as server failures", () => {
    const rows = [
      row(1), row(2), row(3, { actionId: uuid(101), sessionId: uuid(201) }), row(4, { actorKey: B }),
      result(5, "failure"), result(6, "failure"), result(7, "cancelled"),
      request(8, uuid(301), 200), request(9, uuid(301), 200),
      request(10, uuid(302), 403), request(11, uuid(303), 200), request(12, uuid(303), 500),
      request(13, uuid(301), 200, { actorKey: B }),
      commit(14, uuid(401)), commit(15, uuid(401)), commit(16, uuid(401), { actorKey: B }),
      row(17, { event: "client.render.failed", category: "diagnostic", errorId: uuid(501), payload: { schemaVersion: 1, action: "app.render", errorCode: "RENDER_FAILURE" } }),
      row(18, { event: "client.render.failed", category: "diagnostic", errorId: uuid(501), payload: { schemaVersion: 1, action: "app.render", errorCode: "RENDER_FAILURE" } }),
    ];
    const summary = summarize(rows);
    expect(summary.usage).toEqual({ uniqueActions: 3, clientSessions: 3, clientActors: 2, committedChanges: 2,
      screens: [], features: [{ action: "task.checklist.toggle", uniqueActions: 3 }] });
    expect(summary.diagnostics).toEqual({ requestCount: 4, failedRequestCount: 1, rejectedRequestCount: 1, conflictRequestCount: 0,
      failureRate: 0.25, clientFailures: 1, clientCancellations: 1, renderFailures: 1 });
    expect(summary.collection).toMatchObject({ state: "available", collectorHealth: "not_measured", truncated: false, latestReceivedAt: TIME });
  });

  it("deduplicates actor/event identity but does not merge different actors sharing an eventId", () => {
    const same = row(1);
    const summary = summarize([same, { ...same }, { ...same, actorKey: B }]);
    expect(summary.collection.observedRows).toBe(2);
    expect(summary.usage).toMatchObject({ uniqueActions: 2, clientActors: 2, clientSessions: 2 });
  });

  it("does not infer client actors/sessions/usage from request results, render failures or server records", () => {
    const summary = summarize([result(1, "failure"), request(2, uuid(302), 500), commit(3, uuid(403)),
      row(4, { event: "client.render.failed", category: "diagnostic", errorId: uuid(504), payload: { schemaVersion: 1, action: "app.render", errorCode: "RENDER_FAILURE" } })]);
    expect(summary.usage).toEqual({ uniqueActions: 0, clientActors: 0, clientSessions: 0, committedChanges: 1, screens: [], features: [] });
    expect(summary.diagnostics).toMatchObject({ requestCount: 1, failedRequestCount: 1, clientFailures: 1, renderFailures: 1 });
  });

  it("conservatively selects the highest status per actor/request, independent of row order and event deduplication", () => {
    const rows = [request(1, uuid(301), 200), request(1, uuid(301), 503), request(2, uuid(302), 409), request(3, uuid(303), 422)];
    for (const ordered of [rows, [...rows].reverse()]) expect(summarize(ordered).diagnostics).toMatchObject({
      requestCount: 3, failedRequestCount: 1, rejectedRequestCount: 1, conflictRequestCount: 1, failureRate: 1 / 3,
    });
  });

  it("uses receivedAt [from,to) even when occurredAt is old, future or outside the selected window", () => {
    const rows = [
      row(1, { receivedAt: WINDOW.from, occurredAt: "2020-01-01T00:00:00.000Z" }),
      row(2, { actionId: uuid(102), receivedAt: "2026-10-20T23:59:59.999Z", occurredAt: "2030-01-01T00:00:00.000Z" }),
      row(3, { receivedAt: WINDOW.to }), row(4, { receivedAt: "2026-10-19T23:59:59.999Z" }),
    ];
    const summary = summarize(rows);
    expect(summary.usage.uniqueActions).toBe(2);
    expect(summary.collection.observedRows).toBe(2);
    expect(summary.collection.latestReceivedAt).toBe("2026-10-20T23:59:59.999Z");
  });

  it.each(["2026-10-20T12:00:00Z", "2026-10-20T15:00:00.000+03:00", "2026-02-30T12:00:00.000Z", "not-a-time"])("ignores noncanonical timestamp %s in either time field", invalid => {
    expect(summarize([row(1, { receivedAt: invalid }), row(2, { occurredAt: invalid })]).collection.observedRows).toBe(0);
  });

  it.each([
    { event: "task.checklist.noop" }, { event: "invented.event" },
    { payload: { schemaVersion: 2, action: "task.checklist.toggle" } },
    { payload: { schemaVersion: 1, action: "unsupported.feature" } },
    { trust: "authoritative" }, { source: "server" }, { category: "diagnostic" },
    { actorKey: "" }, { eventId: "" }, { actionId: null }, { sessionId: null },
  ])("rejects unsupported/forged intent row %j", invalid => {
    const input = row(1, invalid as Partial<TelemetryReportEvent>);
    expect(summarize([input]).collection.observedRows).toBe(0);
  });

  it("rejects forged client commits and uninstrumented synthetic service requests", () => {
    const rows = [commit(1, uuid(401), { source: "client", trust: "client_reported" }),
      commit(2, uuid(402), { trust: "server_observed" }),
      request(3, uuid(303), 500, { trust: "client_reported" }),
      request(4, uuid(304), 500, { payload: { schemaVersion: 1, route: "/api/telemetry/cleanup", method: "POST", statusCode: 500 } }),
      request(5, uuid(305), 500, { payload: { schemaVersion: 1, route: "/api/tasks/real-id/checklist/item-id?token=private", statusCode: 500 } })];
    expect(summarize(rows).collection.observedRows).toBe(0);
    expect(summarize(rows).diagnostics.failureRate).toBeNull();
  });

  it.each([-1, 99, 600, 200.5, NaN, Infinity, "500"])("does not include an invalid server status %j in the denominator", statusCode => {
    const input = request(1, uuid(301), statusCode as number);
    expect(summarize([input]).diagnostics.requestCount).toBe(0);
  });

  it("rejects unsupported client outcomes without manufacturing a failure", () => {
    const invalid = result(1, "failure", { payload: { schemaVersion: 1, action: "task.checklist.toggle", outcome: "committed" as "success" } });
    expect(summarize([invalid]).collection.observedRows).toBe(0);
  });

  it("does not report a failure rate with no server requests or with any truncated scan", () => {
    expect(summarize([]).diagnostics.failureRate).toBeNull();
    expect(summarize([result(1, "failure")]).diagnostics.failureRate).toBeNull();
    expect(summarize([request(1, uuid(301), 500)], true).diagnostics).toMatchObject({ requestCount: 1, failureRate: null });
    expect(summarize([request(1, uuid(301), 500), request(2, uuid(302), 200)], false, 1).collection.truncated).toBe(true);
    expect(summarize([request(1, uuid(301), 500), request(2, uuid(302), 200)], false, 1).diagnostics.failureRate).toBeNull();
  });

  it("caps scanned raw rows, including invalid rows, instead of filling the cap with recognized records", () => {
    const summary = summarize([row(1, { event: "invalid" }), row(2)], false, 1);
    expect(summary.collection).toMatchObject({ limit: 1, truncated: true, observedRows: 0, latestReceivedAt: null });
    expect(summary.usage.uniqueActions).toBe(0);
    expect(summarize([], false, 10001).collection.limit).toBe(10000);
    expect(summarize([], false, NaN).collection.limit).toBeLessThanOrEqual(10000);
  });

  it("handles absent/null row data and invalid windows without fabricated observations", () => {
    const rows = [null, undefined, row(1, { payload: null as unknown as TelemetryReportEvent["payload"] })] as unknown as TelemetryReportEvent[];
    expect(summarize(rows).collection).toMatchObject({ observedRows: 0, latestReceivedAt: null });
    expect(summarizeTelemetryEvents([row(1)], { ...WINDOW, from: "invalid" }, false, 100).collection.observedRows).toBe(0);
    expect(summarizeTelemetryEvents([row(1)], { ...WINDOW, from: WINDOW.to, to: WINDOW.from }, false, 100).collection.observedRows).toBe(0);
  });

  it("does not mutate frozen inputs and returns deterministic latest valid receivedAt without identifiers or payload text", () => {
    const first = row(1, { receivedAt: "2026-10-20T02:00:00.000Z" });
    const second = request(2, uuid(302), 200, { receivedAt: "2026-10-20T22:00:00.000Z" });
    Object.assign(first.payload, { privateText: "synthetic-password-cookie-title", nested: { token: "synthetic-token" } });
    Object.freeze(first.payload); Object.freeze(first); Object.freeze(second.payload); Object.freeze(second);
    const rows = Object.freeze([first, second]);
    const window = Object.freeze({ ...WINDOW });
    const before = JSON.stringify(rows);
    const summary = summarizeTelemetryEvents(rows, window, false, 100);
    expect(summarizeTelemetryEvents([...rows].reverse(), window, false, 100)).toEqual(summary);
    expect(summary.collection.latestReceivedAt).toBe(second.receivedAt);
    expect(JSON.stringify(rows)).toBe(before);
    expect(JSON.stringify(summary)).not.toContain(A);
    expect(JSON.stringify(summary)).not.toContain(uuid(100));
    expect(JSON.stringify(summary)).not.toMatch(/synthetic-|actorKey|actionId|sessionId|payload|privateText|token/);
  });
});
