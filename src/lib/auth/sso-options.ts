import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { resolveCorporateProvider } from "@/lib/sso-provider";
import { applyCorporateIdentity } from "@/lib/sso";
import { getClientIpFromHeaders, rateLimitOrThrowKey } from "@/lib/rate-limit";

/** Compose at the HTTP boundary without changing the existing local/session contract. */
export function withCorporateProvider(options: NextAuthOptions): NextAuthOptions {
  return { ...options, providers: [...options.providers, CredentialsProvider({
    id: "corporate", name: "Corporate SSO", credentials: { assertion: { label: "Assertion", type: "password" } },
    async authorize(credentials, request) {
      try {
        await rateLimitOrThrowKey("auth:login", getClientIpFromHeaders(request.headers));
        const provider = resolveCorporateProvider();
        if (!provider || typeof credentials?.assertion !== "string") return null;
        const identity = await provider.verify(credentials.assertion, "login");
        if (!identity) return null;
        const user = await applyCorporateIdentity(identity, "login");
        return user && "email" in user ? user : null;
      } catch { return null; }
    },
  })] };
}
