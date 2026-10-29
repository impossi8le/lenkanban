import { resolveCorporateProvider } from "@/lib/sso-provider";
import { applyCorporateIdentity } from "@/lib/sso";
import { rateLimitOrThrow } from "@/lib/rate-limit";

/** Provider-authenticated status update, including disabled/deleted directory subjects. */
export async function POST(request: Request) {
  try {
    await rateLimitOrThrow(request, "auth:login");
    const assertion = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
    const identity = await resolveCorporateProvider()?.verify(assertion, "sync");
    if (!identity) return Response.json({ error: "Unauthorized" }, { status: 401 });
    await applyCorporateIdentity(identity, "sync");
    return Response.json({ success: true });
  } catch { return Response.json({ error: "Sync unavailable" }, { status: 503 }); }
}
