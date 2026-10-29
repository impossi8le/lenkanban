import { requireDbUser } from "@/lib/require-user";
import { resolveCorporateProvider } from "@/lib/sso-provider";
import { applyCorporateIdentity } from "@/lib/sso";
import { rateLimitOrThrow } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    if (!process.env.NEXTAUTH_URL || request.headers.get("origin") !== new URL(process.env.NEXTAUTH_URL).origin)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    await rateLimitOrThrow(request, "auth:login");
    const user = await requireDbUser(request);
    const body = await request.json();
    if (typeof body?.assertion !== "string" || typeof body?.password !== "string" || body.password.length > 200)
      return Response.json({ error: "Invalid request" }, { status: 400 });
    const identity = await resolveCorporateProvider()?.verify(body.assertion, "link", user.id);
    const result = identity && await applyCorporateIdentity(identity, "link", { userId: user.id, password: body.password });
    return Response.json({ success: !!result }, { status: result ? 200 : 403 });
  } catch { return Response.json({ error: "Link rejected" }, { status: 403 }); }
}
