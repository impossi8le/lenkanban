import { expect, it, vi } from "vitest";
import { parseClientTelemetryEvent, parseClientTelemetryBatch } from "./contract";
const UUID = "A12BC345-6789-4ABC-8DEF-012345678901";
const PROOF = `v1.1792500000000.${"a".repeat(64)}`;
function render(extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, event: "client.render.failed", action: "app.render",
    eventId: UUID, sessionId: UUID, actionId: UUID, errorId: UUID, errorCode: "RENDER_FAILURE",
    occurredAt: "2026-10-20T12:00:00.000Z", seq: 1, ...extra };
}

it("accepts the closed render event and normalizes its local reference in a valid batch", () => {
  const expected = { ...render(), eventId: UUID.toLowerCase(), sessionId: UUID.toLowerCase(), actionId: UUID.toLowerCase(), errorId: UUID.toLowerCase() };
  expect(parseClientTelemetryEvent(render())).toEqual(expected);
  expect(parseClientTelemetryBatch({ sessionId: UUID, sessionToken: PROOF, events: [render()] })?.events).toEqual([expected]);
});

it.each([
  { event: "ui.action" }, { event: "client.request.result" }, { action: "task.checklist.toggle" },
  { errorCode: "PRIVATE_RENDER_MESSAGE" }, { errorId: "invalid" }, { errorId: undefined },
])("rejects a mismatched render event/action/error contract %j", extra => expect(parseClientTelemetryEvent(render(extra))).toBeNull());

it.each(["outcome", "durationMs", "statusCode", "requestId"])("rejects own render result field %s even when undefined or an accessor", key => {
  expect(parseClientTelemetryEvent(render({ [key]: undefined }))).toBeNull();
  const getter = vi.fn(() => { throw new Error("private"); });
  const input = render();
  Object.defineProperty(input, key, { get: getter });
  expect(parseClientTelemetryEvent(input)).toBeNull();
  expect(getter).not.toHaveBeenCalled();
});

it.each(["errorId", "errorCode"])("rejects required render getter %s without running it", key => {
  const getter = vi.fn(() => { throw new Error("synthetic-private"); });
  const input = render();
  Object.defineProperty(input, key, { get: getter });
  expect(parseClientTelemetryEvent(input)).toBeNull();
  expect(getter).not.toHaveBeenCalled();
});

it("drops unknown render text, nested secrets and Error details without invoking getters", () => {
  const getter = vi.fn(() => { throw new Error("synthetic-private"); });
  const input = Object.assign(new Error("synthetic-private-message"), render(), { nested: { password: "synthetic-password", cookie: "synthetic-cookie" } });
  Object.defineProperty(input, "unknown", { get: getter });
  const parsed = parseClientTelemetryEvent(input);
  expect(parsed).toEqual(parseClientTelemetryEvent(render()));
  expect(JSON.stringify(parsed)).not.toMatch(/synthetic-|nested|password|cookie|message|stack/);
  expect(getter).not.toHaveBeenCalled();
});
