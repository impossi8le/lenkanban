import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createMcpServer, type ServerOptions } from "./server";

/** Local HTTP entry; TLS termination and deployment belong to the host. */
export function createMcpHttpServer(options: ServerOptions) {
  const mcp = createMcpServer(options);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
        else if (value !== undefined) headers.set(key, value);
      }
      // The Host header cannot redirect routing or manufacture an origin.
      const target = incoming.url ?? "/";
      if (!target.startsWith("/") || target.startsWith("//")) {
        outgoing.writeHead(400).end(); return;
      }
      const method = incoming.method ?? "GET";
      const init: RequestInit & { duplex?: "half" } = { method, headers };
      if (method !== "GET" && method !== "HEAD") {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      const response = await mcp.handle(new Request(`http://localhost${target}`, init));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      // Never send raw request/exception data to a fallback sink.
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.setTimeout(30_000, socket => socket.destroy());
  return server;
}
