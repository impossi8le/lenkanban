import {
  parseClientTelemetryEvent,
  type ClientTelemetryEvent,
  type TelemetryOutcome,
  TELEMETRY_ACTION,
} from './contract';
import {
  BreadcrumbRing,
  isBreadcrumbErrorCode,
  isBreadcrumbKind,
  isBreadcrumbName,
  isConnectivityState,
  validTraceId,
  type BreadcrumbErrorCode,
  type BreadcrumbKind,
  type BreadcrumbRecord,
  type ConnectivityState,
} from './breadcrumbs';
import {
  isTelemetryUiAction,
  TELEMETRY_ACTION_ROUTES,
  type TelemetryFilter,
  type TelemetryScreen,
  type TelemetryUiAction,
  type TelemetryView,
} from './catalog';
import { validCorrelationId } from '../telemetry-sanitize';
import { parseSessionExpiry } from './session-expiry';
import { isProblemReportReason, type ProblemReportReason } from './problem-report-contract';
import { isTelemetryScreen } from './catalog';

export interface TelemetryRequestResult {
  outcome: TelemetryOutcome;
  durationMs: number;
  statusCode?: number;
  requestId?: string;
  errorId?: string;
  /** Optional explicit classification; otherwise derived from outcome/status. */
  errorCode?: BreadcrumbErrorCode;
}

export interface TelemetryAction {
  actionId: string;
  operationId: string;
  sessionId: string;
  traceId: string;
  /** Closed catalog name this intent belongs to. */
  action: TelemetryUiAction;
  generation: number;
  startedAt: number;
  finished: boolean;
}

/** Closed per-action details; the parser rejects a field on the wrong action. */
export interface UiActionDetails {
  screen?: TelemetryScreen;
  view?: TelemetryView;
  filter?: TelemetryFilter;
}

export interface BreadcrumbDetails {
  outcome?: TelemetryOutcome;
  statusCode?: number;
  durationMs?: number;
  attempt?: number;
  state?: ConnectivityState;
  errorCode?: BreadcrumbErrorCode;
}

export interface ProblemReportDraft {
  readonly reportId: string;
  readonly reason: ProblemReportReason;
  readonly screen: TelemetryScreen;
  readonly breadcrumbCount: number;
  readonly truncated: boolean;
}
export type ProblemReportReceipt = Pick<ProblemReportDraft, 'reportId' | 'breadcrumbCount' | 'truncated'>;
export class ProblemReportFailure extends Error {
  constructor(readonly code: 'unavailable' | 'changed' | 'unconfirmed' | 'rejected') {
    super('Problem report delivery was not confirmed');
    this.name = 'ProblemReportFailure';
  }
}
interface PreparedReport {
  generation: number;
  event: Extract<ClientTelemetryEvent, { event: 'client.problem.reported' }>;
  payload: string;
  createdAt: number;
  draft: ProblemReportDraft;
  pending?: Promise<ProblemReportReceipt>;
  receipt?: ProblemReportReceipt;
}

/** Rerender/double-effect window for an identical screen/view/filter intention. */
const UI_INTENT_DEDUPE_MS = 1000;

/** Session-scoped marker: the server reported telemetry as not configured. */
const TELEMETRY_DISABLED_KEY = 'lenkanban.telemetry.disabled';

/** Set when the server answered 503 TELEMETRY_UNAVAILABLE during this page. */
let disabledForSession = false;

function sessionStore(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    // Blocked storage is a browser policy, not a telemetry failure.
    return null;
  }
}

/**
 * True once the server has said telemetry is not configured. The flag survives
 * client-side navigation through sessionStorage and is reset by a new tab.
 */
