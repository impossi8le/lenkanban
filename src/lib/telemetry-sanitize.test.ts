import { describe, expect, it } from "vitest";
import { safeError, sanitizeSentryEvent, sanitizeTelemetryContext, validCorrelationId } from "./telemetry-sanitize";
const requestId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
describe("safe telemetry boundary", () => {
  it("accepts only closed duration kinds and finite bounded handler intervals", () => {
    expect(sanitizeTelemetryContext({ durationKind: "http", handlerDurationMs: 12, method: "OTHER" })).toEqual({ durationKind: "http", handlerDurationMs: 12, method: "OTHER" });
    expect(sanitizeTelemetryContext({ durationKind: "handler", handlerDurationMs: 0 })).toEqual({ durationKind: "handler", handlerDurationMs: 0 });
    for (const handlerDurationMs of [-1, Infinity, NaN, 86400001, "PRIVATE"]) expect(sanitizeTelemetryContext({ durationKind: "PRIVATE", handlerDurationMs })).toEqual({});
  });
  it("retains bounded diagnostic fields and excludes raw payload, nested secrets and errors", () => {
    const secret = "private-password@example.invalid";
    const data: Record<string, unknown> = {
      requestId,
      actorId: "actor-1",
      route: "/api/tasks/:id",
      method: "PATCH",
      statusCode: 409,
      durationMs: 0,
      event: "api.request.completed",
      password: secret,
      data: [{
        TOKEN: secret
      }],
      err: new Error(secret),
      msg: secret,
      email: secret
    };
    data.circular = data;
    const safe = sanitizeTelemetryContext(data);
    expect(safe).toMatchObject({
      requestId,
      actorId: "actor-1",
      route: "/api/tasks/:id",
      durationMs: 0,
      err: {
        type: "Error",
        message: "Application error"
      }
    });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe).not.toHaveProperty("data");
  });
  it("never invokes getters, stringification or traverses arbitrarily nested data", () => {
    const getter = {
      get requestId() {
        throw Error("private");
      },
      toJSON() {
        throw Error("private");
      },
      data: {
        password: "private"
      }
    };
    expect(sanitizeTelemetryContext(getter)).toEqual({});
    expect(sanitizeTelemetryContext(new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw Error("private");
      }
    }))).toEqual({});
    expect(sanitizeTelemetryContext({
      err: {
        toString() {
          throw Error("private");
        }
      }
    })).toEqual({
      err: {
        type: "UnknownError",
        message: "Application error"
      }
    });
    expect(sanitizeSentryEvent(new Proxy({}, {
      get() {
        throw Error("private");
      }
    }))).toEqual({});
  });
  it.each([null, "not-a-uuid", requestId + "\nprivate", "a".repeat(10000)])("rejects malformed correlation IDs", (id) => {
    expect(validCorrelationId(id)).toBe(false);
    expect(sanitizeTelemetryContext({
      requestId: id
    })).toEqual({});
  });
  it("rejects nonfinite numbers, URLs, query/hash, email IDs and oversized labels", () => {
    expect(sanitizeTelemetryContext({
      durationMs: Infinity,
      statusCode: -1,
      route: "/api/tasks?token=private",
      userId: "a@example.invalid",
      event: "a".repeat(81),
      revision: "private-branch"
    })).toEqual({});
    expect(validCorrelationId(requestId)).toBe(true);
  });
  it("retains built-in error type and bounded source coordinates without raw stack/message", () => {
    const error = new TypeError("private");
    error.stack = "TypeError: private\n    at operation (C:/private/folder/route.ts:42:9)\n    at https://api.invalid?token=private\n";
    expect(safeError(error)).toEqual({
      type: "TypeError",
      message: "Application error",
      frames: [{
        filename: "route.ts",
        lineno: 42,
        colno: 9
      }]
    });
  });
  it("preserves breadcrumb ordering metadata without copying free-form context", () => {
    const event = sanitizeSentryEvent({
      breadcrumbs: [{
        timestamp: 123,
        seq: 2,
        message: "private",
        data: {
          event: "ui.action",
          seq: 1
        }
      }, {
        timestamp: NaN,
        seq: -1
      }]
    });
    expect(event.breadcrumbs).toEqual([{
      category: "application",
      timestamp: 123,
      data: {
        event: "ui.action",
        seq: 2
      }
    }, {
      category: "application",
      data: {}
    }]);
  });
  it("never interprets multiline error-message text as source frames", () => {
    const err = Error("private\n    at C:/TOKEN_SECRET.ts:1:2");
    const safe = safeError(err);
    expect(JSON.stringify(safe)).not.toContain("TOKEN_SECRET");
    expect(JSON.stringify(safe)).not.toContain("private");
  });
  it("uses the same boundary for Sentry extras, breadcrumbs, request, exception and user", () => {
    const secret = "private-token@example.invalid";
    const source = {
      event_id: "abc123",
      level: "error",
      request: {
        url: "/task?%54OKEN=" + secret,
        headers: {
          Authorization: secret
        },
        data: secret
      },
      message: secret,
      user: {
        id: "actor-1",
        email: secret
      },
      extra: {
        requestId,
        token: secret,
        nested: [{
          password: secret
        }]
      },
      contexts: {
        secret
      },
      breadcrumbs: [{
        message: secret,
        data: {
          actionId: requestId,
          password: secret
        }
      }],
      exception: {
        values: [{
          value: secret,
          stacktrace: {
            frames: [{
              in_app: true,
              filename: "C:/private-path/route.ts?token=" + secret,
              lineno: 23,
              colno: 4,
              vars: {
                secret
              },
              pre_context: [secret]
            }, {
              filename: secret,
              lineno: 1
            }]
          }
        }]
      }
    };
    const safe = sanitizeSentryEvent(source);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe).not.toHaveProperty("request");
    expect(safe.extra).toEqual({
      requestId
    });
    expect(safe.user).toEqual({
      id: "actor-1"
    });
    expect(safe.exception).toEqual({
      values: [{
        type: "Error",
        value: "Application error",
        stacktrace: {
          frames: [{
            in_app: true,
            filename: "route.ts",
            lineno: 23,
            colno: 4
          }]
        }
      }]
    });
    expect(source.request.headers.Authorization).toBe(secret);
  });
});
