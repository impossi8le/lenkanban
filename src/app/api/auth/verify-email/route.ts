import { prisma } from "@/lib/prisma";
import { logAuthEvent } from "@/lib/logger";
import {
  apiSuccess,
  apiError,
  apiInternalError
} from "@/lib/api-response";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get("token");

    if (!token) {
      return apiError("TOKEN_MISSING", "Токен не указан", undefined, 400);
    }

    const user = await prisma.user.findUnique({
      where: { verificationToken: token },
      select: {
        id: true,
        email: true,
        verificationTokenExpiry: true,
        emailVerified: true,
      },
    });

    if (!user) {
      return apiError("INVALID_TOKEN", "Неверный или устаревший токен. Если вы уже подтвердили email, просто войдите в систему.", undefined, 400);
    }

    // If already verified, return success (user might be clicking the link again)
    if (user.emailVerified) {
      logAuthEvent("verify", user.id, user.email, true);
      return apiSuccess({
        message: "Email уже подтвержден",
        email: user.email,
        alreadyVerified: true,
      });
    }

    if (!user.verificationTokenExpiry || user.verificationTokenExpiry < new Date()) {
      return apiError("TOKEN_EXPIRED", "Срок действия токена истек. Запросите новое письмо для подтверждения.", undefined, 400);
    }

    // Mark email as verified
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: new Date(),
        verificationToken: null,
        verificationTokenExpiry: null,
      },
    });

    logAuthEvent("verify", user.id, user.email, true);

    return apiSuccess({
      message: "Email успешно подтвержден",
      email: user.email,
      alreadyVerified: false,
    });
  } catch (error) {
    logAuthEvent("verify", undefined, undefined, false, error instanceof Error ? error : undefined);
    return apiInternalError("Не удалось подтвердить email");
  }
}
