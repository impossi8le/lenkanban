import NextAuth from "next-auth";
import { nextAuthOptions } from "@/lib/nextauth";
import { withCorporateProvider } from "@/lib/auth/sso-options";

const handler = NextAuth(withCorporateProvider(nextAuthOptions));

export { handler as GET, handler as POST };
