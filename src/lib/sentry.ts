import * as Sentry from "@sentry/nextjs";
import { sanitizeSentryEvent, sanitizeTelemetryContext } from "./telemetry-sanitize";
export function captureException(error: Error, context?: Record<string, unknown>) {
  try {
    Sentry.withScope((scope) => {
      const safe = sanitizeTelemetryContext(context);
      scope.setExtras(safe);
      scope.setUser(typeof safe.actorId === "string" ? {
        id: safe.actorId
      } : null);
      // The shared beforeSend boundary protects SDK-captured errors too.
      Sentry.captureException(error);
    });
  }
  catch { /* Telemetry cannot replace a business result or exception. */
  }
}
export function captureMessage(_message: string, level: Sentry.SeverityLevel = "info") {
  try {
    Sentry.captureMessage("Application event", level);
  }
  catch { /* No raw fallback. */
  }
}
export function setUser(user: {
  id: string;
  email?: string;
  username?: string;
} | null) {
  // Legacy identity setter stays callable; new request paths use scoped context.
  const safe = sanitizeSentryEvent({
    user
  });
  try {
    Sentry.setUser(safe.user ? {
      id: safe.user.id
    } : null);
  }
  catch { /* Non-fatal. */
  }
}
export function addBreadcrumb(breadcrumb: Sentry.Breadcrumb) {
  const event = sanitizeSentryEvent({
    breadcrumbs: [breadcrumb]
  });
  const safe = event.breadcrumbs?.[0];
  if (safe) {
    try {
      Sentry.addBreadcrumb(safe);
    }
    catch { /* Non-fatal. */
    }
  }
}
export function withSentry<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>, context?: Record<string, unknown>): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    }
    catch (error) {
      captureException(error as Error, context);
      throw error;
    }
  };
}
export default Sentry;
