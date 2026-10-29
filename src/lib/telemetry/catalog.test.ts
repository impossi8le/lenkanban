import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  telemetrySession: { createMany: vi.fn(), findUnique: vi.fn() },
  telemetryEvent: { createMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn() }));

import {
  isTelemetryFilter,
  isTelemetryScreen,
  isTelemetryUiAction,
  isTelemetryView,
  TELEMETRY_ACTION_ROUTES,
  TELEMETRY_CATALOG_VERSION,
  TELEMETRY_CLIENT_EVENTS,
  TELEMETRY_EVENT_CATEGORY,
  TELEMETRY_FILTERS,
  TELEMETRY_SCREENS,
  TELEMETRY_SERVER_EVENTS,
  TELEMETRY_SERVER_ROUTES,
  TELEMETRY_UI_ACTIONS,
  TELEMETRY_VIEWS,
} from "./catalog";
import { parseClientTelemetryBatch, parseClientTelemetryEvent } from "./contract";
import { TelemetryClient } from "./client";
import { ingestTelemetryBatch, safeAdminEvent, startTelemetrySession, telemetryActorKey } from "./store";
import { summarizeTelemetryEvents } from "./summarize";
import type { TelemetryReportEvent } from "./report-contract";

/**
 * Issue #54 acceptance: the versioned catalog covers the agreed user actions,
 * every event stays inside one schema, and no user-entered value can be stored.
 * All fixtures are synthetic; Prisma is mocked before `store` is imported.
 */

const EVENT = "a12bc345-6789-4abc-8def-012345678901";
const SESSION = "b12bc345-6789-4abc-8def-012345678901";
const ACTION = "c12bc345-6789-4abc-8def-012345678901";
const NOW = new Date("2026-10-22T09:00:00.000Z");
const WINDOW = { from: "2026-10-22T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", timezone: "UTC" as const };

type Shape = Record<string, unknown>;

function intent(extra: Shape = {}): Shape {
  return {
    schemaVersion: 1,
    eventId: EVENT,
    sessionId: SESSION,
    actionId: ACTION,
    action: "task.checklist.toggle",
    event: "ui.action",
    occurredAt: NOW.toISOString(),
    seq: 1,
    ...extra,
  };
}

