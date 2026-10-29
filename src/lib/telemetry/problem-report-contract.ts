import { BreadcrumbRing, type BreadcrumbRecord } from './breadcrumbs';

export const PROBLEM_REPORT_REASONS = ['slow', 'button', 'error', 'other'] as const;
export type ProblemReportReason = (typeof PROBLEM_REPORT_REASONS)[number];
export type ProblemReportBreadcrumb = Omit<BreadcrumbRecord, 'at'>;
export const PROBLEM_REPORT_MAX_BREADCRUMBS = 50;
export const PROBLEM_REPORT_MAX_AGE_MS = 300_000;
export const PROBLEM_REPORT_MAX_SNAPSHOT_BYTES = 8192;

export function isProblemReportReason(value: unknown): value is ProblemReportReason {
  return typeof value === 'string' && (PROBLEM_REPORT_REASONS as readonly string[]).includes(value);
}

const fields = new Set(['eventId', 'kind', 'name', 'seq', 'occurredAt', 'outcome', 'statusCode',
  'durationMs', 'attempt', 'state', 'errorCode']);

/** A report is an immutable scalar snapshot, never arbitrary DOM/session context. */
export function parseProblemReportBreadcrumbs(
  value: unknown,
  anchor: { seq: number; occurredAt: string },
): ProblemReportBreadcrumb[] | null {
  try {
    const end = Date.parse(anchor.occurredAt);
    if (!Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || !Number.isFinite(end)
      || new Date(end).toISOString() !== anchor.occurredAt || !Array.isArray(value)
      || value.length > PROBLEM_REPORT_MAX_BREADCRUMBS || Object.getOwnPropertySymbols(value).length) return null;
    if (Object.getOwnPropertyNames(value).some(key => key !== 'length'
      && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return null;
    const result: ProblemReportBreadcrumb[] = [];
    const seen = new Set<string>();
    let previousSeq = -1;
    for (let i = 0; i < value.length; i++) {
      const item = Object.getOwnPropertyDescriptor(value, String(i));
      if (!item || !('value' in item) || !item.value || typeof item.value !== 'object'
        || Array.isArray(item.value) || Object.getOwnPropertySymbols(item.value).length) return null;
      const safe: Record<string, unknown> = {};
      for (const key of Object.getOwnPropertyNames(item.value)) {
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
        if (!fields.has(key) || !descriptor || !('value' in descriptor)) return null;
        safe[key] = descriptor.value;
      }
      // Reuse the established closed vocabulary/type validator without retaining
      // the client's monotonic clock. One-entry ring cannot silently evict input.
      const ring = new BreadcrumbRing({ capacity: 1, maxBytes: 1024, maxEntryBytes: 512 });
      if (!ring.record({ ...safe, at: 0 } as unknown as BreadcrumbRecord, 0)) return null;
      const { at: _at, ...breadcrumb } = ring.snapshot(0)[0];
      void _at;
      const occurred = Date.parse(breadcrumb.occurredAt);
      if (breadcrumb.seq <= previousSeq || breadcrumb.seq > anchor.seq || seen.has(breadcrumb.eventId)
        || occurred > end || end - occurred > PROBLEM_REPORT_MAX_AGE_MS) return null;
      previousSeq = breadcrumb.seq;
      seen.add(breadcrumb.eventId);
      result.push(breadcrumb);
    }
    return new TextEncoder().encode(JSON.stringify(result)).byteLength <= PROBLEM_REPORT_MAX_SNAPSHOT_BYTES
      ? result : null;
  } catch { return null; }
}
