import { createMcpHttpServer } from "./http";
import { createRemotePort } from "./remote-port";
import { runtimeConfig } from "./config";
import { apiLogger } from "@/lib/logger";

// Production and local standalone runs both use HTTPS, never application imports/DB.
try {
  const config = runtimeConfig(process.env);
  const server = createMcpHttpServer({ port: createRemotePort(config.origin), allowedOrigins: config.allowedOrigins });
  const failed = () => {
    apiLogger.error({ event: "api.request.failed", errorCode: "DEPENDENCY_UNAVAILABLE", route: "/mcp" });
    process.exitCode = 1;
  };
  server.on("error", failed);
  server.listen(config.port, config.host);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => { server.closeAllConnections(); process.exitCode = 1; }, 30_000);
    timer.unref();
    server.close(() => clearTimeout(timer));
  });
} catch {
  apiLogger.error({ event: "api.request.failed", errorCode: "DEPENDENCY_UNAVAILABLE", route: "/mcp" });
  process.exitCode = 1;
}