function result(extra: Shape = {}): Shape {
  return intent({ event: "client.request.result", outcome: "success", durationMs: 4, ...extra });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-catalog-secret-at-least-32-chars");
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  db.telemetrySession.createMany.mockResolvedValue({ count: 1 });
  db.telemetrySession.findUnique.mockResolvedValue({
    id: SESSION,
    actorKey: telemetryActorKey("actorA")!,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  });
  db.telemetryEvent.createMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("#54 versioned catalog", () => {
  it("declares one version and closed vocabularies", () => {
    expect(TELEMETRY_CATALOG_VERSION).toBe(1);
    expect([...TELEMETRY_UI_ACTIONS]).toEqual([
      "screen.view",
      "board.view.change",
      "board.filter.change",
      "board.search",
      "task.create",
      "task.update",
      "task.move",
      "comment.create",
      "attachment.upload",
      "task.checklist.toggle",
    ]);
    expect([...TELEMETRY_SCREENS]).toContain("task.detail");
    expect([...TELEMETRY_SCREENS]).toContain("board");
    expect([...TELEMETRY_VIEWS]).toEqual(["board", "table", "calendar"]);
    expect([...TELEMETRY_FILTERS]).toEqual(["status", "priority", "assignee", "tags", "sort"]);
    expect([...TELEMETRY_CLIENT_EVENTS]).toEqual([
      "ui.action", "client.request.result", "client.render.failed", "client.breadcrumb", "client.problem.reported",
    ]);
    expect([...TELEMETRY_SERVER_EVENTS]).toEqual([
      "api.request.completed", "api.request.failed", "task.checklist.updated",
    ]);
  });

  it("assigns a category to every event and never to an unknown name", () => {
    for (const name of [...TELEMETRY_CLIENT_EVENTS, ...TELEMETRY_SERVER_EVENTS]) {
      expect(["usage", "diagnostic"]).toContain(TELEMETRY_EVENT_CATEGORY[name]);
    }
    expect(TELEMETRY_EVENT_CATEGORY["ui.action"]).toBe("usage");
    expect(TELEMETRY_EVENT_CATEGORY["client.request.result"]).toBe("diagnostic");
    expect(Object.keys(TELEMETRY_EVENT_CATEGORY)).toHaveLength(
      TELEMETRY_CLIENT_EVENTS.length + TELEMETRY_SERVER_EVENTS.length,
    );
  });

  it("publishes only explicit route templates and never a concrete URL or query", () => {
    for (const route of Object.values(TELEMETRY_ACTION_ROUTES)) {
      expect(route).toMatch(/^\/api\/(tasks|messages|notifications)(\/:id)?(\/[a-z]+)?(\/:[a-zA-Z]+)?$/);
      expect(route).not.toContain("?");
      expect(route).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
    // Client-only actions have no server route at all.
    for (const action of ["screen.view", "board.view.change", "board.filter.change"] as const) {
      expect(TELEMETRY_ACTION_ROUTES[action]).toBeUndefined();
    }
    // Explicit allowlist for server boundaries; registration alone does not wrap a handler.
    expect([...TELEMETRY_SERVER_ROUTES]).toEqual([
      "/api/tasks/:id",
      "/api/tasks/:id/checklist/:itemId",
      "/api/tasks/:id/messages",
      "/api/recurring-tasks",
      "/api/recurring-tasks/:id",
    ]);
  });

  it("validates names by exact membership, never by prefix or case", () => {
    expect(isTelemetryUiAction("task.create")).toBe(true);
    expect(isTelemetryUiAction("task.create ")).toBe(false);
    expect(isTelemetryUiAction("Task.Create")).toBe(false);
    expect(isTelemetryUiAction("task")).toBe(false);
    expect(isTelemetryScreen("task.detail")).toBe(true);
    expect(isTelemetryScreen("task.detail/secret")).toBe(false);
    expect(isTelemetryView("kanban")).toBe(false);
    expect(isTelemetryFilter("searchText")).toBe(false);
  });
});

describe("#54 client intent for every catalogued action", () => {
  it.each([
    ["screen.view", { screen: "board" }],
    ["board.view.change", { view: "board" }],
    ["board.filter.change", { filter: "status" }],
    ["board.search", {}],
    ["task.create", {}],
    ["task.update", {}],
    ["task.move", {}],
    ["comment.create", {}],
    ["attachment.upload", {}],
    ["task.checklist.toggle", {}],
  ] as const)("accepts ui.action %s", (action, facet) => {
    const parsed = parseClientTelemetryEvent(intent({ action, ...facet }));
    expect(parsed).toMatchObject({ event: "ui.action", action, ...facet });
  });

  it.each([...TELEMETRY_UI_ACTIONS])("accepts client.request.result %s", action => {
    expect(parseClientTelemetryEvent(result({ action }))).toMatchObject({
      event: "client.request.result", action, outcome: "success",
    });
  });

  it("requires the facet that gives an action meaning and forbids it elsewhere", () => {
    expect(parseClientTelemetryEvent(intent({ action: "screen.view" }))).toBeNull();
    expect(parseClientTelemetryEvent(intent({ action: "screen.view", screen: "board" }))).toMatchObject({ screen: "board" });
    expect(parseClientTelemetryEvent(intent({ action: "board.view.change" }))).toBeNull();
    expect(parseClientTelemetryEvent(intent({ action: "board.view.change", view: "table" }))).toMatchObject({ view: "table" });
    expect(parseClientTelemetryEvent(intent({ action: "board.filter.change" }))).toBeNull();
    expect(parseClientTelemetryEvent(intent({ action: "board.filter.change", filter: "tags" }))).toMatchObject({ filter: "tags" });

    expect(parseClientTelemetryEvent(intent({ action: "screen.view", screen: "board", view: "board" }))).toBeNull();
    expect(parseClientTelemetryEvent(intent({ action: "board.search", screen: "board" }))).toBeNull();
    expect(parseClientTelemetryEvent(intent({ action: "task.create", filter: "status" }))).toBeNull();
    expect(parseClientTelemetryEvent(intent({ action: "task.move", view: "table" }))).toBeNull();
  });

  it.each([
    { screen: "board?q=PRIVATE" },
    { screen: "PRIVATE" },
    { view: "kanban" },
    { filter: "searchText" },
    { screen: "" },
    { screen: 42 },
  ])("rejects a facet outside the closed vocabulary: %j", facet => {
    const action = "screen" in facet ? "screen.view" : "view" in facet ? "board.view.change" : "board.filter.change";
    expect(parseClientTelemetryEvent(intent({ action, ...facet }))).toBeNull();
  });

  it("never promotes user-entered text, URL or query from an intent payload", () => {
    const parsed = parseClientTelemetryEvent(intent({
      action: "board.search",
      query: "PRIVATE-SEARCH",
      search: "PRIVATE-SEARCH",
      url: "https://example.test/board?q=PRIVATE-SEARCH",
      text: "PRIVATE-TASK-TEXT",
      title: "PRIVATE-TASK-TITLE",
      value: "PRIVATE-VALUE",
    }));
    expect(parsed).toEqual({
      schemaVersion: 1, eventId: EVENT, sessionId: SESSION, actionId: ACTION,
      action: "board.search", event: "ui.action", occurredAt: NOW.toISOString(), seq: 1,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE|example\.test/);
  });

  it("rejects a facet on a request result, where only the outcome belongs", () => {
    expect(parseClientTelemetryEvent(result({ screen: "board" }))).toBeNull();
    expect(parseClientTelemetryEvent(result({ view: "board" }))).toBeNull();
    expect(parseClientTelemetryEvent(result({ filter: "tags" }))).toBeNull();
  });
});

describe("#54 client entrypoints emit one bounded intent", () => {
  const PROOF = `v1.${NOW.getTime() + 60 * 60 * 1000}.${"a".repeat(64)}`;
  type Batch = { sessionId: string; sessionToken: string; events: Shape[] };

  function fixture() {
    let seq = 0;
    const uuid = vi.fn(() => `${(++seq).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as Shape & { kind?: string; events?: Shape[] };
      if (input.kind === "session.start") {
        return Response.json({ success: true, data: { sessionId: input.sessionId, sessionToken: PROOF, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() } });
      }
      return Response.json({ success: true, data: { accepted: (input.events ?? []).map(event => event.eventId) } });
    });
    const client = new TelemetryClient({ fetch, clock: () => 0, wallClock: () => NOW, uuid });
    const events = () => fetch.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)) as Batch & { kind?: string })
      .filter(input => !input.kind)
      .flatMap(batch => batch.events);
    return { client, events };
  }

  it("records each catalogued screen/view/filter/search intent without any value", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    expect(f.client.recordScreen("task.detail")).toBe(true);
    expect(f.client.recordViewChange("calendar")).toBe(true);
    expect(f.client.recordFilterChange("assignee")).toBe(true);
    expect(f.client.recordSearch()).toBe(true);
    await f.client.flush();
    expect(f.events().map(event => [event.action, event.screen, event.view, event.filter])).toEqual([
      ["screen.view", "task.detail", undefined, undefined],
      ["board.view.change", undefined, "calendar", undefined],
      ["board.filter.change", undefined, undefined, "assignee"],
      ["board.search", undefined, undefined, undefined],
    ]);
    expect(f.events().every(event => event.event === "ui.action")).toBe(true);
    expect(new Set(f.events().map(event => event.actionId)).size).toBe(4);
  });

  it("collapses a rerender/double effect of the same intention but keeps a later distinct one", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    expect(f.client.recordScreen("board")).toBe(true);
    expect(f.client.recordScreen("board")).toBe(false);
    expect(f.client.recordScreen("board")).toBe(false);
    expect(f.client.recordScreen("inbox")).toBe(true);
    expect(f.client.recordViewChange("table")).toBe(true);
    expect(f.client.recordViewChange("table")).toBe(false);
    await f.client.flush();
    expect(f.events()).toHaveLength(3);
    expect(f.events().map(event => event.screen ?? event.view)).toEqual(["board", "inbox", "table"]);
  });

  it("returns false and never throws before a session or for an unknown action", async () => {
    const f = fixture();
    expect(f.client.recordScreen("board")).toBe(false);
    await f.client.setIdentity("actor-A");
    expect(f.client.recordUiAction("task.create" as never, { screen: "board" })).toBe(false);
    expect(f.client.recordScreen("PRIVATE-SCREEN" as never)).toBe(false);
    expect(f.client.beginAction("PRIVATE-ACTION" as never)).toBeNull();
  });

  it("never throws when the telemetry runtime itself fails", async () => {
    let broken = false;
    let uuidSeq = 0;
    const client = new TelemetryClient({
      fetch: vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const input = JSON.parse(String(init?.body)) as Shape;
        if (input.kind === "session.start") {
          return Response.json({ success: true, data: { sessionId: input.sessionId, sessionToken: PROOF, expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() } });
        }
        return Response.json({ success: true, data: { accepted: [] } });
      }),
      clock: () => { if (broken) throw new Error("PRIVATE clock"); return 0; },
      wallClock: () => { if (broken) throw new Error("PRIVATE clock"); return NOW; },
      uuid: () => `${(++uuidSeq).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
    });
    await client.setIdentity("actor-A");
    broken = true;
    expect(() => client.recordScreen("board")).not.toThrow();
    expect(client.recordScreen("board")).toBe(false);
    expect(() => client.beginAction("task.move")).not.toThrow();
    client.dispose();
  });

  it("carries the action through intent and result so a failure stays distinguishable", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    const token = f.client.beginAction("task.create")!;
    expect(token.action).toBe("task.create");
    f.client.finishAction(token, { outcome: "failure", durationMs: 8, statusCode: 500 });
    await f.client.flush();
    expect(f.events().map(event => [event.event, event.action, event.outcome])).toEqual([
      ["ui.action", "task.create", undefined],
      ["client.request.result", "task.create", "failure"],
      ["client.breadcrumb", "app.breadcrumb", undefined],
      ["client.breadcrumb", "app.breadcrumb", "failure"],
    ]);
    expect(f.events().every(event => event.actionId === token.actionId)).toBe(true);
  });

  it("keeps the existing checklist call site unchanged", async () => {
    const f = fixture();
    await f.client.setIdentity("actor-A");
    const token = f.client.beginAction()!;
    expect(token.action).toBe("task.checklist.toggle");
    f.client.finishAction(token, { outcome: "success", durationMs: 2 });
    await f.client.flush();
    expect(f.events().map(event => event.action)).toEqual(["task.checklist.toggle", "task.checklist.toggle"]);
  });
});

describe("#54 persistence and reporting of the extended catalog", () => {
  async function ingest(input: unknown) {
    return ingestTelemetryBatch(telemetryActorKey("actorA")!, input, NOW);
  }

  it("stores the screen facet and reports it back without user data", async () => {
    const binding = await startTelemetrySession(telemetryActorKey("actorA")!, SESSION, NOW);
    const event = intent({ action: "screen.view", screen: "task.detail", title: "PRIVATE-TITLE", query: "PRIVATE-QUERY" });
    await expect(ingest({ sessionId: SESSION, sessionToken: binding.sessionToken, events: [event] })).resolves.toEqual([EVENT]);
    const row = db.telemetryEvent.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ event: "ui.action", category: "usage", source: "client", trust: "client_reported" });
    expect(row.payload).toEqual({ schemaVersion: 1, action: "screen.view", seq: 1, screen: "task.detail" });
    expect(JSON.stringify(db.telemetryEvent.createMany.mock.calls)).not.toMatch(/PRIVATE/);

    const safe = safeAdminEvent({ ...row, id: "row-1", actionId: ACTION, requestId: null, errorId: null,
      operationId: null, projectId: null, taskId: null, sessionId: SESSION } as never);
    expect(safe?.payload).toEqual({ schemaVersion: 1, action: "screen.view", seq: 1, screen: "task.detail" });
    expect(safe?.category).toBe("usage");
  });

  it("rejects a stored row whose facet belongs to another action", async () => {
    const stored = {
      id: "row-1", actorKey: telemetryActorKey("actorA")!, eventId: EVENT,
      receivedAt: NOW, occurredAt: NOW, event: "ui.action", category: "usage",
      source: "client", trust: "client_reported", actionId: ACTION, requestId: null, errorId: null,
      operationId: null, sessionId: SESSION, projectId: null, taskId: null,
      payload: { schemaVersion: 1, action: "task.create", seq: 1, screen: "board" },
    };
    expect(safeAdminEvent(stored as never)).toBeNull();
  });

  it("counts a catalogued screen/view/filter intent as one unique action", () => {
    const base: TelemetryReportEvent = {
      id: "row-1", actorKey: telemetryActorKey("actorA")!, eventId: EVENT,
      receivedAt: NOW.toISOString(), occurredAt: NOW.toISOString(), event: "ui.action",
      category: "usage", source: "client", trust: "client_reported",
      actionId: ACTION, sessionId: SESSION,
      payload: { schemaVersion: 1, action: "screen.view", seq: 1, screen: "board" },
    };
    expect(summarizeTelemetryEvents([base], WINDOW, false, 100).usage.uniqueActions).toBe(1);
    expect(summarizeTelemetryEvents([
      base,
      { ...base, id: "row-2", eventId: "a12bc345-6789-4abc-8def-012345678902",
        actionId: "c12bc345-6789-4abc-8def-012345678902",
        payload: { schemaVersion: 1, action: "board.filter.change", seq: 2, filter: "priority" } },
    ], WINDOW, false, 100).usage.uniqueActions).toBe(2);
  });

  it("does not count an action that is absent from the catalog", () => {
    const base: TelemetryReportEvent = {
      id: "row-1", actorKey: telemetryActorKey("actorA")!, eventId: EVENT,
      receivedAt: NOW.toISOString(), occurredAt: NOW.toISOString(), event: "ui.action",
      category: "usage", source: "client", trust: "client_reported",
      actionId: ACTION, sessionId: SESSION,
      payload: { schemaVersion: 1, action: "task.delete" as never, seq: 1 },
    };
    expect(summarizeTelemetryEvents([base], WINDOW, false, 100).usage.uniqueActions).toBe(0);
  });

  it("rejects a whole batch that mixes a valid intent with an uncatalogued action", () => {
    expect(parseClientTelemetryBatch({
      sessionId: SESSION,
      sessionToken: `v1.${NOW.getTime() + 60_000}.${"a".repeat(64)}`,
      events: [intent({ action: "screen.view", screen: "board" }), intent({ action: "task.delete" })],
    })).toBeNull();
  });
});
