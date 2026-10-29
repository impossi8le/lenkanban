import { describe, expect, it, vi } from "vitest";
import {
  parseClientTelemetryBatch,
  parseClientTelemetryEvent,
  parseTelemetrySessionStart,
} from "./contract";

const EVENT = "A12BC345-6789-4ABC-8DEF-012345678901";
const SESSION = "B12BC345-6789-4ABC-8DEF-012345678901";
const ACTION = "C12BC345-6789-4ABC-8DEF-012345678901";
const OTHER_SESSION = "D12BC345-6789-4ABC-8DEF-012345678901";
const TIME = "2026-10-20T12:34:56.789Z";
const SESSION_TOKEN = `v1.1792500000000.${"a".repeat(64)}`;
function event(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, eventId: EVENT, sessionId: SESSION, actionId: ACTION,
    action: "task.checklist.toggle", occurredAt: TIME, seq: 0, event: "ui.action", ...extra,
  };
}
function result(extra: Record<string, unknown> = {}) {
  return event({ event: "client.request.result", outcome: "success", durationMs: 1.25, ...extra });
}
function batch(events: unknown[] = [event()]) { return { sessionId: SESSION, sessionToken: SESSION_TOKEN, events }; }
function session() { return { kind: "session.start", sessionId: SESSION }; }
const parsers = [parseClientTelemetryEvent, parseClientTelemetryBatch, parseTelemetrySessionStart];
const fixtures = [event, batch, session];
const privileged = ["actorId", "actorKey", "source", "trust", "receivedAt", "category"];

