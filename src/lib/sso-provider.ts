import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ExternalIdentity, ExternalIdentityAdapter } from "@/lib/auth";

const assertionSchema = z.object({
  issuer: z.literal("lenkanban-test"), subject: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email().max(254), name: z.string().max(100).optional(),
  groups: z.array(z.string().min(1).max(100)).max(100), disabled: z.boolean(),
  audience: z.literal("lenkanban"), purpose: z.enum(["login", "link", "sync"]),
  localUserId: z.string().min(1).optional(), expiresAt: z.number().int(),
});
export type StubAssertion = z.infer<typeof assertionSchema>;

/** Test harness only. Never expose a signing endpoint or send the key to a browser. */
export function signStubAssertion(claims: StubAssertion, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export interface CorporateProvider extends ExternalIdentityAdapter {
  verify(assertion: string, purpose: StubAssertion["purpose"], localUserId?: string): Promise<ExternalIdentity | null>;
}

export function resolveCorporateProvider(): CorporateProvider | null {
  const secret = process.env.SSO_STUB_SECRET;
  if (process.env.NODE_ENV === "production" || process.env.SSO_TEST_MODE !== "1" ||
      process.env.SSO_PROVIDER !== "stub" || !secret || secret.length < 32) return null;
  const verify: CorporateProvider["verify"] = async (assertion, purpose, localUserId) => {
    try {
      if (assertion.length > 16000) return null;
      const parts = assertion.split(".");
      if (parts.length !== 2) return null;
      const expected = createHmac("sha256", secret).update(parts[0]).digest();
      const received = Buffer.from(parts[1], "base64url");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
      const parsed = assertionSchema.safeParse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
      if (!parsed.success) return null;
      const claims = parsed.data;
      const now = Date.now();
      if (claims.purpose !== purpose || claims.expiresAt <= now || claims.expiresAt > now + 60000 ||
          (purpose === "link" && claims.localUserId !== localUserId)) return null;
      return { ...claims, provider: "stub" };
    } catch { return null; }
  };
  return {
    id: "stub", verify,
    authenticate: request => verify(request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "", "login"),
  };
}

/** Groups control corporate admission only; they never grant application roles. */
export function corporateAdmission(identity: ExternalIdentity): boolean {
  const allowed = (process.env.SSO_ALLOWED_GROUPS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  return identity.disabled !== true && allowed.length > 0 && allowed.some(group => identity.groups?.includes(group));
}
