import * as Sentry from "@sentry/nextjs";
import { sanitizeSentryEvent } from "./src/lib/telemetry-sanitize";
const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0,
    sampleRate: 1.0,
    debug: false,
    sendDefaultPii: false,
    enableLogs: false,
    enableMetrics: false,
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,
    beforeSend: sanitizeSentryEvent
  });
}
