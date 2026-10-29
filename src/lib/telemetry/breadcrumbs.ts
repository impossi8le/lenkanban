import type { TelemetryOutcome } from './contract';
import { validCorrelationId } from '../telemetry-sanitize';
import { API_ROUTE_TEMPLATES } from '../api-observation-routes';

/**
 * Bounded client-side breadcrumb ring for issue #55.
 *
 * The catalog is closed on purpose: callers may describe *what kind of thing
 * happened* with a machine label, never task text, form values, URLs, query
 * strings or arbitrary metadata. Unknown labels are rejected, not truncated.
 */

export const BREADCRUMB_KINDS = [
  'navigation',
  'dialog',
  'operation',
  'request',
  'connectivity',
  'retry',
] as const;

export type BreadcrumbKind = (typeof BREADCRUMB_KINDS)[number];
export type ConnectivityState = 'online' | 'offline';
export type BreadcrumbErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORT'
  | 'HTTP_4XX'
  | 'HTTP_409'
  | 'HTTP_5XX';

const OPERATION_NAMES = [
  'task.checklist.toggle',
  'app.render',
  'telemetry.session.start',
  'telemetry.batch',
  'task.create',
  'task.update',
  'task.move',
  'comment.create',
  'attachment.upload',
  'message.send',
  'auth.login',
  'screen.view',
  'board.view.change',
  'board.filter.change',
  'board.search',
  'ui.button.activate',
  'ui.link.activate',
  'ui.checkbox.activate',
  'ui.select.activate',
  'task.title.edit',
  'task.description.edit',
] as const;

const REQUEST_ROUTES = [
  ...API_ROUTE_TEMPLATES,
  '/api/:unmatched',
] as const;

/** Closed per-kind vocabulary. Values are screen/dialog/operation names, not user data. */
export const BREADCRUMB_NAMES: Readonly<Record<BreadcrumbKind, readonly string[]>> = {
  navigation: [
    'root',
    'home',
    'board',
    'my-tasks',
    'inbox',
    'messages',
    'analytics',
    'settings',
    'admin',
    'admin.telemetry',
    'login',
    'register',
  ],
  dialog: [
    'task.create',
    'task.detail',
    'task.delete',
    'project.create',
    'project.settings',
    'project.columns',
    'project.members',
    'template.create',
    'recurring.create',
    'automation.rule',
    'confirm',
  ],
  operation: [...OPERATION_NAMES],
  request: [...REQUEST_ROUTES],
  connectivity: ['online', 'offline', 'reconnect'],
  retry: [...OPERATION_NAMES],
};

const KIND_SET = new Set<string>(BREADCRUMB_KINDS);
const OUTCOME_SET = new Set<string>(['success', 'rejected', 'conflict', 'failure', 'cancelled']);
const ERROR_CODE_SET = new Set<string>(['NETWORK', 'TIMEOUT', 'ABORT', 'HTTP_4XX', 'HTTP_409', 'HTTP_5XX']);
const TRACE_ID = /^[a-f0-9]{32}$/i;
const MAX_STATUS = 599;
const MAX_DURATION_MS = 86_400_000;
const MAX_ATTEMPT = 3;

export function isBreadcrumbKind(value: unknown): value is BreadcrumbKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

export function isBreadcrumbName(kind: BreadcrumbKind, value: unknown): boolean {
  // Membership is checked per kind. `operation` and `retry` intentionally share
  // operation names: the kind, not the name, says whether a step was attempted
  // or retried. Navigation and dialog names stay disjoint (`task.detail` is the
  // card dialog, not a screen).
  return typeof value === 'string' && BREADCRUMB_NAMES[kind].includes(value);
}

export function isBreadcrumbOutcome(value: unknown): value is TelemetryOutcome {
  return typeof value === 'string' && OUTCOME_SET.has(value);
}

export function isBreadcrumbErrorCode(value: unknown): value is BreadcrumbErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

export function isConnectivityState(value: unknown): value is ConnectivityState {
  return value === 'online' || value === 'offline';
}

/** traceId is an optional technical trace identifier, never a secret or actor proof. */
export function validTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value);
}

export interface BreadcrumbInput {
  eventId: string;
  kind: BreadcrumbKind;
  name: string;
  seq: number;
  occurredAt: string;
  /** Monotonic local timestamp used only for TTL and eviction. */
  at: number;
  outcome?: TelemetryOutcome;
  statusCode?: number;
  durationMs?: number;
  attempt?: number;
  state?: ConnectivityState;
  errorCode?: BreadcrumbErrorCode;
}

export type BreadcrumbRecord = Readonly<BreadcrumbInput>;

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/**
 * Rebuilds a fresh record from scalar fields only. Extra keys (including any
 * caller-supplied text) are dropped before the value can enter the ring.
 */
