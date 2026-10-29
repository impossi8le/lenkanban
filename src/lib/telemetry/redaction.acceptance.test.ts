import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #57 acceptance: synthetic secrets never reach a captured sink.
 *
 * Sinks are local: a Pino destination that records JSON lines in memory, and
 * Sentry SDK stubs that only capture the `beforeSend` callback. No DSN, no
 * network, no user environment.
 */

const pinoSink = vi.hoisted(() => ({ lines: [] as Record<string, unknown>[], fail: false }));
vi.mock("pino", async importOriginal => {
  const actual = await importOriginal<{ default: typeof import("pino") }>();
  return {
    default: (config: Parameters<typeof actual.default>[0]) =>
      actual.default(config, {
        write(chunk: string) {
          if (pinoSink.fail) throw Error("synthetic sink failure");
          pinoSink.lines.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      }),
  };
});

const sentry = vi.hoisted(() => ({ init: vi.fn(), withScope: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn(), setUser: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  init: sentry.init,
  withScope: sentry.withScope,
  captureException: sentry.captureException,
  captureMessage: sentry.captureMessage,
  setUser: sentry.setUser,
  addBreadcrumb: sentry.addBreadcrumb,
}));

import { safeError, sanitizeSentryEvent, sanitizeTelemetryContext, validCorrelationId } from "@/lib/telemetry-sanitize";
import logger, { apiLogger, logAuthEvent, logEmail, logSocketEvent } from "@/lib/logger";

const REQUEST_ID = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
const ACTION_ID = "40dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";

/** One synthetic secret per channel; every sink assertion scans for all of them. */
const SECRETS = {
  password: "SYNTHETIC-PASSWORD-9f2",
  cookie: "SYNTHETIC-COOKIE-4a7",
  bearer: "SYNTHETIC-BEARER-1c8",
  apiKey: "SYNTHETIC-APIKEY-77d",
  email: "synthetic.person@example.invalid",
  text: "SYNTHETIC-TASK-TEXT-2b6",
  urlToken: "SYNTHETIC-URL-TOKEN-5e1",
  percent: "SYNTHETIC-PERCENT-TOKEN-3aa",
  errorMessage: "SYNTHETIC-ERROR-MESSAGE-0df",
  reset: "SYNTHETIC-RESET-TOKEN-6b4",
} as const;

const ALL_SECRETS = Object.values(SECRETS);

function expectNoSecrets(value: unknown, label = "sink") {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of ALL_SECRETS) expect(serialized, `${label} leaked ${secret}`).not.toContain(secret);
}

/** Percent-encoded form of a secret, as it would appear in a real query string. */
function encoded(secret: string): string {
  return encodeURIComponent(secret);
}

