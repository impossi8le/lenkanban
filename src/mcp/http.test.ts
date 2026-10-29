import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createMcpHttpServer } from "./http";

const servers: ReturnType<typeof createMcpHttpServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function host() {
  const port = { authenticate: vi.fn().mockResolvedValue({ id: "actor", globalRole: "USER" }),
    projectAccess: vi.fn().mockResolvedValue({ canRead: true }), request: vi.fn() };
  const server = createMcpHttpServer({ port, diagnose: vi.fn() });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, port, server };
}

const headers = { authorization: `Bearer kb2_123456789abc_${"a".repeat(43)}`,
  "content-type": "application/json", accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18" };

describe("local Streamable HTTP entry (mock canonical services; real TCP)", () => {
  it("serves health, rejects anonymous discovery and initializes an authenticated client", async () => {
    const h = await host();
    const health = await fetch(`${h.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "degraded", version: "0.1.0" });
    const anonymous = await fetch(`${h.url}/mcp`, { method: "POST", body: "{}" });
    expect(anonymous.status).toBe(401);
    expect(h.port.authenticate).not.toHaveBeenCalled();
    const response = await fetch(`${h.url}/mcp`, { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "initialize", params: { protocolVersion: "2025-06-18" } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 42, result: { protocolVersion: "2025-06-18" } });
    expect(h.port.authenticate).toHaveBeenCalledTimes(1);
    expect(h.server.requestTimeout).toBe(30_000);
  });

  it("streams bodies into the existing size limit and rejects unapproved origins", async () => {
    const h = await host();
    const large = await fetch(`${h.url}/mcp`, { method: "POST", headers, body: "x".repeat(67 * 1024) });
    expect(large.status).toBe(413);
    const rejected = await fetch(`${h.url}/mcp`, { method: "POST", headers: { ...headers, origin: "https://foreign.invalid" }, body: "{}" });
    expect(rejected.status).toBe(403);
    expect(h.port.request).not.toHaveBeenCalled();
  });
});
