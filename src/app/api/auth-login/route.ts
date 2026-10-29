import { normalizeLogin } from "@/lib/login-identity";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getClientIpFromHeaders, rateLimitErrorResponse, rateLimitOrThrowKey } from "@/lib/rate-limit";
import { apiInvalidJson, apiValidationError } from "@/lib/api-response";

const schema = z.object({
  email: z.string().transform(normalizeLogin).refine(Boolean, "Некорректный логин"),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  try {
    // Validation preflight and actual authorize are separate requests. Reuse
    // the existing 20/min rule with an independent IP bucket, so one form submit
    // does not consume the real authentication IP budget twice.
    await rateLimitOrThrowKey("auth:login", `preflight:${getClientIpFromHeaders(req.headers)}`);
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "status" in e && (e as { status: number }).status === 429) {
      return rateLimitErrorResponse(e);
    }
    // fail-open on rate limiter errors
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiInvalidJson();
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  // Preflight only (rate limit + validation). Actual auth remains in NextAuth.
  return NextResponse.json({ ok: true });
}
