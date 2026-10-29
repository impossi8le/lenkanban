import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client";
const ERROR_ID = "a12bc345-6789-4abc-8def-012345678901";
const EXPIRY = "2026-10-21T12:00:00.000Z";
const PROOF = `v1.${Date.parse(EXPIRY)}.${"a".repeat(64)}`;
type Sent = { sessionId: string; events: Array<Record<string, unknown>> };
const clients: TelemetryClient[] = [];
function fixture() {
  let id = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    bodies.push(body);
    return Response.json(body.kind === "session.start"
      ? { success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: EXPIRY } }
      : { success: true, data: { accepted: body.events.map((event: { eventId: string }) => event.eventId) } });
  });
  const client = new TelemetryClient({ fetch, wallClock: () => new Date("2026-10-20T12:00:00.000Z"), uuid: () => `${(++id).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111` });
  clients.push(client);
  return { client, fetch, bodies, batches: () => bodies.filter(body => !body.kind) as unknown as Sent[] };
}
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers(); });

it("never queues render failures before ready, while signed out, or after dispose", async () => {
  const f = fixture();
  f.client.captureRenderFailure(ERROR_ID);
  await f.client.flush();
  expect(f.fetch).not.toHaveBeenCalled();
  await f.client.setIdentity("actor-A");
  await f.client.setIdentity(null);
  f.client.captureRenderFailure(ERROR_ID);
  await f.client.flush();
  expect(f.batches()).toHaveLength(0);
  f.client.dispose();
  f.client.captureRenderFailure(ERROR_ID);
  expect(f.batches()).toHaveLength(0);
});

it("queues exactly a diagnostic render event without a business intent, operation or raw exception", async () => {
  const f = fixture();
  await f.client.setIdentity("actor-A");
  f.client.captureRenderFailure(ERROR_ID.toUpperCase());
  await f.client.flush();
  expect(f.batches()).toHaveLength(1);
  expect(f.batches()[0].events).toHaveLength(1);
  expect(f.batches()[0].events[0]).toMatchObject({ event: "client.render.failed", action: "app.render", errorId: ERROR_ID, errorCode: "RENDER_FAILURE", sessionId: f.batches()[0].sessionId });
  expect(f.batches()[0].events[0]).not.toHaveProperty("operationId");
  expect(JSON.stringify(f.batches()[0].events)).not.toMatch(/ui.action|task.checklist|message|stack|payload|body/);
});

it("counts one render failure reference once per session", async () => {
  const f = fixture();
  await f.client.setIdentity("actor-A");
  f.client.captureRenderFailure(ERROR_ID);
  f.client.captureRenderFailure(ERROR_ID);
  f.client.captureRenderFailure(ERROR_ID.toUpperCase());
  await f.client.flush();
  expect(f.batches()).toHaveLength(1);
  expect(f.batches()[0].events).toHaveLength(1);
});

it("accepts the same reference again only in a fresh session", async () => {
  const f = fixture();
  await f.client.setIdentity("actor-A");
  f.client.captureRenderFailure(ERROR_ID);
  await f.client.flush();
  await f.client.setIdentity(null);
  await f.client.setIdentity("actor-B");
  f.client.captureRenderFailure(ERROR_ID);
  await f.client.flush();
  expect(f.batches().flatMap(batch => batch.events)).toHaveLength(2);
});

it.each(["", "private-message", "00000000-0000-0000-0000-000000000000"])("ignores invalid error reference %j", async errorId => {
  const f = fixture();
  await f.client.setIdentity("actor-A");
  expect(() => f.client.captureRenderFailure(errorId)).not.toThrow();
  await f.client.flush();
  expect(f.batches()).toHaveLength(0);
});

it("clears A's pending render reference before collecting B without relabeling old events", async () => {
  const f = fixture();
  await f.client.setIdentity("actor-A");
  const aSession = f.bodies[0].sessionId;
  f.client.captureRenderFailure(ERROR_ID);
  await f.client.setIdentity(null);
  await f.client.setIdentity("actor-B");
  f.client.captureRenderFailure("b12bc345-6789-4abc-8def-012345678901");
  await f.client.flush();
  expect(f.batches()).toHaveLength(1);
  expect(f.batches()[0].sessionId).not.toBe(aSession);
  expect(f.batches()[0].events).toHaveLength(1);
  expect(f.batches()[0].events[0].errorId).toBe("b12bc345-6789-4abc-8def-012345678901");
});
