import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserTelemetryClient, isTelemetryDisabledForSession, resetTelemetrySessionDisable,
} from "./client";

const EXPIRY = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PROOF = `v1.${Date.parse(EXPIRY)}.${"a".repeat(64)}`;
const KEY = "lenkanban.telemetry.disabled";

type Init = { kind: "session.start"; sessionId: string };
type Batch = { sessionId: string; sessionToken: string; events: { eventId: string }[] };

function disabledAnswer() {
  return Response.json(
    { success: false, error: { code: "TELEMETRY_UNAVAILABLE", message: "Telemetry unavailable" } },
    { status: 503 },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetTelemetrySessionDisable();
});
afterEach(() => {
  getBrowserTelemetryClient()?.dispose();
  resetTelemetrySessionDisable();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("server-reported telemetry availability", () => {
  it("a 503 TELEMETRY_UNAVAILABLE answer stops the shared client for the page session", async () => {
    const fetchMock = vi.fn(async () => disabledAnswer());
    vi.stubGlobal("fetch", fetchMock);
    const client = getBrowserTelemetryClient();
    expect(client).not.toBeNull();
    await client!.setIdentity("actor-A");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isTelemetryDisabledForSession()).toBe(true);
    expect(window.sessionStorage.getItem(KEY)).toBe("1");
    // Every later consumer receives null, so no further request is attempted.
    expect(getBrowserTelemetryClient()).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("a configured server still initializes the shared client and sends a batch", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Init | Batch;
      if ("kind" in body) {
        return Response.json({ success: true, data: { sessionId: body.sessionId, sessionToken: PROOF, expiresAt: EXPIRY } });
      }
      return Response.json({ success: true, data: { accepted: body.events.map(event => event.eventId) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = getBrowserTelemetryClient();
    expect(client).not.toBeNull();
    await client!.setIdentity("actor-A");
    expect(isTelemetryDisabledForSession()).toBe(false);
    const action = client!.beginAction();
    expect(action).not.toBeNull();
    client!.finishAction(action!, { outcome: "success", durationMs: 3 });
    await client!.flush();
    const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Init | Batch);
    expect(calls.filter(body => !("kind" in body))).toHaveLength(1);
  });

  it("an explicit reset re-enables the client after a disabled window", () => {
    window.sessionStorage.setItem(KEY, "1");
    expect(getBrowserTelemetryClient()).toBeNull();
    resetTelemetrySessionDisable();
    expect(getBrowserTelemetryClient()).not.toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});