describe("closed client telemetry contract", () => {
  it("creates a new minimal intent with lowercase identifiers, independent of caller mutation", () => {
    const input = event();
    const parsed = parseClientTelemetryEvent(input);
    expect(parsed).toEqual({ ...input, eventId: EVENT.toLowerCase(), sessionId: SESSION.toLowerCase(), actionId: ACTION.toLowerCase() });
    expect(parsed).not.toBe(input);
    input.seq = 999;
    expect(parsed?.seq).toBe(0);
  });

  it.each(["success", "rejected", "conflict", "failure", "cancelled"])("accepts declared request outcome %s without fabricating response IDs", outcome => {
    const parsed = parseClientTelemetryEvent(result({ outcome }));
    expect(parsed).toMatchObject({ event: "client.request.result", outcome, durationMs: 1.25 });
    expect(parsed).not.toHaveProperty("requestId");
    expect(parsed).not.toHaveProperty("errorId");
    expect(parsed).not.toHaveProperty("statusCode");
  });

  it("normalizes optional response IDs and preserves only explicitly accepted fields", () => {
    const parsed = parseClientTelemetryEvent(result({ statusCode: 409, requestId: ACTION, errorId: EVENT, errorMessage: "private" }));
    expect(parsed).toEqual({
      ...event(), eventId: EVENT.toLowerCase(), sessionId: SESSION.toLowerCase(), actionId: ACTION.toLowerCase(),
      event: "client.request.result", outcome: "success", durationMs: 1.25,
      statusCode: 409, requestId: ACTION.toLowerCase(), errorId: EVENT.toLowerCase(),
    });
  });

  it.each(privileged)("rejects privileged own %s at every entry point even if non-enumerable or undefined", key => {
    parsers.forEach((parse, index) => {
      const input = fixtures[index]();
      Object.defineProperty(input, key, { value: undefined, enumerable: false });
      expect(parse(input)).toBeNull();
    });
  });

  it.each(privileged)("rejects privileged getter %s without invoking it", key => {
    const getter = vi.fn(() => { throw new Error("private getter body"); });
    parsers.forEach((parse, index) => {
      const input = fixtures[index]();
      Object.defineProperty(input, key, { get: getter });
      expect(parse(input)).toBeNull();
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("strips unknown keys without traversing secrets, cycles, Error fields, symbols or getters", () => {
    const getter = vi.fn(() => { throw new Error("private getter body"); });
    const cyclic: Record<string, unknown> = { PASSWORD: "synthetic-secret" };
    cyclic.self = cyclic;
    const input = Object.assign(new Error("synthetic-error-secret"), event(), {
      nested: { accessToken: "synthetic-token", cookie: "synthetic-cookie", Authorization: "Bearer private", cyclic },
      [Symbol("private")]: "synthetic-symbol-secret",
    });
    Object.defineProperty(input, "unknownGetter", { get: getter, enumerable: true });
    Object.defineProperty(input, "toJSON", { get: getter });
    const parsed = parseClientTelemetryEvent(input);
    expect(parsed).toEqual(parseClientTelemetryEvent(event()));
    expect(JSON.stringify(parsed)).not.toMatch(/synthetic-|Bearer|PASSWORD|nested|stack|message/);
    expect(getter).not.toHaveBeenCalled();
  });

  it("never enumerates unknown own keys or reads ordinary Proxy properties", () => {
    const get = vi.fn(() => { throw new Error("must not read values through Proxy.get"); });
    const ownKeys = vi.fn(() => { throw new Error("must not enumerate payload"); });
    const input = new Proxy(event(), { get, ownKeys });
    expect(parseClientTelemetryEvent(input)).toEqual(parseClientTelemetryEvent(event()));
    expect(get).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("does not promote inherited identity fields or leak inherited privileged/unknown properties", () => {
    const inheritedRequired = Object.create(event());
    expect(parseClientTelemetryEvent(inheritedRequired)).toBeNull();
    const input = Object.assign(Object.create({ actorId: "forged", source: "server", nested: "secret" }), event());
    expect(parseClientTelemetryEvent(input)).toEqual(parseClientTelemetryEvent(event()));
  });

  it.each(["eventId", "sessionId", "actionId", "event", "occurredAt", "seq"])("rejects required getter %s without evaluating it", key => {
    const input = event();
    const getter = vi.fn(() => { throw new Error("private"); });
    Object.defineProperty(input, key, { get: getter });
    expect(parseClientTelemetryEvent(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([null, undefined, [], "text", 42, false])("rejects non-record input %j without throwing", input => {
    parsers.forEach(parse => expect(parse(input)).toBeNull());
  });

  it("fails closed on descriptor-trap failures and revoked proxies", () => {
    const trap = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private proxy error"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const input of [trap, revoked.proxy]) parsers.forEach(parse => {
      expect(() => parse(input)).not.toThrow();
      expect(parse(input)).toBeNull();
    });
  });

  it.each([
    { schemaVersion: "1" }, { schemaVersion: 2 }, { action: "request.clarification.respond" },
    { event: "task.checklist.updated" }, { eventId: "not-a-uuid" }, { sessionId: "" }, { actionId: "00000000-0000-0000-0000-000000000000" },
    { seq: -1 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: NaN }, { seq: Infinity },
  ])("rejects malformed discriminant/identity/sequence %j", extra => expect(parseClientTelemetryEvent(event(extra))).toBeNull());

  it("accepts the safe integer sequence boundary", () => expect(parseClientTelemetryEvent(event({ seq: Number.MAX_SAFE_INTEGER }))?.seq).toBe(Number.MAX_SAFE_INTEGER));

  it.each([
    "2026-10-20T12:34:56Z", "2026-10-20T15:34:56.789+03:00", "2026-10-20T12:34:56.789",
    "2026-02-30T12:34:56.789Z", "2026-10-20T12:34:56.7890Z", "not-a-date", TIME + " ", 0,
  ])("rejects timestamps that are not exact canonical UTC ISO with milliseconds: %j", occurredAt => {
    expect(parseClientTelemetryEvent(event({ occurredAt }))).toBeNull();
  });

  it.each(["outcome", "durationMs", "statusCode", "requestId", "errorId", "status", "duration", "request", "error"])("rejects UI intent carrying result field %s", key => {
    expect(parseClientTelemetryEvent(event({ [key]: undefined }))).toBeNull();
  });

  it.each([
    { outcome: undefined }, { outcome: "committed" }, { durationMs: undefined },
    { durationMs: -0.01 }, { durationMs: 86400000.01 }, { durationMs: Infinity }, { durationMs: NaN },
    { statusCode: 99 }, { statusCode: 600 }, { statusCode: 200.1 }, { statusCode: "200" },
    { requestId: null }, { errorId: "forged" },
  ])("rejects malformed result fields %j", extra => expect(parseClientTelemetryEvent(result(extra))).toBeNull());

  it.each([0, 86400000])("accepts durationMs boundary %s", durationMs => expect(parseClientTelemetryEvent(result({ durationMs }))).not.toBeNull());
  it.each([100, 599])("accepts statusCode boundary %s", statusCode => expect(parseClientTelemetryEvent(result({ statusCode }))).not.toBeNull());

  it("rejects an accessor on an optional result field rather than silently dropping it", () => {
    const input = result();
    const getter = vi.fn(() => ACTION);
    Object.defineProperty(input, "requestId", { get: getter });
    expect(parseClientTelemetryEvent(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("batch and session boundaries", () => {
  it("accepts 1..10 same-session events and normalizes every UUID", () => {
    for (const length of [1, 10]) {
      const parsed = parseClientTelemetryBatch(batch(Array.from({ length }, (_, seq) => event({ seq }))));
      expect(parsed?.sessionId).toBe(SESSION.toLowerCase());
      expect(parsed?.events).toHaveLength(length);
      expect(parsed?.events.every(item => item.sessionId === parsed.sessionId)).toBe(true);
    }
  });

  it("rejects the whole batch when one event is invalid or belongs to a different session", () => {
    for (const bad of [event({ source: "server" }), event({ sessionId: OTHER_SESSION }), result({ durationMs: -1 })]) {
      expect(parseClientTelemetryBatch(batch([event(), bad, event()]))).toBeNull();
    }
  });

  it("rejects empty/oversized/sparse batches and inherited array entries", () => {
    expect(parseClientTelemetryBatch(batch([]))).toBeNull();
    expect(parseClientTelemetryBatch(batch(Array.from({ length: 11 }, () => event())))).toBeNull();
    const sparse = new Array(1);
    expect(parseClientTelemetryBatch(batch(sparse))).toBeNull();
    Object.setPrototypeOf(sparse, { 0: event() });
    expect(parseClientTelemetryBatch(batch(sparse))).toBeNull();
  });

  it("reads batch array slots/length only through data descriptors", () => {
    const getter = vi.fn(() => { throw new Error("private"); });
    const events = [event()];
    Object.defineProperty(events, "0", { get: getter });
    expect(parseClientTelemetryBatch(batch(events))).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const read = vi.fn(() => { throw new Error("array property get forbidden"); });
    expect(parseClientTelemetryBatch(batch(new Proxy([event()], { get: read })))).not.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("strips batch/session unknown containers without reading getters or mutating input", () => {
    const getter = vi.fn(() => { throw new Error("synthetic private"); });
    const input = { ...batch(), nested: { cookie: "synthetic-cookie" } };
    Object.defineProperty(input, "unknown", { get: getter });
    const parsed = parseClientTelemetryBatch(input);
    expect(parsed).toEqual({ sessionId: SESSION.toLowerCase(), sessionToken: SESSION_TOKEN, events: [parseClientTelemetryEvent(event())] });
    expect(parsed?.events).not.toBe(input.events);
    const init = Object.assign(Object.create({ source: "server" }), session(), { nested: input });
    expect(parseTelemetrySessionStart(init)).toEqual({ kind: "session.start", sessionId: SESSION.toLowerCase() });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([{}, { kind: "session.end", sessionId: SESSION }, { kind: "session.start", sessionId: "bad" }])("rejects malformed session start %j", input => {
    expect(parseTelemetrySessionStart(input)).toBeNull();
  });

  it.each([
    undefined, null, "", `v2.1792500000000.${"a".repeat(64)}`,
    `v1.179250000000.${"a".repeat(64)}`, `v1.1792500000000.${"a".repeat(63)}`,
    `v1.1792500000000.${"A".repeat(64)}`, SESSION_TOKEN + "\n",
  ])("rejects missing or malformed batch binding proof %j", sessionToken => {
    expect(parseClientTelemetryBatch({ ...batch(), sessionToken })).toBeNull();
  });

  it("rejects absent/inherited/getter sessionToken without evaluating an accessor", () => {
    expect(parseClientTelemetryBatch({ sessionId: SESSION, events: [event()] })).toBeNull();
    const inherited = Object.assign(Object.create({ sessionToken: SESSION_TOKEN }), { sessionId: SESSION, events: [event()] });
    expect(parseClientTelemetryBatch(inherited)).toBeNull();
    const input = batch();
    const getter = vi.fn(() => SESSION_TOKEN);
    Object.defineProperty(input, "sessionToken", { get: getter });
    expect(parseClientTelemetryBatch(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});
