import { z } from "zod";
import bcrypt from "bcryptjs";

import { prisma } from "@/lib/prisma";
import { rateLimitErrorResponse, rateLimitOrThrow } from "@/lib/rate-limit";
import { generateToken, sendVerificationEmail } from "@/lib/email";
import {
  apiSuccess,
  apiError,
  apiInvalidJson,
  apiValidationError
} from "@/lib/api-response";
import { logAuthEvent } from "@/lib/logger";
import { isEmailVerificationRequired, isLocalRegistrationAllowed } from "@/lib/auth";

const schema = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(200).optional(),
});

/**
 * The response body is identical for a new address and for an address that is
 * already registered, so registration cannot be used to enumerate accounts.
 */
function registrationMessage(required: boolean): string {
  return required
    ? "Если адрес свободен, мы отправили письмо для подтверждения."
    : "Если адрес свободен, учётная запись создана. Можно войти с указанными данными.";
}

export async function POST(req: Request) {
  try {
    await rateLimitOrThrow(req, "auth:register");
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

  const { email, password, name } = parsed.data;
  const verificationRequired = isEmailVerificationRequired();
  const message = registrationMessage(verificationRequired);

  // Once the corporate provider is the only source of identities, self-service
  // local registration must not create accounts that bypass it.
  if (!isLocalRegistrationAllowed()) {
    return apiError(
      "REGISTRATION_DISABLED",
      "Самостоятельная регистрация отключена. Обратитесь к администратору.",
      undefined,
      403,
    );
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    logAuthEvent("register", existing.id, email, false);
    return apiSuccess({ message }, undefined, 201);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Generate verification token
  const verificationToken = verificationRequired ? generateToken() : null;
  const verificationTokenExpiry = verificationRequired
    ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;

  const user = await prisma.user.create({
    data: {
      email,
      name: name ?? null,
      passwordHash,
      avatarUrl: null,
      verificationToken,
      verificationTokenExpiry,
      emailVerified: verificationRequired ? null : new Date(),
      // Self-registration never grants administrative rights. The schema default
      // is USER; it is set explicitly so a future default change cannot escalate.
      globalRole: "USER",
    },
    select: { id: true, email: true, name: true },
  });

  // Send verification email
  if (verificationToken) {
    try {
      await sendVerificationEmail(user.email, verificationToken, user.name);
    } catch {
      // Don't fail registration if email fails - user can resend later
    }
  }
  logAuthEvent("register", user.id, user.email, true);

  return apiSuccess({ message }, undefined, 201);
}
