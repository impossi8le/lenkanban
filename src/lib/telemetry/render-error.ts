import { captureException } from '../sentry';
import { getBrowserTelemetryClient } from './client';

const reported = new WeakMap<Error, { context: string; errorId: string }>();

/** A local reference does not promise delivery to either diagnostic sink. */
export function reportRenderFailure(error: Error): string | null {
  try {
    const client = getBrowserTelemetryClient();
    const context = client?.getDiagnosticContext() ?? 'no-client';
    const existing = reported.get(error);
    if (existing?.context === context) return existing.errorId;
    const errorId = globalThis.crypto.randomUUID();
    reported.set(error, { context, errorId });
    captureException(error, { errorId, event: 'client.render.failed', operation: 'app.render' });
    client?.captureRenderFailure(errorId);
    return errorId;
  } catch { return null; }
}
