import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const response = NextResponse.next();

    // Security headers
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    // HSTS (only in production with HTTPS)
    if (process.env.NODE_ENV === "production") {
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains"
      );
    }

    // Content Security Policy (report-only mode for now)
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'", // Next.js requires unsafe-eval
      "style-src 'self' 'unsafe-inline'", // Tailwind requires unsafe-inline
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' wss: https:", // Allow WebSocket and HTTPS connections
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    response.headers.set("Content-Security-Policy-Report-Only", csp);

    return response;
  },
  {
    pages: {
      signIn: "/sign-in",
    },
    callbacks: {
      authorized({ req, token }) {
        const { pathname } = req.nextUrl;

        // Public routes
        if (
          pathname === "/sign-in" ||
          pathname === "/sign-up" ||
          pathname === "/forgot-password" ||
          pathname === "/reset-password" ||
          pathname === "/verify-email"
        ) {
          return true;
        }

        // Everything else requires auth
        return !!token;
      },
    },
  }
);

export const config = {
  matcher: [
    // UI routes only. API routes are handled by route-level auth and must return JSON 401/403
    // (no redirects), so we intentionally exclude /api/* here.
    "/((?!api|trpc|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
