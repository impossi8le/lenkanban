import { describe, expect, it } from "vitest";
import {
  BREADCRUMB_NAMES,
  BreadcrumbRing,
  isBreadcrumbErrorCode,
  isBreadcrumbKind,
  isBreadcrumbName,
  validTraceId,
  type BreadcrumbInput,
} from "./breadcrumbs";
import { parseClientTelemetryEvent } from "./contract";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const SESSION = "b12bc345-6789-4abc-8def-012345678901";
const ACTION = "c12bc345-6789-4abc-8def-012345678901";
const TRACE = "a".repeat(32);

function id(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function crumb(overrides: Partial<BreadcrumbInput> = {}): BreadcrumbInput {
  return {
    eventId: id(1),
    kind: "navigation",
    name: "board",
    seq: 1,
    occurredAt: NOW.toISOString(),
    at: 0,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: id(1),
    sessionId: SESSION,
    actionId: ACTION,
    action: "app.breadcrumb",
    event: "client.breadcrumb",
    kind: "dialog",
    name: "task.detail",
    occurredAt: NOW.toISOString(),
    seq: 3,
    ...overrides,
  };
}

describe("#55 breadcrumb catalog is closed", () => {
  it("exposes only declared kinds and names", () => {
    expect(Object.keys(BREADCRUMB_NAMES).sort()).toEqual(
      ["connectivity", "dialog", "navigation", "operation", "request", "retry"].sort(),
    );
    expect(isBreadcrumbKind("navigation")).toBe(true);
    expect(isBreadcrumbKind("task-title")).toBe(false);
    expect(isBreadcrumbName("navigation", "board")).toBe(true);
    expect(isBreadcrumbName("navigation", "SYNTHETIC-PRIVATE-TASK-TEXT")).toBe(false);
    // The task card is a dialog, not a navigation screen.
    expect(isBreadcrumbName("navigation", "task.detail")).toBe(false);
    expect(isBreadcrumbName("dialog", "task.detail")).toBe(true);
    // Operation and retry deliberately share the operation vocabulary.
    expect(isBreadcrumbName("operation", "task.update")).toBe(true);
    expect(isBreadcrumbName("retry", "task.update")).toBe(true);
    expect(isBreadcrumbErrorCode("NETWORK")).toBe(true);
    expect(isBreadcrumbErrorCode("PRIVATE")).toBe(false);
    expect(validTraceId(TRACE)).toBe(true);
    expect(validTraceId("PRIVATE")).toBe(false);
  });

  it("parses a closed breadcrumb and drops any extra text", () => {
    const parsed = parseClientTelemetryEvent(event({
      kind: "connectivity", name: "offline", state: "offline",
      text: "SYNTHETIC-PRIVATE-TASK-TEXT", taskTitle: "SYNTHETIC-PRIVATE-TASK-TEXT",
    }));
    expect(parsed).toEqual({
      schemaVersion: 1, eventId: id(1), sessionId: SESSION, actionId: ACTION,
      action: "app.breadcrumb", event: "client.breadcrumb",
      kind: "connectivity", name: "offline", state: "offline",
      occurredAt: NOW.toISOString(), seq: 3,
    });
    expect(JSON.stringify(parsed)).not.toContain("SYNTHETIC-PRIVATE");
  });

  it.each([
    ["unknown kind", { kind: "task-title" }],
    ["unknown navigation name", { name: "SYNTHETIC-PRIVATE-TASK-TEXT" }],
    ["dialog name under navigation", { kind: "navigation", name: "task.detail" }],
    ["connectivity without state", { kind: "connectivity", name: "offline" }],
    ["state on a non-connectivity crumb", { kind: "dialog", name: "task.detail", state: "offline" }],
    ["mismatched connectivity state", { kind: "connectivity", name: "offline", state: "online" }],
    ["attempt above the retry bound", { kind: "retry", name: "task.checklist.toggle", attempt: 4 }],
    ["zero attempt", { kind: "retry", name: "task.checklist.toggle", attempt: 0 }],
    ["bad outcome", { outcome: "committed" }],
    ["bad error code", { errorCode: "PRIVATE" }],
    ["status below 100", { statusCode: 99 }],
    ["status above 599", { statusCode: 600 }],
    ["negative duration", { durationMs: -1 }],
    ["bad trace", { traceId: "PRIVATE" }],
    ["wrong action", { action: "task.checklist.toggle" }],
  ])("rejects %s", (_label, overrides) => {
    expect(parseClientTelemetryEvent(event(overrides))).toBeNull();
  });

  it("accepts an optional errorCode on a request result without inventing one", () => {
    const base = {
      schemaVersion: 1, eventId: id(1), sessionId: SESSION, actionId: ACTION,
      action: "task.checklist.toggle", event: "client.request.result",
      occurredAt: NOW.toISOString(), seq: 2, outcome: "failure", durationMs: 4,
    };
    expect(parseClientTelemetryEvent(base)).not.toHaveProperty("errorCode");
    expect(parseClientTelemetryEvent({ ...base, errorCode: "NETWORK" }))
      .toMatchObject({ event: "client.request.result", errorCode: "NETWORK" });
    expect(parseClientTelemetryEvent({ ...base, errorCode: "PRIVATE" })).toBeNull();
  });
});

describe("#55 bounded ring buffer", () => {
  it("keeps insertion order and copies records on read", () => {
    const ring = new BreadcrumbRing({ capacity: 10 });
    for (let i = 1; i <= 3; i++) {
      expect(ring.record(crumb({ eventId: id(i), seq: i, at: i }), i)).toBe(true);
    }
    const snapshot = ring.snapshot(3);
    expect(snapshot.map(entry => entry.seq)).toEqual([1, 2, 3]);
    expect(snapshot.map(entry => entry.occurredAt)).toEqual([NOW.toISOString(), NOW.toISOString(), NOW.toISOString()]);
    (snapshot[0] as { name: string }).name = "settings";
    expect(ring.snapshot(3)[0].name).toBe("board");
  });

  it("drops the oldest entries beyond the fixed capacity", () => {
    const ring = new BreadcrumbRing({ capacity: 50 });
    for (let i = 1; i <= 60; i++) ring.record(crumb({ eventId: id(i), seq: i, at: i }), i);
    const snapshot = ring.snapshot(60);
    expect(snapshot).toHaveLength(50);
    expect(snapshot[0].seq).toBe(11);
    expect(snapshot.at(-1)?.seq).toBe(60);
  });

  it("expires entries after the TTL and never returns them again", () => {
    const ring = new BreadcrumbRing({ capacity: 50, ttlMs: 300_000 });
    ring.record(crumb({ at: 0 }), 0);
    expect(ring.snapshot(299_999)).toHaveLength(1);
    expect(ring.snapshot(300_000)).toHaveLength(0);
    expect(ring.length).toBe(0);
  });

  it("enforces a byte budget and rejects an oversized single entry", () => {
    const ring = new BreadcrumbRing({ capacity: 50, maxBytes: 600, maxEntryBytes: 400 });
    for (let i = 1; i <= 10; i++) ring.record(crumb({ eventId: id(i), seq: i, at: i }), i);
    const snapshot = ring.snapshot(10);
    expect(snapshot.length).toBeLessThan(10);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThanOrEqual(600);
    const tooLarge = new BreadcrumbRing({ capacity: 10, maxBytes: 100, maxEntryBytes: 100 });
    expect(tooLarge.record(crumb(), 0)).toBe(false);
    expect(tooLarge.length).toBe(0);
  });

  it("clears all entries on logout", () => {
    const ring = new BreadcrumbRing();
    ring.record(crumb({ at: 0 }), 0);
    ring.clear();
    expect(ring.snapshot(0)).toEqual([]);
    expect(ring.length).toBe(0);
  });

  it.each([
    ["invalid eventId", { eventId: "PRIVATE" }],
    ["negative seq", { seq: -1 }],
    ["non-integer seq", { seq: 1.5 }],
    ["non-canonical time", { occurredAt: "2026-10-21T12:00:00Z" }],
    ["negative monotonic time", { at: -1 }],
  ])("rejects %s without throwing", (_label, overrides) => {
    const ring = new BreadcrumbRing();
    expect(ring.record(crumb(overrides), 0)).toBe(false);
    expect(ring.length).toBe(0);
  });

  it("contains hostile inputs instead of reading getters or throwing", () => {
    const ring = new BreadcrumbRing();
    const getter = Object.defineProperty({}, "kind", { get() { throw Error("PRIVATE"); } });
    expect(() => ring.record(getter as BreadcrumbInput, 0)).not.toThrow();
    expect(ring.record(getter as BreadcrumbInput, 0)).toBe(false);
    const trapped = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("PRIVATE"); } });
    expect(ring.record(trapped as BreadcrumbInput, 0)).toBe(false);
    expect(ring.length).toBe(0);
  });
});