export function isTelemetryDisabledForSession(): boolean {
  if (disabledForSession) return true;
  const store = sessionStore();
  if (!store) return false;
  try {
    return store.getItem(TELEMETRY_DISABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function disableTelemetryForSession(): void {
  disabledForSession = true;
  const store = sessionStore();
  if (!store) return;
  try {
    store.setItem(TELEMETRY_DISABLED_KEY, '1');
  } catch {
    // The in-memory flag already prevents further requests for this page.
  }
}

/** Clears the session marker; used when a fresh bootstrap enables telemetry. */
export function resetTelemetrySessionDisable(): void {
  disabledForSession = false;
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(TELEMETRY_DISABLED_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/**
 * A cancelled request is not a crash. Only the abort signal's own error shape
 * qualifies: a timeout or a network error keeps its name and is reported.
 */
export function isCancellationError(error: unknown): boolean {
  try {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR') return true;
    // DOMException.ABORT_ERR is 20; a plain object with the same number is not
    // an abort and must still be reported.
    return typeof DOMException !== 'undefined'
      && error instanceof DOMException
      && candidate.code === 20;
  } catch {
    // An unreadable thrown value is safer to report than to suppress.
    return false;
  }
}

/** One failed HTTP attempt is classified without conflating cancellation with failure. */
export function resultErrorCode(
  outcome: TelemetryOutcome,
  statusCode?: number,
): BreadcrumbErrorCode | undefined {
  if (outcome === 'cancelled') return 'ABORT';
  if (outcome === 'conflict') return 'HTTP_409';
  if (outcome === 'rejected') return 'HTTP_4XX';
  if (outcome === 'failure') {
    if (statusCode === undefined) return 'NETWORK';
    if (statusCode === 409) return 'HTTP_409';
    if (statusCode >= 500) return 'HTTP_5XX';
    if (statusCode >= 400) return 'HTTP_4XX';
  }
  return undefined;
}

export interface TelemetryClientOptions {
  fetch?: typeof fetch;
  clock?: () => number;
  wallClock?: () => Date;
  uuid?: () => string;
}

interface QueueEntry {
  event: ClientTelemetryEvent;
  enqueuedAt: number;
  attempts: number;
  nextAt: number;
  size: number;
}

interface SessionInitResponse {
  success?: boolean;
  data?: {
    sessionId?: string;
    sessionToken?: string;
    expiresAt?: string;
  };
}

interface BatchResponse {
  success?: boolean;
  data?: {
    accepted?: string[];
  };
}

/** Reads the closed API error code from an error body, if one is present. */
function errorCodeOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export class TelemetryClient {
  private readonly fetchFn?: typeof fetch;
  private readonly clock: () => number;
  private readonly wallClockFn: () => Date;
  private readonly uuidFn: () => string;
  private readonly encoder = new TextEncoder();

  private currentUserId: string | null | undefined = undefined;
  private sessionId: string | null = null;
  private sessionToken: string | null = null;
  private sessionExpiresAt: number | null = null;
  private ready = false;
  private disposed = false;
  private generation = 0;
  private seq = 0;
  /** Breadcrumb-local order; never advances the delivered-event seq. */
  private breadcrumbSeq = 0;
  /** One diagnostic render event per errorId within the current session. */
  private readonly reportedRenderErrors = new Set<string>();

  private queue: QueueEntry[] = [];
  private totalBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;
  private currentFlushPromise: Promise<void> | null = null;
  private initAbortController: AbortController | null = null;
  private flushAbortController: AbortController | null = null;

  /** Bounded, per-session path to the error; cleared on logout/actor switch. */
  private readonly problemReports = new WeakMap<ProblemReportDraft, PreparedReport>();
  private readonly reportControllers = new Set<AbortController>();
  private readonly sessionListeners = new Set<() => void>();
  private readonly breadcrumbs = new BreadcrumbRing({ capacity: 50, ttlMs: 300_000, maxBytes: 8192 });
  /** True once a UI screen/dialog/connectivity step was explicitly recorded. */
  private pathRecorded = false;
  private connectivityHandler: (() => void) | null = null;
  private lastConnectivity: ConnectivityState | null = null;
  /**
   * Same-tick guard: a React rerender or a doubled effect must not turn one
   * user intention into two unique actions. Reset with the session.
   */
  private lastUiIntent: { key: string; at: number } | null = null;

  constructor(options?: TelemetryClientOptions) {
    const opts = options && typeof options === 'object' ? options : {};
    const globalFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
    this.fetchFn = typeof opts.fetch === 'function' ? opts.fetch : globalFetch;
    this.clock = typeof opts.clock === 'function'
      ? opts.clock
      : () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
    this.wallClockFn = typeof opts.wallClock === 'function' ? opts.wallClock : () => new Date();
    this.uuidFn = typeof opts.uuid === 'function'
      ? opts.uuid
      : () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '');
    this.attachConnectivity();
  }

  private attachConnectivity(): void {
    try {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
      this.lastConnectivity = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online';
      this.connectivityHandler = () => {
        try {
          const online = typeof navigator === 'undefined' || navigator.onLine !== false;
          const state: ConnectivityState = online ? 'online' : 'offline';
          const name = online && this.lastConnectivity === 'offline' ? 'reconnect' : state;
          this.lastConnectivity = state;
          this.recordPath('connectivity', name, { state });
        } catch { /* A browser event cannot break telemetry. */ }
      };
      window.addEventListener('online', this.connectivityHandler);
      window.addEventListener('offline', this.connectivityHandler);
    } catch { /* Non-browser runtimes simply have no connectivity breadcrumbs. */ }
  }

  private now(): number {
    try {
      const t = this.clock();
      if (typeof t === 'number' && Number.isFinite(t)) return t;
    } catch {}
    return Date.now();
  }

  private uuid(): string {
    try {
      const id = this.uuidFn();
      if (validCorrelationId(id)) return id.toLowerCase();
    } catch {}
    return '';
  }

  private traceId(actionId: string): string {
    try {
      // apiFetch already carries actionId; derive the same trace at the server
      // without adding a second, currently unpropagated client header.
      const id = actionId.replace(/-/g, '').toLowerCase();
      if (validTraceId(id)) return id;
    } catch {}
    return '';
  }

  async setIdentity(userId: string | null): Promise<void> {
    if (this.disposed || (typeof userId !== 'string' && userId !== null)) return;
    if (userId === this.currentUserId) return;

    this.currentUserId = userId;
    await this.initializeSession();
  }

  private resetSession(): void {
    this.generation++;
    this.ready = false;
    this.seq = 0;
    this.breadcrumbSeq = 0;
    this.reportedRenderErrors.clear();
    this.sessionId = null;
    this.sessionToken = null;
    this.sessionExpiresAt = null;
    this.queue = [];
    this.totalBytes = 0;
    this.breadcrumbs.clear();
    this.pathRecorded = false;
    this.lastUiIntent = null;
    for (const controller of this.reportControllers) controller.abort();
    this.reportControllers.clear();
    for (const listener of this.sessionListeners) { try { listener(); } catch { /* UI reporting is optional. */ } }

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.initAbortController?.abort();
    this.initAbortController = null;
    this.flushAbortController?.abort();
    this.flushAbortController = null;
    this.isFlushing = false;
    this.currentFlushPromise = null;
  }

  private wallNow(): number | null {
    try {
      const value = this.wallClockFn().getTime();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch { return null; }
  }

  private async initializeSession(): Promise<void> {
    this.resetSession();
    const gen = this.generation;
    if (this.currentUserId === null || this.currentUserId === undefined || !this.fetchFn) return;
    const controller = new AbortController();
    this.initAbortController = controller;

    const newSessionId = this.uuid();
    if (!newSessionId) return;
    try {
      const { response: res, body: json } = await this.post(
        JSON.stringify({ kind: 'session.start', sessionId: newSessionId }), controller,
      );

      if (this.disposed || this.generation !== gen) return;
      if (!res.ok) {
        // Expected state, not an error: the server has telemetry switched off.
        // Stop for the rest of the session instead of retrying on every page.
        if (res.status === 503 && errorCodeOf(json) === 'TELEMETRY_UNAVAILABLE') {
          disableTelemetryForSession();
        }
        return;
      }

      const body = json as SessionInitResponse;
      const nowMs = this.wallNow();
      const expiry = nowMs === null ? null : parseSessionExpiry(body?.data?.sessionToken, body?.data?.expiresAt, nowMs);
      if (
        !this.disposed && this.generation === gen &&
        body?.success === true &&
        body.data?.sessionId === newSessionId &&
        typeof body.data.sessionToken === 'string' && expiry !== null
      ) {
        this.sessionId = newSessionId;
        this.sessionToken = body.data.sessionToken;
        this.sessionExpiresAt = expiry;
        this.ready = true;
      }
    } catch {}
  }

  /** At most one attempt: initialization synchronously clears readiness/expiry. */
  private renewExpiredSession(): boolean {
    if (this.disposed || !this.ready || this.sessionExpiresAt === null) return false;
    const nowMs = this.wallNow();
    if (nowMs === null) {
      this.resetSession();
      return true;
    }
    if (nowMs < this.sessionExpiresAt) return false;
    void this.initializeSession().catch(() => undefined);
    return true;
  }

  /** The deadline covers headers and the entire acknowledgement body. */
  private async post(payload: string, controller: AbortController): Promise<{ response: Response; body: unknown }> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Telemetry transport timeout'));
      }, 5000);
    });
    const operation = (async () => {
      const response = await this.fetchFn!('/api/telemetry', {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: payload, signal: controller.signal,
      });
      let body: unknown = null;
      // 503 carries the closed TELEMETRY_UNAVAILABLE code that ends collection
      // for the session; other failures stay body-less.
      if (response.ok || response.status === 503) {
        try { body = await response.json(); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      return { response, body };
    })();
    try { return await Promise.race([operation, deadline]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
  }

  /**
   * Records one user intention. The optional action must come from the closed
   * catalog; the default preserves the existing checklist instrumentation.
   */
  beginAction(action: TelemetryUiAction = TELEMETRY_ACTION): TelemetryAction | null {
    if (this.disposed || !this.ready || !this.sessionId) return null;
    try {
      if (!isTelemetryUiAction(action)) return null;
      if (this.renewExpiredSession()) return null;
      const actionId = this.uuid();
      const operationId = this.uuid();
      const traceId = this.traceId(actionId);
      if (!actionId || !operationId || !traceId) return null;
      const token: TelemetryAction = {
        actionId,
        operationId,
        sessionId: this.sessionId,
        traceId,
        action,
        generation: this.generation,
        startedAt: this.now(),
        finished: false,
      };
      // Direct actions (including checklist) must have a path even when no
      // screen/dialog instrumentation preceded them.
      if (isBreadcrumbName('operation', action)) this.recordPath('operation', action);
      const parsed = parseClientTelemetryEvent({
        eventId: this.uuid(),
        schemaVersion: 1,
        event: 'ui.action',
        action,
        sessionId: this.sessionId,
        seq: ++this.seq,
        occurredAt: this.wallClockFn().toISOString(),
        actionId,
        traceId,
      });
      if (!parsed) return null;
      this.enqueue(parsed);
      return token;
    } catch {
      return null;
    }
  }

  /**
   * Records a screen/view/filter/search intent that has no HTTP command. A
   * repeated render must not call this method again; callers invoke it from the
   * explicit user event, never from an effect.
   */
  recordUiAction(action: TelemetryUiAction, details: UiActionDetails = {}): boolean {
    try {
      if (this.disposed || !this.ready || !this.sessionId) return false;
      if (!isTelemetryUiAction(action)) return false;
      if (this.renewExpiredSession()) return false;
      const key = `${action}|${details.screen ?? ''}|${details.view ?? ''}|${details.filter ?? ''}`;
      const now = this.now();
      if (this.lastUiIntent && this.lastUiIntent.key === key && now - this.lastUiIntent.at < UI_INTENT_DEDUPE_MS) {
        return false;
      }
      const actionId = this.uuid();
      const traceId = this.traceId(actionId);
      const eventId = this.uuid();
      if (!actionId || !traceId || !eventId) return false;
      const parsed = parseClientTelemetryEvent({
        eventId,
        schemaVersion: 1,
        event: 'ui.action',
        action,
        sessionId: this.sessionId,
        seq: ++this.seq,
        occurredAt: this.wallClockFn().toISOString(),
        actionId,
        traceId,
        ...(details.screen !== undefined ? { screen: details.screen } : {}),
        ...(details.view !== undefined ? { view: details.view } : {}),
        ...(details.filter !== undefined ? { filter: details.filter } : {}),
      });
      if (!parsed) return false;
      this.lastUiIntent = { key, at: now };
      this.enqueue(parsed);
      this.recordIntentPath(action, details);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mirrors one accepted UI intent into the ring so a later failure can be
   * traced back to the screen/dialog the user was on. The value is a closed
   * catalog name; the selected filter or search text is never recorded.
   */
  private recordIntentPath(action: TelemetryUiAction, details: UiActionDetails): void {
    if (action === 'screen.view' && details.screen !== undefined) {
      if (isBreadcrumbName('navigation', details.screen)) {
        this.recordPath('navigation', details.screen);
        return;
      }
      // `task.detail` is a card/dialog, not a distinct navigation screen.
      if (isBreadcrumbName('dialog', details.screen)) {
        this.recordPath('dialog', details.screen);
        return;
      }
    }
    if (isBreadcrumbName('operation', action)) this.recordPath('operation', action);
  }

  /** Opening a screen or the task card. */
  recordScreen(screen: TelemetryScreen): boolean {
    return this.recordUiAction('screen.view', { screen });
  }

  /** Switching between the board, table and calendar views. */
  recordViewChange(view: TelemetryView): boolean {
    return this.recordUiAction('board.view.change', { view });
  }

  /** Changing a filter facet; the selected value is never collected. */
  recordFilterChange(filter: TelemetryFilter): boolean {
    return this.recordUiAction('board.filter.change', { filter });
  }

  /** A search was executed; the search string is never collected. */
  recordSearch(): boolean {
    return this.recordUiAction('board.search');
  }

  finishAction(token: TelemetryAction, result: TelemetryRequestResult): void {
    try {
    if (
      this.disposed || !this.ready || !this.sessionId ||
      !token || typeof token !== 'object' || token.finished ||
      token.generation !== this.generation || token.sessionId !== this.sessionId ||
      !result || typeof result !== 'object'
    ) return;

    if (this.renewExpiredSession()) return;
    token.finished = true;
      const durationMs = typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
        ? result.durationMs
        : Math.max(0, this.now() - token.startedAt);
      const statusCode = typeof result.statusCode === 'number' && Number.isFinite(result.statusCode)
        ? result.statusCode
        : undefined;
      const requestId = typeof result.requestId === 'string' && validCorrelationId(result.requestId)
        ? result.requestId
        : undefined;
      const errorId = typeof result.errorId === 'string' && validCorrelationId(result.errorId)
        ? result.errorId
        : undefined;
      const errorCode = isBreadcrumbErrorCode(result.errorCode)
        ? result.errorCode
        : resultErrorCode(result.outcome, statusCode);

      const route = TELEMETRY_ACTION_ROUTES[token.action];
      if (route !== undefined && isBreadcrumbName('request', route)) {
        this.recordBreadcrumb('request', route, {
          outcome: result.outcome,
          durationMs,
          ...(statusCode !== undefined ? { statusCode } : {}),
          ...(errorCode ? { errorCode } : {}),
        });
      }

      const resultSeq = ++this.seq;
      const parsed = parseClientTelemetryEvent({
        eventId: this.uuid(),
        schemaVersion: 1,
        event: 'client.request.result',
        action: token.action,
        sessionId: this.sessionId,
        seq: resultSeq,
        occurredAt: this.wallClockFn().toISOString(),
        actionId: token.actionId,
        traceId: token.traceId,
        outcome: result.outcome,
        durationMs,
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(requestId ? { requestId } : {}),
        ...(errorId ? { errorId } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
      if (parsed) this.enqueue(parsed);
      if (result.outcome !== 'success') this.flushBreadcrumbs(token.actionId, token.traceId, resultSeq);
    } catch {}
  }

  getDiagnosticContext(): string {
    return `${this.generation}:${this.ready ? this.sessionId : 'unready'}`;
  }

  captureRenderFailure(errorId: string): void {
    try {
      if (this.disposed || !this.ready || !this.sessionId) return;
      if (!validCorrelationId(errorId)) return;
      const key = errorId.toLowerCase();
      if (this.reportedRenderErrors.has(key)) return;
      if (this.renewExpiredSession()) return;
      const actionId = this.uuid();
      const traceId = this.traceId(actionId);
      if (!actionId || !traceId) return;
      this.recordBreadcrumb('operation', 'app.render');
      const renderSeq = ++this.seq;
      const parsed = parseClientTelemetryEvent({
        schemaVersion: 1, eventId: this.uuid(), sessionId: this.sessionId,
        actionId, traceId, action: 'app.render', event: 'client.render.failed',
        errorId, errorCode: 'RENDER_FAILURE', seq: renderSeq,
        occurredAt: this.wallClockFn().toISOString(),
      });
      if (parsed) {
        this.enqueue(parsed);
        if (this.reportedRenderErrors.size >= 100) {
          const oldest = this.reportedRenderErrors.values().next().value;
          if (oldest !== undefined) this.reportedRenderErrors.delete(oldest);
        }
        this.reportedRenderErrors.add(key);
        this.flushBreadcrumbs(actionId, traceId, renderSeq);
      }
    } catch { /* Reporting never replaces a render failure. */ }
  }

  /**
   * Records a closed, machine-labelled step in the bounded ring. Callers pass
   * a screen/dialog/operation name from the catalog, never task text or input.
   */
  recordBreadcrumb(kind: BreadcrumbKind, name: string, details: BreadcrumbDetails = {}): boolean {
    try {
      if (this.disposed || !this.ready || !this.sessionId) return false;
      if (!isBreadcrumbKind(kind) || !isBreadcrumbName(kind, name)) return false;
      const eventId = this.uuid();
      if (!eventId) return false;
      const seq = this.breadcrumbSeq + 1;
      const recorded = this.breadcrumbs.record({
        eventId,
        kind,
        name,
        seq,
        occurredAt: this.wallClockFn().toISOString(),
        at: this.now(),
        ...(details.outcome !== undefined ? { outcome: details.outcome } : {}),
        ...(details.statusCode !== undefined ? { statusCode: details.statusCode } : {}),
        ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
        ...(details.attempt !== undefined ? { attempt: details.attempt } : {}),
        ...(details.state !== undefined ? { state: details.state } : {}),
        ...(details.errorCode !== undefined ? { errorCode: details.errorCode } : {}),
      }, this.now());
      if (recorded) this.breadcrumbSeq = seq;
      return recorded;
    } catch {
      return false;
    }
  }

  private recordPath(kind: BreadcrumbKind, name: string, details: BreadcrumbDetails = {}): boolean {
    const recorded = this.recordBreadcrumb(kind, name, details);
    if (recorded) this.pathRecorded = true;
    return recorded;
  }

  recordNavigation(name: string): boolean {
    return this.recordPath('navigation', name);
  }

  recordDialog(name: string): boolean {
    return this.recordPath('dialog', name);
  }

  recordOperation(name: string): boolean {
    return this.recordPath('operation', name);
  }

  recordRetry(name: string, attempt: number): boolean {
    return this.recordPath('retry', name, { attempt });
  }

  recordConnectivity(state: ConnectivityState, reconnect = false): boolean {
    if (!isConnectivityState(state)) return false;
    return this.recordPath('connectivity', reconnect && state === 'online' ? 'reconnect' : state, { state });
  }

  /** Read-only copy for diagnostics/tests; never exposes a mutable ring entry. */
  getBreadcrumbSnapshot(): BreadcrumbRecord[] {
    try {
      return this.breadcrumbs.snapshot(this.now());
    } catch {
      return [];
    }
  }

  /** Passive request observation: a diagnostic breadcrumb, never a UI/business action. */
  recordRequestTiming(routeTemplate: string, details: { durationMs: number; statusCode?: number; outcome?: TelemetryOutcome }): boolean {
    try {
      if (this.disposed || !this.ready || !this.sessionId || this.renewExpiredSession()
        || routeTemplate === '/api/telemetry' || routeTemplate.startsWith('/api/admin/telemetry')
        || !isBreadcrumbName('request', routeTemplate) || !details
        || typeof details.durationMs !== 'number' || !Number.isFinite(details.durationMs) || details.durationMs < 0) return false;
      if (!this.recordPath('request', routeTemplate, details)) return false;
      const crumb = this.getBreadcrumbSnapshot().at(-1);
      if (!crumb) return false;
      const actionId = this.uuid(), traceId = this.traceId(actionId);
      if (!actionId || !traceId) return false;
      const parsed = parseClientTelemetryEvent({
        schemaVersion: 1, eventId: crumb.eventId, sessionId: this.sessionId, actionId, traceId,
        seq: Math.max(this.seq, this.breadcrumbSeq) + 1, occurredAt: crumb.occurredAt,
        event: 'client.breadcrumb', action: 'app.breadcrumb', kind: 'request', name: routeTemplate,
        durationMs: crumb.durationMs,
        ...(crumb.statusCode !== undefined ? { statusCode: crumb.statusCode } : {}),
        ...(crumb.outcome !== undefined ? { outcome: crumb.outcome } : {}),
      });
      if (!parsed) return false;
      this.seq = parsed.seq;
      this.enqueue(parsed);
      return true;
    } catch { return false; }
  }

  /** Subscriptions contain no session/token values and are disposed by the UI. */
  subscribeSessionChange(listener: () => void): () => void {
    this.sessionListeners.add(listener);
    return () => { this.sessionListeners.delete(listener); };
  }

  /** An opaque frozen intent: neither callers nor later clicks can alter its wire payload. */
  prepareProblemReport(reason: ProblemReportReason, screen: TelemetryScreen): ProblemReportDraft | null {
    try {
      if (this.disposed || !this.ready || !this.sessionId || !this.sessionToken
        || !isProblemReportReason(reason) || !isTelemetryScreen(screen) || this.renewExpiredSession()) return null;
      const eventId = this.uuid(), actionId = this.uuid(), errorId = this.uuid();
      const traceId = this.traceId(actionId);
      if (!eventId || !actionId || !errorId || !traceId) return null;
      const occurredAt = this.wallClockFn().toISOString();
      const end = Date.parse(occurredAt);
      const snapshot = this.getBreadcrumbSnapshot().filter(crumb => {
        const at = Date.parse(crumb.occurredAt); return at <= end && end - at <= 300_000;
      }).map(({ at, ...crumb }) => { void at; return crumb; });
      const originalCount = snapshot.length;
      const seq = Math.max(this.seq, this.breadcrumbSeq) + 1;
      const candidate = { schemaVersion: 1, eventId, sessionId: this.sessionId, actionId,
        occurredAt, seq, traceId, event: 'client.problem.reported', action: 'app.problem.report',
        errorId, reason, screen, breadcrumbs: snapshot };
      let parsed = parseClientTelemetryEvent(candidate);
      if (!parsed || parsed.event !== 'client.problem.reported') return null;
      let payload = JSON.stringify({ sessionId: this.sessionId, sessionToken: this.sessionToken, events: [parsed] });
      while (this.encoder.encode(payload).length > 8192 && candidate.breadcrumbs.length > 0) {
        candidate.breadcrumbs.shift();
        parsed = parseClientTelemetryEvent(candidate);
        if (!parsed || parsed.event !== 'client.problem.reported') return null;
        payload = JSON.stringify({ sessionId: this.sessionId, sessionToken: this.sessionToken, events: [parsed] });
      }
      if (this.encoder.encode(payload).length > 8192) return null;
      this.seq = seq;
      const draft = Object.freeze({ reportId: errorId, reason, screen,
        breadcrumbCount: parsed.breadcrumbs.length, truncated: parsed.breadcrumbs.length < originalCount });
      this.problemReports.set(draft, { generation: this.generation, event: parsed, payload, createdAt: this.now(), draft });
      return draft;
    } catch { return null; }
  }

  /** One bounded attempt; retry explicitly with the same opaque draft after an unknown outcome. */
  sendProblemReport(draft: ProblemReportDraft): Promise<ProblemReportReceipt> {
    const entry = this.problemReports.get(draft);
    if (!entry || this.disposed || !this.ready || entry.generation !== this.generation
      || this.now() - entry.createdAt >= 300_000 || this.renewExpiredSession()) {
      return Promise.reject(new ProblemReportFailure('changed'));
    }
    if (entry.receipt) return Promise.resolve(entry.receipt);
    if (entry.pending) return entry.pending;
    const controller = new AbortController();
    this.reportControllers.add(controller);
    let onAbort: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ProblemReportFailure(entry.generation === this.generation ? 'unconfirmed' : 'changed'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    entry.pending = (async () => {
      try {
        const { response, body } = await Promise.race([this.post(entry.payload, controller), aborted]);
        if (this.disposed || entry.generation !== this.generation) throw new ProblemReportFailure('changed');
        if (response.status === 503 && errorCodeOf(body) === 'TELEMETRY_UNAVAILABLE') {
          disableTelemetryForSession(); this.resetSession(); throw new ProblemReportFailure('unavailable');
        }
        if (response.status === 401) { this.resetSession(); throw new ProblemReportFailure('changed'); }
        if (!response.ok) throw new ProblemReportFailure(response.status >= 400 && response.status < 500 ? 'rejected' : 'unconfirmed');
        const ack = body as BatchResponse | null;
        if (ack?.success !== true || !Array.isArray(ack.data?.accepted) || !ack.data.accepted.includes(entry.event.eventId)) {
          throw new ProblemReportFailure('unconfirmed');
        }
        entry.receipt = Object.freeze({ reportId: draft.reportId, breadcrumbCount: draft.breadcrumbCount, truncated: draft.truncated });
        return entry.receipt;
      } catch (error) {
        throw error instanceof ProblemReportFailure ? error : new ProblemReportFailure('unconfirmed');
      } finally {
        controller.signal.removeEventListener('abort', onAbort!);
        this.reportControllers.delete(controller);
        entry.pending = undefined;
      }
    })();
    return entry.pending;
  }

  private flushBreadcrumbs(actionId: string, traceId: string | undefined, eventSeq: number): void {
    if (!this.pathRecorded) return;
    if (this.disposed || !this.ready || !this.sessionId || !validCorrelationId(actionId)) return;
    const crumbs = this.breadcrumbs.snapshot(this.now());
    for (let index = 0; index < crumbs.length; index++) {
      const crumb = crumbs[index];
      // Breadcrumb events share the failing event's seq window: each crumb is
      // ordered strictly before the failure, so the error query includes them.
      const seq = Math.max(0, eventSeq - (crumbs.length - index));
      const parsed = parseClientTelemetryEvent({
        schemaVersion: 1,
        eventId: crumb.eventId,
        sessionId: this.sessionId,
        actionId,
        action: 'app.breadcrumb',
        event: 'client.breadcrumb',
        occurredAt: crumb.occurredAt,
        seq,
        kind: crumb.kind,
        name: crumb.name,
        ...(crumb.outcome !== undefined ? { outcome: crumb.outcome } : {}),
        ...(crumb.statusCode !== undefined ? { statusCode: crumb.statusCode } : {}),
        ...(crumb.durationMs !== undefined ? { durationMs: crumb.durationMs } : {}),
        ...(crumb.attempt !== undefined ? { attempt: crumb.attempt } : {}),
        ...(crumb.state !== undefined ? { state: crumb.state } : {}),
        ...(crumb.errorCode !== undefined ? { errorCode: crumb.errorCode } : {}),
        ...(traceId && validTraceId(traceId) ? { traceId } : {}),
      });
      if (parsed) this.enqueue(parsed);
    }
  }

  private enqueue(event: ClientTelemetryEvent): void {
    if (this.disposed || this.queue.some(e => e.event.eventId === event.eventId)) return;
    let size = 0;
    try {
      size = this.encoder.encode(JSON.stringify(event)).length;
    } catch {
      return;
    }
    if (size <= 0 || size > 65536) return;

    const now = this.now();
    this.purge(now);

    this.queue.push({ event, enqueuedAt: now, attempts: 0, nextAt: 0, size });
    this.totalBytes += size;

    while (this.queue.length > 100 || this.totalBytes > 65536) {
      const dropped = this.queue.shift();
      if (dropped) this.totalBytes -= dropped.size;
    }

    this.scheduleFlush(0);
  }

  private purge(now: number): void {
    this.queue = this.queue.filter(e => now - e.enqueuedAt < 300_000 && e.attempts < 3);
    this.totalBytes = this.queue.reduce((acc, e) => acc + e.size, 0);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.disposed || !this.ready || this.flushTimer !== null) return;
    const gen = this.generation;
    this.flushTimer = setTimeout(() => {
      if (gen !== this.generation || this.disposed) return;
      this.flushTimer = null;
      void this.flush();
    }, Math.max(0, delayMs));
  }

  async flush(): Promise<void> {
    if (this.disposed || !this.ready || !this.sessionId || !this.sessionToken || !this.fetchFn) return;
    if (this.renewExpiredSession()) return;
    if (this.isFlushing) return this.currentFlushPromise ?? Promise.resolve();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const gen = this.generation;
    this.isFlushing = true;
    this.currentFlushPromise = this.sendBatch().catch(() => undefined).finally(() => {
      if (gen === this.generation && !this.disposed) {
        this.isFlushing = false;
        this.currentFlushPromise = null;
      }
    });
    return this.currentFlushPromise;
  }

  private async sendBatch(): Promise<void> {
    const gen = this.generation;
    const sId = this.sessionId;
    const sToken = this.sessionToken;
    const now = this.now();
    this.purge(now);

    if (!this.ready || !sId || !sToken || this.queue.length === 0) return;

    const eligible = this.queue.filter(e => e.nextAt <= now && e.attempts < 3);
    if (eligible.length === 0) {
      this.scheduleNext(now);
      return;
    }

    const batch: QueueEntry[] = [];
    for (const entry of eligible) {
      if (batch.length >= 10) break;
      const testEvents = [...batch.map(b => b.event), entry.event];
      const bytes = this.encoder.encode(JSON.stringify({ sessionId: sId, sessionToken: sToken, events: testEvents })).length;
      if (bytes <= 8192) {
        batch.push(entry);
      } else {
        if (batch.length === 0) entry.attempts = 3;
        break;
      }
    }

    if (batch.length === 0) {
      this.purge(this.now());
      return;
    }

    // Record an actual repeated send, not a scheduled retry that may never run.
    // Keep this only in the ring: delivery must not enqueue its own telemetry.
    const retryAttempt = Math.max(...batch.map(entry => entry.attempts)) + 1;
    if (retryAttempt > 1) this.recordRetry('telemetry.batch', retryAttempt);
    batch.forEach(e => e.attempts++);
    const payload = JSON.stringify({ sessionId: sId, sessionToken: sToken, events: batch.map(b => b.event) });
    this.flushAbortController = new AbortController();
    let res: Response | null = null;
    let batchBody: unknown = null;
    let netErr = false;
    try {
      const delivered = await this.post(payload, this.flushAbortController);
      res = delivered.response;
      batchBody = delivered.body;
    } catch {
      netErr = true;
    }

    if (this.generation !== gen || this.disposed) return;
    const postNow = this.now();

    if (netErr || !res) {
      this.handleRetry(batch, postNow, 1000);
    } else if (res.status === 401) {
      this.resetSession();
      return;
    } else if (res.status === 503 && errorCodeOf(batchBody) === 'TELEMETRY_UNAVAILABLE') {
      // The server lost its telemetry configuration mid-session. This is an
      // expected disabled state: drop the queue and stop for the session.
      disableTelemetryForSession();
      this.resetSession();
      return;
    } else if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      let backoff = 1000;
      const h = res.headers?.get('Retry-After');
      if (h) {
        const sec = parseInt(h, 10);
        if (Number.isFinite(sec) && sec > 0) backoff = sec * 1000;
      }
      this.handleRetry(batch, postNow, backoff);
    } else if (res.status >= 400 && res.status < 500) {
      const dropIds = new Set(batch.map(b => b.event.eventId));
      this.queue = this.queue.filter(e => !dropIds.has(e.event.eventId));
      this.totalBytes = this.queue.reduce((acc, e) => acc + e.size, 0);
    } else {
      const body = batchBody as BatchResponse | null;
      if (this.generation !== gen || this.disposed) return;
      if (body?.success === true && Array.isArray(body.data?.accepted)) {
        const sentIds = new Set(batch.map(entry => entry.event.eventId));
        const acked = new Set(body.data.accepted.filter(id => typeof id === 'string' && sentIds.has(id)));
        this.queue = this.queue.filter(e => !acked.has(e.event.eventId));
        this.totalBytes = this.queue.reduce((acc, e) => acc + e.size, 0);
        const unacked = batch.filter(b => !acked.has(b.event.eventId));
        if (unacked.length > 0) this.handleRetry(unacked, postNow, 1000);
      } else {
        const dropIds = new Set(batch.map(b => b.event.eventId));
        this.queue = this.queue.filter(e => !dropIds.has(e.event.eventId));
        this.totalBytes = this.queue.reduce((acc, e) => acc + e.size, 0);
      }
    }

    this.purge(this.now());
    this.scheduleNext(this.now());
  }

  private handleRetry(entries: QueueEntry[], now: number, baseBackoff: number): void {
    for (const e of entries) {
      if (e.attempts >= 3) continue;
      const backoff = Math.min(30_000, baseBackoff * Math.pow(2, Math.max(0, e.attempts - 1)));
      const remainingTTL = Math.max(0, 300_000 - (now - e.enqueuedAt));
      e.nextAt = now + Math.min(backoff, remainingTTL);
    }
  }

  private scheduleNext(now: number): void {
    if (this.disposed || !this.ready || this.queue.length === 0) return;
    let minDelay = Infinity;
    for (const e of this.queue) {
      if (e.attempts < 3) {
        minDelay = Math.min(minDelay, Math.max(0, e.nextAt - now));
      }
    }
    if (Number.isFinite(minDelay)) this.scheduleFlush(minDelay);
  }

  /** A disposed client must never be handed out again by the shared factory. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.resetSession();
    try {
      if (this.connectivityHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('online', this.connectivityHandler);
        window.removeEventListener('offline', this.connectivityHandler);
      }
    } catch { /* Disposal never throws into the caller. */ }
    this.connectivityHandler = null;
  }
}

let browserClient: TelemetryClient | null = null;

/**
 * Returns the shared client, or null when the server has telemetry switched
 * off. A null client means every caller's optional chaining is a no-op, so a
 * disabled deployment makes no requests and logs no failed resources.
 */
export function getBrowserTelemetryClient(): TelemetryClient | null {
  if (typeof window === 'undefined') return null;
  if (isTelemetryDisabledForSession()) {
    browserClient?.dispose();
    browserClient = null;
    return null;
  }
  if (!browserClient || browserClient.isDisposed) browserClient = new TelemetryClient();
  return browserClient;
}
