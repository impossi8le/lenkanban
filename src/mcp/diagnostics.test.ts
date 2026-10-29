import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./server";
import type { CanonicalPort } from "./adapter";

const sink = vi.hoisted(() => ({
  lines: [] as Record<string, unknown>[],
  attempts: 0,
  failPino: false,
  failSentry: false,
  extras: vi.fn(), user: vi.fn(), capture: vi.fn(), scope: vi.fn(),
}));
vi.mock("pino", async importOriginal => {
  const actual = await importOriginal<{ default: typeof import("pino") }>();
  return { default: (config: Parameters<typeof actual.default>[0]) => actual.default(config, {
    write(chunk: string) {
      sink.attempts++;
      if (sink.failPino) throw new Error("broken Pino sink");
      sink.lines.push(JSON.parse(chunk));
    },
  }) };
});
vi.mock("@sentry/nextjs", () => ({
  withScope: sink.scope,
  captureException: sink.capture,
}));

const secret = "synthetic-private-content@example.invalid";
const token = `kb2_0123456789ab_${"s".repeat(43)}`;

beforeEach(() => {
  vi.clearAllMocks();
  sink.lines.length = 0;
  sink.attempts = 0;
  sink.failPino = false;
  sink.failSentry = false;
  sink.scope.mockImplementation((callback: (scope: unknown) => void) => {
    callback({ setExtras: sink.extras, setUser: sink.user });
  });
  sink.capture.mockImplementation(() => {
    if (sink.failSentry) throw new Error("broken Sentry sink");
  });
});

function exceptionShapes(): [string, () => unknown][] {
  return [
    ["nested Error", () => Object.assign(new Error(secret, { cause: new Error(token) }), {
      body: { authorization: token, contentText: secret },
    })],
    ["cyclic object", () => {
      const value: Record<string, unknown> = { password: token, description: secret };
      value.self = value;
      return value;
    }],
    ["array", () => [secret, { nested: [token, new Error(secret)] }]],
    ["nonstandard object", () => Object.assign(Object.create(null), { rawBody: secret, headers: { authorization: token } })],
    ["primitive", () => `${secret}:${token}`],
    ["mixed-case headers and repeated encoded query", () => ({
      HeAdErS: { AuThOrIzAtIoN: token, CoOkIe: secret },
      url: `https://example.invalid/?q=${encodeURIComponent(secret)}&q=${encodeURIComponent(token)}`,
      cause: { fallback: [{ PASSWORD: token, fileName: secret }] },
    })],
  ];
}

async function invoke(error: unknown) {
  const port: CanonicalPort = {
    authenticate: vi.fn().mockResolvedValue({ id: "actor", globalRole: "USER" }),
    projectAccess: vi.fn().mockResolvedValue({ canRead: true }),
    request: vi.fn().mockRejectedValue(error),
  };
  const server = createMcpServer({ port });
  const response = await server.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "update_task", arguments: { taskId: "task", operationId: "12345678-1234-4234-8234-123456789abc",
        expectedVersion: 0, changes: { title: secret } },
    } }),
  }));
  return { status: response.status, body: await response.json(), port };
}

function actualDiagnostics() {
  return {
    pino: sink.lines,
    extras: sink.extras.mock.calls,
    user: sink.user.mock.calls,
    errors: sink.capture.mock.calls.map(call => {
      const error = call[0] as Error;
      return { message: error.message, stack: error.stack, cause: error.cause,
        properties: Object.getOwnPropertyNames(error).map(key => [key, Reflect.get(error, key)]),
      };
    }),
  };
}

describe("N22 default MCP diagnostics through real shared Pino and Sentry boundaries", () => {
  it.each(exceptionShapes())("does not leak %s failures, input, or Bearer tokens", async (_name, makeError) => {
    const { status, body, port } = await invoke(makeError());
    expect(status).toBe(200);
    expect(body.result).toMatchObject({ isError: true, structuredContent: {
      schemaVersion: 1, error: { code: "INTERNAL_ERROR", message: "Запрос отклонён сервером Ленканбана." },
    } });
    expect(port.request).toHaveBeenCalledTimes(1);
    expect(sink.attempts).toBe(1);
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatchObject({ module: "api", event: "api.request.failed",
      route: "/mcp", method: "POST", statusCode: 500, errorCode: "INTERNAL_ERROR" });
    const context = vi.mocked(port.request).mock.calls[0][1];
    expect(sink.lines[0]).toMatchObject({ requestId: context.requestId, actionId: context.actionId });
    expect(sink.scope).toHaveBeenCalledTimes(1);
    expect(sink.capture).toHaveBeenCalledTimes(1);
    expect(sink.capture.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(sink.capture.mock.calls[0][0].message).toBe("MCP operation failed");
    expect(sink.extras).toHaveBeenCalledWith(expect.objectContaining({ route: "/mcp", errorCode: "INTERNAL_ERROR" }));
    expect(sink.extras).toHaveBeenCalledWith(expect.objectContaining({ requestId: context.requestId, actionId: context.actionId }));
    const serialized = JSON.stringify({ body, diagnostics: actualDiagnostics() });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("changes");
    expect(serialized).not.toContain("authorization");
  });

  it("preserves the safe response when both actual sinks fail and never falls back to console", async () => {
    sink.failPino = true;
    sink.failSentry = true;
    const spies = ["log", "error", "warn", "info", "debug"].map(method =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    try {
      const { status, body } = await invoke(new Error(`${secret}:${token}`));
      expect(status).toBe(200);
      expect(body.result).toMatchObject({ isError: true, structuredContent: { error: { code: "INTERNAL_ERROR" } } });
      expect(sink.attempts).toBe(1);
      expect(sink.lines).toHaveLength(0);
      expect(sink.capture).toHaveBeenCalledTimes(1);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const serialized = JSON.stringify({ body, diagnostics: actualDiagnostics() });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(token);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
