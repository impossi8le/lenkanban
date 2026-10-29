import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isTelemetryConfigured, readTelemetryJson, requireTelemetryOrigin, telemetryConfiguration,
  telemetryFailure, TELEMETRY_BODY_LIMIT, TELEMETRY_BODY_TIMEOUT_MS,
} from "./http";

beforeEach(() => {
  for (const name of ["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL"]) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function request(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/telemetry", {
    method: "POST", body, headers: { "content-type": "application/json", ...headers },
    duplex: "half",
  } as RequestInit);
}

describe("telemetry bounded HTTP input", () => {
  it("requires explicit enablement and a printable strong secret", () => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    for (const secret of ["", "short", "x".repeat(31), "x".repeat(32) + "\n"]) {
      vi.stubEnv("TELEMETRY_HMAC_SECRET", secret);
      expect(telemetryConfiguration()).toBeNull();
    }
    vi.stubEnv("TELEMETRY_HMAC_SECRET", "x".repeat(32));
    expect(telemetryConfiguration()).not.toBeNull();
    vi.stubEnv("TELEMETRY_ENABLED", "false");
    expect(telemetryConfiguration()).toBeNull();
  });

  it("exposes availability as a boolean and never the secret", () => {
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_HMAC_SECRET", "s".repeat(40));
    expect(isTelemetryConfigured()).toBe(true);
    vi.stubEnv("TELEMETRY_ENABLED", "false");
    expect(isTelemetryConfigured()).toBe(false);
    vi.stubEnv("TELEMETRY_ENABLED", "true");
    vi.stubEnv("TELEMETRY_HMAC_SECRET", "short");
    expect(isTelemetryConfigured()).toBe(false);
    expect(typeof isTelemetryConfigured()).toBe("boolean");
  });

  it.each([undefined, "null", "https://other.test", "https://app.test/path"])("rejects origin %s", (origin) => {
    const headers: Record<string, string> = origin ? { origin } : {};
    expect(() => requireTelemetryOrigin(new Request("https://app.test/api/telemetry", { headers })))
      .toThrow("TELEMETRY_ORIGIN_REJECTED");
  });

  it("accepts same origin and rejects cross-site metadata", () => {
    expect(() => requireTelemetryOrigin(request("{}", { origin: "https://app.test" }))).not.toThrow();
    expect(() => requireTelemetryOrigin(request("{}", { origin: "https://app.test", "sec-fetch-site": "cross-site" })))
      .toThrow();
  });

  it.each(["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL"])("accepts configured %s public origin behind an internal proxy", name => {
    vi.stubEnv(name, "https://public.app.test");
    expect(() => requireTelemetryOrigin(new Request("http://app:3555/api/telemetry", {
      method: "POST", headers: { origin: "https://public.app.test", "sec-fetch-site": "same-origin" },
    }))).not.toThrow();
  });

  it.each<Record<string, string>>([
    { origin: "https://evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" },
    { origin: "https://evil.test", forwarded: "host=evil.test;proto=https" },
    { origin: "http://app:3555", "sec-fetch-site": "same-origin" },
    { authorization: "Bearer synthetic", "sec-fetch-site": "same-origin" },
    { origin: "https://public.app.test", "sec-fetch-site": "cross-site" },
    { origin: "https://public.app.test", "sec-fetch-site": "same-site" },
  ])("rejects spoofed, missing or cross-site public-origin request %#", headers => {
    vi.stubEnv("NEXTAUTH_URL", "https://public.app.test");
    expect(() => requireTelemetryOrigin(new Request("http://app:3555/api/telemetry", {
      method: "POST", headers,
    }))).toThrow("TELEMETRY_ORIGIN_REJECTED");
  });

  it("ignores forged forwarded headers even when no public origin is configured", () => {
    expect(() => requireTelemetryOrigin(new Request("http://app:3555/api/telemetry", {
      headers: { origin: "https://evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" },
    }))).toThrow("TELEMETRY_ORIGIN_REJECTED");
  });

  it("fails closed for malformed higher-priority trusted origin configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://user:password@evil.test");
    vi.stubEnv("NEXTAUTH_URL", "https://public.app.test");
    expect(() => requireTelemetryOrigin(new Request("http://app:3555/api/telemetry", {
      headers: { origin: "https://public.app.test" },
    }))).toThrow("TELEMETRY_ORIGIN_REJECTED");
  });

  it("parses JSON without trusting declared byte length", async () => {
    await expect(readTelemetryJson(request('{"ok":true}'))).resolves.toEqual({ ok: true });
    await expect(readTelemetryJson(request(JSON.stringify("я".repeat(TELEMETRY_BODY_LIMIT / 2)), { "content-length": "1" })))
      .rejects.toMatchObject({ status: 413 });
  });

  it.each([
    ["{}", { "content-type": "text/plain" }, 415],
    ["{}", { "content-length": String(TELEMETRY_BODY_LIMIT + 1) }, 413],
    ["{", {}, 400],
  ] as const)("rejects invalid input %#", async (body, headers, status) => {
    await expect(readTelemetryJson(request(body, headers))).rejects.toMatchObject({ status });
  });

  it("rejects invalid UTF8", async () => {
    await expect(readTelemetryJson(request(new Uint8Array([0xff])))).rejects.toMatchObject({ status: 400 });
  });

  it("uses one total deadline even when reading never settles and cancellation stalls", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const result = readTelemetryJson(request(body));
    const assertion = expect(result).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(TELEMETRY_BODY_TIMEOUT_MS);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])("oversize returns despite %s rejecting cancellation", async (reject) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(TELEMETRY_BODY_LIMIT + 1)); },
      cancel() { return reject ? Promise.reject(Error("private")) : new Promise<void>(() => undefined); },
    });
    await expect(readTelemetryJson(request(body))).rejects.toMatchObject({ status: 413 });
  });

  it("never serializes hostile error objects", async () => {
    const error = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("private"); }, getPrototypeOf() { throw Error("private"); } });
    const response = telemetryFailure(error);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});