function normalize(input: BreadcrumbInput): BreadcrumbRecord | null {
  try {
    if (!input || typeof input !== 'object') return null;
    if (!validCorrelationId(input.eventId)) return null;
    if (!isBreadcrumbKind(input.kind) || !isBreadcrumbName(input.kind, input.name)) return null;
    if (!Number.isSafeInteger(input.seq) || input.seq < 0) return null;
    if (!isCanonicalIso(input.occurredAt)) return null;
    if (typeof input.at !== 'number' || !Number.isFinite(input.at) || input.at < 0) return null;

    const record: {
      eventId: string;
      kind: BreadcrumbKind;
      name: string;
      seq: number;
      occurredAt: string;
      at: number;
      outcome?: TelemetryOutcome;
      statusCode?: number;
      durationMs?: number;
      attempt?: number;
      state?: ConnectivityState;
      errorCode?: BreadcrumbErrorCode;
    } = {
      eventId: input.eventId.toLowerCase(),
      kind: input.kind,
      name: input.name,
      seq: input.seq,
      occurredAt: input.occurredAt,
      at: input.at,
    };

    if (input.outcome !== undefined) {
      if (!isBreadcrumbOutcome(input.outcome)) return null;
      record.outcome = input.outcome;
    }
    if (input.statusCode !== undefined) {
      if (!Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > MAX_STATUS) return null;
      record.statusCode = input.statusCode;
    }
    if (input.durationMs !== undefined) {
      if (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs)
        || input.durationMs < 0 || input.durationMs > MAX_DURATION_MS) return null;
      record.durationMs = input.durationMs;
    }
    if (input.attempt !== undefined) {
      if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > MAX_ATTEMPT) return null;
      record.attempt = input.attempt;
    }
    if (input.state !== undefined) {
      if (input.kind !== 'connectivity' || !isConnectivityState(input.state)) return null;
      const expected = input.name === 'offline' ? 'offline' : 'online';
      if (input.state !== expected) return null;
      record.state = input.state;
    } else if (input.kind === 'connectivity') {
      return null;
    }
    if (input.errorCode !== undefined) {
      if (!isBreadcrumbErrorCode(input.errorCode)) return null;
      record.errorCode = input.errorCode;
    }
    return record;
  } catch {
    return null;
  }
}

function byteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}

export interface BreadcrumbRingOptions {
  capacity?: number;
  ttlMs?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

interface StoredBreadcrumb {
  record: BreadcrumbRecord;
  size: number;
}

/**
 * Fixed-capacity ring. Oldest entries are dropped first when the count or byte
 * budget is exceeded; expired entries are removed before every read/write.
 * Failures are contained: a hostile value can never grow or break the ring.
 */
export class BreadcrumbRing {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private entries: StoredBreadcrumb[] = [];
  private totalBytes = 0;

  constructor(options: BreadcrumbRingOptions = {}) {
    const capacity = options.capacity ?? 50;
    const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    const maxBytes = options.maxBytes ?? 8 * 1024;
    const maxEntryBytes = options.maxEntryBytes ?? 512;
    this.capacity = Number.isSafeInteger(capacity) && capacity > 0 ? Math.min(capacity, 200) : 50;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 5 * 60 * 1000;
    this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 8 * 1024;
    this.maxEntryBytes = Number.isSafeInteger(maxEntryBytes) && maxEntryBytes > 0 ? maxEntryBytes : 512;
  }

  get length(): number {
    return this.entries.length;
  }

  record(input: BreadcrumbInput, now: number): boolean {
    try {
      const record = normalize(input);
      if (!record) return false;
      this.purge(now);
      const size = byteLength(JSON.stringify(record));
      if (size <= 0 || size > this.maxEntryBytes || size > this.maxBytes) return false;

      this.entries.push({ record, size });
      this.totalBytes += size;
      while (this.entries.length > this.capacity || this.totalBytes > this.maxBytes) {
        const dropped = this.entries.shift();
        if (!dropped) break;
        this.totalBytes -= dropped.size;
      }
      return true;
    } catch {
      return false;
    }
  }

  snapshot(now: number): BreadcrumbRecord[] {
    this.purge(now);
    return this.entries.map(entry => ({ ...entry.record }));
  }

  clear(): void {
    this.entries = [];
    this.totalBytes = 0;
  }

  private purge(now: number): void {
    if (!Number.isFinite(now)) return;
    const live = this.entries.filter(entry => now - entry.record.at < this.ttlMs);
    if (live.length !== this.entries.length) {
      this.entries = live;
      this.totalBytes = live.reduce((total, entry) => total + entry.size, 0);
    }
  }
}
