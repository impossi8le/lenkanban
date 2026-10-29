import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { API_TOKEN_SCOPES, generateApiToken } from "@/lib/api-tokens";
import { rateLimitErrorResponse, rateLimitOrThrow } from "@/lib/rate-limit";
import { apiSuccess } from "@/lib/api-response";
import { ValidationError } from '@/lib/errors';
import { organizationJson } from '@/lib/organization-api';
import { tokenApi } from './token-api';

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).optional(),
  expiresAt: z.string().datetime({ offset: true })
    .refine(value => Date.parse(value) > Date.now(), "Expiry must be in the future").optional(),
}).strict();

export function GET(request: Request) {
  return tokenApi(request, '/api/tokens', async userId => {
    const items = await prisma.apiToken.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
        scopes: true,
        expiresAt: true,
      },
    });

    return apiSuccess({ items });
  });
}

export function POST(request: Request) {
  return tokenApi(request, '/api/tokens', async userId => {
    try {
      await rateLimitOrThrow(request, "tokens:create");
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "status" in e && (e as { status: number }).status === 429) {
        return rateLimitErrorResponse(e);
      }
      throw e;
    }

    const parsed = createSchema.safeParse(await organizationJson(request));
    if (!parsed.success) {
      throw new ValidationError();
    }

    const { token, hash, scopes, expiresAt } = generateApiToken({
      scopes: parsed.data.scopes,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });

    const created = await prisma.apiToken.create({
      data: {
        userId,
        name: parsed.data.name,
        tokenHash: hash,
        scopes,
        expiresAt,
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
      },
    });

    // Return plaintext token ONLY ONCE.
    return apiSuccess(
      {
        ...created,
        token,
      },
      undefined,
      201
    );
  }, true);
}
