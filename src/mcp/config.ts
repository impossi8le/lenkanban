import { upstreamOrigin } from "./remote-port";

export function runtimeConfig(env: Readonly<Record<string, string | undefined>>) {
  // This entry point never needs application DB credentials, even for development.
  if (["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL", "POSTGRES_URL", "PRISMA_DATABASE_URL"]
    .some(key => Boolean(env[key]))) throw new Error("Database credentials are forbidden in the MCP process");
  const port = Number(env.MCP_PORT ?? "18765");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP port");
  const host = env.MCP_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host)) throw new Error("Invalid MCP host");
  const allowedOrigins = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  for (const value of allowedOrigins) {
    if (upstreamOrigin(value) !== value) throw new Error("Invalid allowed origin");
  }
  return { port, host, allowedOrigins, origin: upstreamOrigin(env.MCP_UPSTREAM_ORIGIN ?? "") };
}