beforeEach(() => {
  pinoSink.lines.length = 0;
  pinoSink.fail = false;
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("#57 nested containers, mixed case keys and cycles", () => {
  it("drops arbitrary nested objects and arrays wholesale while retaining the allowed scalar fields", () => {
    const nested = {
      requestId: REQUEST_ID,
      actionId: ACTION_ID,
      route: "/api/tasks/:id",
      method: "PATCH",
      statusCode: 409,
      durationMs: 12,
      // Every following key is outside the allowlist, in several shapes.
      payload: { comment: SECRETS.text, headers: { Authorization: SECRETS.bearer } },
      comments: [SECRETS.text, { body: SECRETS.text }],
      files: [{ name: SECRETS.text, url: `https://files.invalid/?token=${encoded(SECRETS.urlToken)}` }],
      form: new Map([["password", SECRETS.password]]),
      tags: new Set([SECRETS.apiKey]),
      [Symbol("synthetic-symbol")]: SECRETS.reset,
      nested: { deep: { deeper: [{ password: SECRETS.password }] } },
    };
    const safe = sanitizeTelemetryContext(nested);
    expect(safe).toEqual({ requestId: REQUEST_ID, actionId: ACTION_ID, route: "/api/tasks/:id", method: "PATCH", statusCode: 409, durationMs: 12 });
    expectNoSecrets(safe, "sanitized context");
    // The input object itself is not mutated or serialized.
    expect(nested.payload.comment).toBe(SECRETS.text);
  });

  it.each([
    "password", "Password", "PASSWORD", "passWord", "pwd",
    "cookie", "Cookie", "COOKIE", "set-cookie", "Set-Cookie",
    "authorization", "Authorization", "AUTHORIZATION", "proxy-authorization",
    "token", "Token", "accessToken", "access_token", "refreshToken", "refresh_token",
    "csrf", "csrfToken", "XSRF-TOKEN", "resetToken", "verificationToken",
    "apiKey", "api_key", "apikey", "x-api-key", "X-Api-Key",
    "secret", "clientSecret", "dsn", "SENTRY_DSN",
    "email", "Email", "emailAddress", "name", "fullName", "subject", "body", "text", "message", "query", "url", "headers",
  ])("never forwards the sensitive key %s regardless of case or position", key => {
    const safe = sanitizeTelemetryContext({
      requestId: REQUEST_ID,
      [key]: SECRETS.password,
      nested: { [key]: SECRETS.cookie },
      list: [{ [key]: SECRETS.bearer }],
    });
    expect(safe).toEqual({ requestId: REQUEST_ID });
    expectNoSecrets(safe, `key ${key}`);
  });

  it("handles cyclic and deeply nested structures without recursion or leaking", () => {
    const root: Record<string, unknown> = { requestId: REQUEST_ID, data: {} };
    const child: Record<string, unknown> = { password: SECRETS.password };
    child.self = child;
    root.data = child;
    root.self = root;
    expect(() => sanitizeTelemetryContext(root)).not.toThrow();
    const safe = sanitizeTelemetryContext(root);
    expect(safe).toEqual({ requestId: REQUEST_ID });
    expectNoSecrets(safe, "cyclic");
  });

  it("does not read getters or Proxy traps while sanitizing", () => {
    const getter = vi.fn(() => SECRETS.password);
    const withGetter = { requestId: REQUEST_ID } as Record<string, unknown>;
    Object.defineProperty(withGetter, "password", { get: getter, enumerable: true });
    Object.defineProperty(withGetter, "toJSON", { get: getter });
    expect(sanitizeTelemetryContext(withGetter)).toEqual({ requestId: REQUEST_ID });
    expect(getter).not.toHaveBeenCalled();
    const trapped = new Proxy({}, { getOwnPropertyDescriptor() { throw Error(SECRETS.password); } });
    expect(sanitizeTelemetryContext(trapped)).toEqual({});
    expect(sanitizeSentryEvent(trapped)).toEqual({});
  });
});

describe("#57 URL, query and header boundaries", () => {
  it.each([
    `/api/tasks/:id?token=${SECRETS.urlToken}`,
    `/api/tasks/:id?token=${encoded(SECRETS.percent)}`,
    `/api/tasks/:id?TOKEN=${encoded(SECRETS.percent)}&token=${SECRETS.urlToken}`,
    `/api/tasks/:id#${SECRETS.urlToken}`,
    `https://app.invalid/api/tasks/:id?token=${SECRETS.urlToken}`,
    `/api/tasks/${SECRETS.text}@x`,
    `/api/tasks/:id?cookie=${encoded(SECRETS.cookie)}`,
  ])("rejects the non-template route %s", route => {
    expect(sanitizeTelemetryContext({ route })).toEqual({});
  });

  it("keeps an explicit route template but drops query, hash and non-template characters", () => {
    expect(sanitizeTelemetryContext({ route: "/api/tasks/:id/checklist/:itemId" }))
      .toEqual({ route: "/api/tasks/:id/checklist/:itemId" });
    // The sanitizer cannot tell an ID from a template segment; that is why the
    // route is supplied by the route owner and checked against the catalog.
    expect(sanitizeTelemetryContext({ route: "/api/tasks/1" })).toEqual({ route: "/api/tasks/1" });
  });

  it("removes headers, cookies, query and body from a Sentry request while retaining allowed tags", () => {
    const event = sanitizeSentryEvent({
      event_id: "abc123",
      level: "error",
      request: {
        url: `https://app.invalid/api/tasks/1?token=${encoded(SECRETS.percent)}&token=${SECRETS.urlToken}`,
        query_string: `token=${encoded(SECRETS.percent)}&password=${SECRETS.password}`,
        headers: {
          Authorization: `Bearer ${SECRETS.bearer}`,
          Cookie: `session=${SECRETS.cookie}`,
          "X-Api-Key": SECRETS.apiKey,
          "Content-Type": "application/json",
        },
        data: { text: SECRETS.text, password: SECRETS.password },
        cookies: { session: SECRETS.cookie },
      },
      extra: { requestId: REQUEST_ID, actionId: ACTION_ID, authorization: SECRETS.bearer, nested: [{ cookie: SECRETS.cookie }] },
      tags: { event: "api.request.failed", password: SECRETS.password },
    });
    expect(event).not.toHaveProperty("request");
    expect(event.extra).toEqual({ requestId: REQUEST_ID, actionId: ACTION_ID });
    expect(event.tags).toEqual({ event: "api.request.failed" });
    expectNoSecrets(event, "sentry event");
  });

  it("keeps repeated/percent-encoded query values out of every sanitized breadcrumb", () => {
    const event = sanitizeSentryEvent({
      breadcrumbs: [
        { category: "xhr", message: `GET /api/tasks?token=${encoded(SECRETS.percent)}`, data: { url: `/api/tasks?token=${SECRETS.urlToken}`, password: SECRETS.password } },
        { category: "ui", message: SECRETS.text, data: { event: "ui.action", seq: 3, body: SECRETS.text } },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      { category: "application", data: {} },
      { category: "application", data: { event: "ui.action", seq: 3 } },
    ]);
    expectNoSecrets(event.breadcrumbs, "breadcrumbs");
  });
});

describe("#57 Error message, stack and cause", () => {
  it("retains only the built-in type and bounded source coordinates", () => {
    const error = new TypeError(`${SECRETS.errorMessage} password=${SECRETS.password}`);
    error.stack = [
      `TypeError: ${SECRETS.errorMessage} password=${SECRETS.password}`,
      "    at handler (C:/private/route.ts:42:9)",
      `    at fetch (https://app.invalid/api?token=${encoded(SECRETS.percent)})`,
      `    at ${SECRETS.text}`,
    ].join("\n");
    Object.defineProperty(error, "cause", { value: new Error(SECRETS.cookie), enumerable: true });
    const safe = safeError(error);
    expect(safe).toEqual({ type: "TypeError", message: "Application error", frames: [{ filename: "route.ts", lineno: 42, colno: 9 }] });
    expectNoSecrets(safe, "safeError");
  });

  it("does not let a multiline message impersonate source frames", () => {
    const error = Error(`${SECRETS.errorMessage}\n    at C:/${SECRETS.percent}.ts:1:2`);
    const safe = safeError(error);
    expect(safe.type).toBe("Error");
    // The spoofed frame belongs to the message header, so it is never parsed as
    // a source location. Only real stack frames may appear.
    expect((safe.frames ?? []).some(frame => String(frame.filename).includes("SYNTHETIC"))).toBe(false);
    expectNoSecrets(safe, "multiline");
  });

  it("keeps exception values out of the sanitized Sentry event", () => {
    const event = sanitizeSentryEvent({
      exception: {
        values: [{
          type: "Error",
          value: `${SECRETS.errorMessage} password=${SECRETS.password}`,
          mechanism: { type: "onerror", data: { token: SECRETS.bearer } },
          stacktrace: {
            frames: [
              { in_app: true, filename: `C:/private/${SECRETS.text}/route.ts?token=${encoded(SECRETS.urlToken)}`, lineno: 7, colno: 3, vars: { password: SECRETS.password }, pre_context: [SECRETS.text] },
              { in_app: false, filename: `C:/private/${SECRETS.text}/hidden.ts`, lineno: 1, colno: 1 },
            ],
          },
        }],
      },
    });
    expect(event.exception).toEqual({
      values: [{ type: "Error", value: "Application error", stacktrace: { frames: [{ in_app: true, filename: "route.ts", lineno: 7, colno: 3 }] } }],
    });
    expectNoSecrets(event, "exception");
  });
});

describe("#57 actual Pino sink with a local destination", () => {
  it("keeps allowed correlation fields and removes nested arrays, mixed-case keys, URLs and Error.message", () => {
    apiLogger.error({
      schemaVersion: 1,
      event: "api.request.failed",
      source: "server",
      requestId: REQUEST_ID,
      actionId: ACTION_ID,
      // A malformed identifier must be dropped, not copied as an opaque string.
      errorId: `not-a-uuid-${SECRETS.percent}`,
      route: "/api/tasks/:id",
      method: "PATCH",
      statusCode: 500,
      outcome: "failure",
      err: Object.assign(new Error(`${SECRETS.errorMessage} password=${SECRETS.password}`), { stack: `Error: ${SECRETS.errorMessage}\n    at x (C:/a/route.ts:1:2)` }),
      Authorization: `Bearer ${SECRETS.bearer}`,
      Cookie: SECRETS.cookie,
      nested: [{ Password: SECRETS.password }, { "X-Api-Key": SECRETS.apiKey }],
      url: `/api/tasks/1?token=${encoded(SECRETS.percent)}`,
      text: SECRETS.text,
    }, `free-form ${SECRETS.text}`);
    expect(pinoSink.lines).toHaveLength(1);
    expect(pinoSink.lines[0]).toMatchObject({
      module: "api",
      event: "api.request.failed",
      requestId: REQUEST_ID,
      actionId: ACTION_ID,
      route: "/api/tasks/:id",
      method: "PATCH",
      statusCode: 500,
      outcome: "failure",
      // Pino's own `err` serializer runs after the hook and rewrites the safe
      // object, but the fixed message and the absence of raw fields remain.
      err: { message: "Application error" },
    });
    expect(pinoSink.lines[0].msg).toBe("Application event");
    expectNoSecrets(pinoSink.lines, "pino");
  });

  it("sanitizes child bindings for every logger module", () => {
    for (const sink of [logger, apiLogger]) {
      sink.child({ Cookie: SECRETS.cookie, email: SECRETS.email, module: "socket", requestId: REQUEST_ID }).info({ event: "socket.auth.succeeded" });
    }
    logAuthEvent("login", "actor-1", SECRETS.email, false, Error(SECRETS.errorMessage));
    logEmail(SECRETS.email, SECRETS.text, false, Error(SECRETS.errorMessage));
    logSocketEvent("socket.connection.created", "socket-1", "actor-1", { token: SECRETS.bearer, text: SECRETS.text });
    // debug-level socket events are filtered by the default `info` level.
    expect(pinoSink.lines).toHaveLength(4);
    expect(pinoSink.lines[0]).toMatchObject({ module: "socket", requestId: REQUEST_ID, event: "socket.auth.succeeded" });
    expectNoSecrets(pinoSink.lines, "pino helpers");
  });

  it("never falls back to console when the sink fails", () => {
    pinoSink.fail = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => logger.error({ err: Error(SECRETS.errorMessage), password: SECRETS.password }, SECRETS.text)).not.toThrow();
    expect(() => apiLogger.info({ event: "api.request.completed", cookie: SECRETS.cookie })).not.toThrow();
    expect(() => logAuthEvent("login", "actor-1", SECRETS.email, false, Error(SECRETS.errorMessage))).not.toThrow();
    expect(() => logEmail(SECRETS.email, SECRETS.text, false)).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore(); error.mockRestore(); warn.mockRestore();
  });
});

describe("#57 client and server beforeSend use the shared boundary", () => {
  async function loadBeforeSend(config: "client" | "server"): Promise<(event: Record<string, unknown>) => Record<string, unknown>> {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://synthetic-key@o0.ingest.invalid/1");
    vi.stubEnv("SENTRY_DSN", "https://synthetic-key@o0.ingest.invalid/1");
    await import(config === "client" ? "../../../sentry.client.config" : "../../../sentry.server.config");
    const options = sentry.init.mock.calls.at(-1)?.[0] as { beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> } | undefined;
    expect(options?.beforeSend).toBeTypeOf("function");
    return options!.beforeSend!;
  }

  const hostileEvent = () => ({
    event_id: "abc123",
    level: "error",
    message: `${SECRETS.errorMessage} ${SECRETS.text}`,
    request: {
      url: `https://app.invalid/api/tasks/1?token=${encoded(SECRETS.percent)}`,
      headers: { Authorization: `Bearer ${SECRETS.bearer}`, Cookie: SECRETS.cookie, "X-Api-Key": SECRETS.apiKey },
      data: { text: SECRETS.text },
    },
    user: { id: "actor-1", email: SECRETS.email, username: SECRETS.text },
    extra: { requestId: REQUEST_ID, actionId: ACTION_ID, password: SECRETS.password, nested: [{ token: SECRETS.bearer }] },
    contexts: { private: { cookie: SECRETS.cookie } },
    tags: { event: "api.request.failed", password: SECRETS.password },
    breadcrumbs: [{ message: SECRETS.text, data: { password: SECRETS.password, actionId: ACTION_ID } }],
    exception: { values: [{ type: "Error", value: SECRETS.errorMessage, stacktrace: { frames: [{ in_app: true, filename: "route.ts", lineno: 1, colno: 1 }] } }] },
  });

  it.each(["client", "server"] as const)("%s beforeSend strips secrets and keeps safe correlation", async config => {
    const beforeSend = await loadBeforeSend(config);
    const safe = beforeSend(hostileEvent());
    expect(safe).not.toHaveProperty("request");
    expect(safe).not.toHaveProperty("contexts");
    expect(safe.message).toBe("Application error");
    expect(safe.user).toEqual({ id: "actor-1" });
    expect(safe.extra).toEqual({ requestId: REQUEST_ID, actionId: ACTION_ID });
    expect(safe.tags).toEqual({ event: "api.request.failed" });
    expect(safe.breadcrumbs).toEqual([{ category: "application", data: { actionId: ACTION_ID } }]);
    expectNoSecrets(safe, `${config} beforeSend`);
    const options = sentry.init.mock.calls.at(-1)?.[0];
    expect(options).toMatchObject({ enableLogs: false, enableMetrics: false, sendDefaultPii: false, tracesSampleRate: 0 });
    expect(options).not.toHaveProperty("dataCollection");
    expect(options).not.toHaveProperty("integrations");
  });

  it("client configuration disables replay, tracing and default PII", async () => {
    await loadBeforeSend("client");
    expect(sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      tracesSampleRate: 0, replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0, sendDefaultPii: false,
    }));
    expect(sentry.init.mock.calls.at(-1)?.[0]).not.toHaveProperty("integrations");
  });

  it("both configurations stay inert without a DSN", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    vi.stubEnv("SENTRY_DSN", "");
    await import("../../../sentry.client.config");
    await import("../../../sentry.server.config");
    expect(sentry.init).not.toHaveBeenCalled();
  });
});

