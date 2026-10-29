import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

type Rule = {
  key: string;
  limit: number;
  windowMs: number;
};

const DEFAULTS: Record<string, Omit<Rule, "key">> = {
  // auth endpoints
  "auth:register": { limit: 10, windowMs: 60_000 }, // 10/min per IP
  "auth:login": { limit: 20, windowMs: 60_000 }, // 20/min per IP
  "auth:forgot-password": { limit: 5, windowMs: 60_000 }, // 5/min per IP
  "auth:reset-password": { limit: 5, windowMs: 60_000 }, // 5/min per IP

  // tokens
  "tokens:create": { limit: 10, windowMs: 60_000 }, // 10/min per IP

  // tasks
  "tasks:list": { limit: 120, windowMs: 60_000 }, // 120/min per user, across list/search filters
  "tasks:create": { limit: 60, windowMs: 60_000 }, // 60/min per user
  "tasks:update": { limit: 120, windowMs: 60_000 }, // 120/min per user
  "tasks:delete": { limit: 30, windowMs: 60_000 }, // 30/min per user
  "tasks:bulk": { limit: 20, windowMs: 60_000 }, // 20/min per user

  // projects
  "projects:create": { limit: 10, windowMs: 60_000 }, // 10/min per user
  "projects:update": { limit: 30, windowMs: 60_000 }, // 30/min per user
  "projects:delete": { limit: 10, windowMs: 60_000 }, // 10/min per user

  // uploads
  "uploads:presign": { limit: 30, windowMs: 60_000 }, // 30/min per user

  // messages
  "messages:send": { limit: 60, windowMs: 60_000 }, // 60/min per user

  // notifications
  "notifications:create": { limit: 100, windowMs: 60_000 }, // 100/min per user

  "telemetry:actor": { limit: 60, windowMs: 60_000 },
  "telemetry:global": { limit: 600, windowMs: 60_000 },
};

function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  // Fetch Headers
  if (typeof headers === "object" && headers !== null && "get" in headers && typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  // Node/NextApiRequest style
  if (typeof headers === "object" && headers !== null) {
    const h = headers as Record<string, unknown>;
    const v = h[name.toLowerCase()];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return null;
}

export function getClientIpFromHeaders(headers: unknown) {
  const xff = getHeader(headers, "x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return getHeader(headers, "x-real-ip") ?? "unknown";
}

export interface RateLimitDatabase {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** One conditional PostgreSQL upsert is the shared admission decision. */
export async function consumeRateLimit({
  database = prisma,
  key,
  limit,
  windowMs,
  now = new Date(),
}: {
  database?: RateLimitDatabase;
  key: string;
  limit: number;
  windowMs: number;
  now?: Date;
}): Promise<void> {
  if (!key || !Number.isSafeInteger(limit) || limit < 1
    || !Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid rate limit configuration");
  }
  const expiredBefore = new Date(now.getTime() - windowMs);
  const admitted = await database.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "count", "windowStart")
    VALUES (${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimit"."windowStart" <= ${expiredBefore} THEN 1
        ELSE "RateLimit"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "RateLimit"."windowStart" <= ${expiredBefore} THEN ${now}
        ELSE "RateLimit"."windowStart"
      END
    WHERE "RateLimit"."windowStart" <= ${expiredBefore}
       OR "RateLimit"."count" < ${limit}
    RETURNING "count"
  `;
  if (admitted.length === 0) {
    // A conservative full-window Retry-After avoids a second racy read. Rejected
    // requests never increment the count and the first admitted reset counts 1.
    throw Object.assign(new Error("RateLimited"), {
      status: 429,
      retryAfterSec: Math.ceil(windowMs / 1000),
    });
  }
}

export async function rateLimitOrThrowKey(name: keyof typeof DEFAULTS, keySuffix: string) {
  const cfg = DEFAULTS[name];
  if (!cfg) throw new Error("Unknown rate limit rule");
  await consumeRateLimit({
    key: `${name}:${keySuffix}`,
    limit: cfg.limit,
    windowMs: cfg.windowMs,
  });
}
export async function rateLimitOrThrow(req: Request, name: keyof typeof DEFAULTS) {
  const ip = getClientIpFromHeaders(req.headers);
  return rateLimitOrThrowKey(name, ip);
}

export function rateLimitErrorResponse(e: unknown) {
  const retryAfter =
    typeof e === "object" &&
    e !== null &&
    "retryAfterSec" in e &&
    typeof (e as { retryAfterSec: unknown }).retryAfterSec === "number"
      ? (e as { retryAfterSec: number }).retryAfterSec
      : 60;
  return NextResponse.json(
    { error: "RateLimited", retryAfter },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
      },
    }
  );
}
