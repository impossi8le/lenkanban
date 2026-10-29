import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  lines: [] as Record<string, unknown>[],
  fail: false
}));
vi.mock("pino", async (importOriginal) => {
  const actual = await importOriginal<{
    default: typeof import("pino");
  }>();
  return {
    default: (config: Parameters<typeof actual.default>[0]) => actual.default(config, {
      write(chunk: string) {
        if (state.fail) {
          throw Error("sink");
        }
        state.lines.push(JSON.parse(chunk));
      }
    })
  };
});
import logger, { apiLogger, logAuthEvent, logEmail } from "./logger";
beforeEach(() => {
  state.lines.length = 0;
  state.fail = false;
});
it("protects actual Pino root and child sinks, including error messages and free-form msg", () => {
  const secret = "private@example.invalid";
  logger.error({
    err: new Error(secret),
    password: secret,
    nested: [{
      token: secret
    }]
  }, secret);
  apiLogger.info({
    method: "POST",
    event: "api.request.completed",
    email: secret,
    route: "/api/tasks/:id"
  }, secret);
  logAuthEvent("login", "actor-1", secret, false, Error(secret));
  logEmail(secret, secret, false, Error(secret));
  expect(state.lines).toHaveLength(4);
  expect(JSON.stringify(state.lines)).not.toContain(secret);
  expect(state.lines[1]).toMatchObject({
    module: "api",
    event: "api.request.completed",
    route: "/api/tasks/:id"
  });
});
it("never changes business control flow or leaks through console when sink fails", () => {
  state.fail = true;
  const log = vi.spyOn(console, "log");
  const error = vi.spyOn(console, "error");
  expect(() => logger.error({
    err: Error("private")
  }, "private")).not.toThrow();
  expect(() => logAuthEvent("login", "actor-1", "private", false)).not.toThrow();
  expect(() => logEmail("private", "private", false)).not.toThrow();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
it("sanitizes child bindings and retains stable categories for known legacy messages", () => {
  logger.child({
    email: "private@example.invalid",
    token: "private",
    module: "socket"
  }).warn("Session API timeout");
  expect(state.lines[0]).toMatchObject({
    module: "socket",
    event: "socket.session.timeout"
  });
  expect(JSON.stringify(state.lines)).not.toContain("private");
});
it("never lets hostile descriptor/prototype traps escape a logging call", () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw Error("private");
    },
    getOwnPropertyDescriptor() {
      throw Error("private");
    }
  });
  expect(() => logger.error({
    err: hostile
  }, "private")).not.toThrow();
  expect(() => logger.info(hostile)).not.toThrow();
  expect(JSON.stringify(state.lines)).not.toContain("private");
});
