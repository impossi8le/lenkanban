import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireDbUser } from "@/lib/require-user";
import { hashApiToken, parseApiToken, type ApiTokenScope } from "@/lib/api-tokens";
import { UnauthorizedError, ForbiddenError } from "@/lib/errors";
import { isAccountAllowed } from "@/lib/auth";
import { readTelemetryJson } from "@/lib/telemetry/http";

export async function getApiUser(request: Request | NextRequest, requiredScopes?: readonly ApiTokenScope[]) {
  const auth = request.headers.get("authorization") || request.headers.get("Authorization");

  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const parsed = parseApiToken(token);
    if (!parsed) return null;

    const tokenHash = hashApiToken(token);

    const row = await prisma.apiToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return null;

    // A bearer token must not outlive the account it belongs to. The status read
    // is the same fail-closed check used by cookie sessions.
    if (!(await isAccountAllowed(row.user.id))) return null;

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      // Deliberate tightening: legacy tokens with no scopes are read-only.
      // Unknown mutation routes fail closed even when a token has other scopes.
      const scopes = requiredScopes ?? await defaultMutationScopes(request);
      if (scopes.length === 0 || scopes.some(scope => !(row.scopes ?? []).includes(scope))) {
        throw new ForbiddenError("API token scope required");
      }
    }

    // best-effort lastUsedAt
    prisma.apiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return row.user;
  }

  // Fallback to NextAuth session cookie (browser). The request object scopes the
  // session read to this HTTP request, so several guards in one handler read the
  // account from the database once.
  try {
    return await requireDbUser(request);
  } catch {
    return null;
  }
}

// Re-export UnauthorizedError for backward compatibility
export { UnauthorizedError } from "@/lib/errors";

export async function requireApiUser(request: Request | NextRequest, requiredScopes?: readonly ApiTokenScope[]) {
  const user = await getApiUser(request, requiredScopes);
  if (!user) throw new UnauthorizedError();
  return user;
}

async function defaultMutationScopes(request: Request): Promise<readonly ApiTokenScope[]> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path === "/api/projects" || /^\/api\/project-templates\/[^/]+\/use$/.test(path)) return ["board.create"];
  if (path === "/api/tasks" && request.method === "POST") return ["request.create"];
  if (/^\/api\/tasks\/[^/]+\/move$/.test(path)) return ["request.move"];
  if (/^\/api\/tasks\/[^/]+\/messages(?:\/|$)/.test(path)) return ["request.comment"];
  if (path === "/api/tasks/bulk" || (/^\/api\/tasks\/[^/]+$/.test(path) && request.method === "PATCH")) {
    // Legacy PATCH may combine relocation and scalar edits. Never let update
    // alone authorize a move hidden in the same payload. Consumed bodies need
    // explicit scopes from their handler; the fallback requires both.
    if (request.bodyUsed) return ["request.update", "request.move"];
    if (!request.body) return ["request.update"];
    let json: unknown;
    try { json = await readTelemetryJson(request.clone(), { maxBytes: 256 * 1024, requireJsonContentType: false }); }
    catch { throw new ForbiddenError("Cannot determine API token scopes"); }
    const record = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
    const fields = path === "/api/tasks/bulk" && record.updates && typeof record.updates === "object"
      ? record.updates as Record<string, unknown> : record;
    const moveKeys = ["columnId", "status", "position"];
    const scalarKeys = ["title", "description", "priority", "deadline", "changes"];
    const moving = moveKeys.some(key => Object.hasOwn(fields, key));
    const updating = scalarKeys.some(key => Object.hasOwn(fields, key));
    return moving ? updating ? ["request.move", "request.update"] : ["request.move"] : ["request.update"];
  }
  if (/^\/api\/tasks\/[^/]+$/.test(path) && request.method === "POST") return ["request.move"];
  if (path.startsWith("/api/tasks/")) return ["request.update"];
  return [];
}
