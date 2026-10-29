import { z } from "zod";

/**
 * Opaque keyset cursor for ADMIN project listings.
 *
 * The client receives this string and sends it back unchanged; it never builds
 * or guesses an identifier. Ordering is fixed to (createdAt desc, id desc), so
 * the payload carries exactly those two values.
 */
const cursorPayloadSchema = z.object({
  createdAt: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => Number.isFinite(Date.parse(value)), {
      message: "Invalid createdAt",
    }),
  id: z.string().min(1).max(128),
});

export type AdminProjectsCursor = {
  createdAt: Date;
  id: string;
};

export function encodeProjectsCursor(row: { createdAt: Date; id: string }): string {
  const payload = JSON.stringify({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeProjectsCursor(value: string): AdminProjectsCursor | null {
  try {
    const raw = Buffer.from(value, "base64url").toString("utf8");
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const createdAt = new Date(parsed.data.createdAt);
    if (!Number.isFinite(createdAt.getTime())) return null;
    return { createdAt, id: parsed.data.id };
  } catch {
    return null;
  }
}

export function projectsKeysetFilter(cursor: AdminProjectsCursor) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}