describe("#57 collector boundary does not echo rejected input", () => {
  it("returns a fixed safe response for hostile exceptions and never serializes them", async () => {
    const { telemetryFailure } = await import("./http");
    const response = telemetryFailure(new Proxy({}, {
      getOwnPropertyDescriptor() { throw Error(SECRETS.password); },
      getPrototypeOf() { throw Error(SECRETS.cookie); },
    }));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain(SECRETS.password);
    expect(body).not.toContain(SECRETS.cookie);
  });

  it("keeps an oversized batch response free of the submitted payload", async () => {
    const { readTelemetryJson, telemetryFailure, TELEMETRY_BODY_LIMIT } = await import("./http");
    const request = new Request("https://app.test/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SECRETS.text.repeat(Math.ceil(TELEMETRY_BODY_LIMIT / SECRETS.text.length) + 1) }),
    });
    let response: Response;
    try {
      await readTelemetryJson(request);
      throw Error("expected rejection");
    } catch (error) {
      response = telemetryFailure(error);
    }
    expect(response.status).toBe(413);
    const body = await response.text();
    expect(body).not.toContain(SECRETS.text);
  });
});

describe("#57 correlation identifiers survive sanitization only when well formed", () => {
  it("keeps valid UUIDs and rejects oversized, multiline or forged identifiers", () => {
    expect(sanitizeTelemetryContext({ requestId: REQUEST_ID, actionId: ACTION_ID, errorId: "50dc9a4d-3fdc-4f04-b5db-604b4d4c6b93" }))
      .toEqual({ requestId: REQUEST_ID, actionId: ACTION_ID, errorId: "50dc9a4d-3fdc-4f04-b5db-604b4d4c6b93" });
    for (const forged of [`${REQUEST_ID}\n${SECRETS.text}`, "a".repeat(5000), REQUEST_ID.replace("30dc", "zzzz"), `${REQUEST_ID} `]) {
      expect(validCorrelationId(forged)).toBe(false);
      expect(sanitizeTelemetryContext({ requestId: forged })).toEqual({});
    }
  });
});
