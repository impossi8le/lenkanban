import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  consumeRateLimit,
  getClientIpFromHeaders,
  rateLimitErrorResponse,
} from "@/lib/rate-limit";
import { generateToken, sendVerificationEmail } from "@/lib/email";
import { logAuthEvent } from "@/lib/logger";
import {
  apiSuccess,
  apiInvalidJson,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const schema = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
});

/** Local admission rule; kept in this route so the shared rule table is untouched. */
const RESEND_LIMIT = { limit: 5, windowMs: 60_000 };

export async function POST(req: Request) {
  try {
    await consumeRateLimit({
      key: `auth:resend-verification:${getClientIpFromHeaders(req.headers)}`,
      ...RESEND_LIMIT,
    });
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "status" in e && (e as { status: number }).status === 429) {
      return rateLimitErrorResponse(e);
    }
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

  const { email } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
    },
  });

  // Don't reveal if email exists or not (security). An already-verified address
  // gets the same response as an unknown one.
  if (!user || user.emailVerified) {
    return apiSuccess({
      message: "Если email существует, письмо было отправлено",
    });
  }

  // Generate new token
  const token = generateToken();
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationToken: token,
      verificationTokenExpiry: expiry,
    },
  });

  // Send email
  try {
    await sendVerificationEmail(user.email, token, user.name);
  } catch (error) {
    logAuthEvent("verify", user.id, user.email, false, error instanceof Error ? error : undefined);
    return apiInternalError("Не удалось отправить письмо");
  }

  return apiSuccess({
    message: "Письмо с подтверждением отправлено",
  });
}
