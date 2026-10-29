import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { init } = vi.hoisted(() => ({
  init: vi.fn()
}));
vi.mock("@sentry/nextjs", () => ({
  init
}));
beforeEach(() => {
  vi.resetModules();
  init.mockReset();
  vi.stubEnv("SENTRY_DSN", "https://test@example.invalid/1");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://test@example.invalid/1");
});
afterEach(() => vi.unstubAllEnvs());
it.each(["server", "client"])("applies shared safe event boundary in %s config without Replay/tracing", async (side) => {
  if (side === "server") {
    await import("./sentry.server.config");
  }
  else {
    await import("./sentry.client.config");
  }
  const config = init.mock.calls.at(-1)![0];
  const requestId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
  const safe = config.beforeSend({
    message: "private",
    request: {
      url: "/?token=private",
      headers: {
        Authorization: "private"
      }
    },
    extra: {
      requestId,
      password: "private"
    },
    breadcrumbs: [{
      data: {
        nested: {
          token: "private"
        }
      }
    }]
  }, {});
  expect(JSON.stringify(safe)).not.toContain("private");
  expect(safe.extra).toEqual({
    requestId
  });
  expect(config.tracesSampleRate).toBe(0);
  expect(config.sendDefaultPii).toBe(false);
  expect(config.enableLogs).toBe(false);
  expect(config.enableMetrics).toBe(false);
  expect(config).not.toHaveProperty("dataCollection");
  expect(config.integrations).toBeUndefined();
  if (side === "client") {
    expect(config.replaysSessionSampleRate).toBe(0);
    expect(config.replaysOnErrorSampleRate).toBe(0);
  }
});
it("does not initialize an external sink without DSN", async () => {
  vi.stubEnv("SENTRY_DSN", "");
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
  await import("./sentry.server.config");
  await import("./sentry.client.config");
  expect(init).not.toHaveBeenCalled();
});
