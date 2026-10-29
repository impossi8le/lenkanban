import { validCorrelationId } from '@/lib/telemetry-sanitize';
import { isProblemReportReason, parseProblemReportBreadcrumbs, type ProblemReportReason, type ProblemReportBreadcrumb } from './problem-report-contract';
import {
  isBreadcrumbErrorCode,
  isBreadcrumbKind,
  isBreadcrumbName,
  isBreadcrumbOutcome,
  isConnectivityState,
  validTraceId,
  type BreadcrumbErrorCode,
  type BreadcrumbKind,
  type ConnectivityState,
} from './breadcrumbs';
import {
  isTelemetryFilter,
  isTelemetryScreen,
  isTelemetryUiAction,
  isTelemetryView,
  type TelemetryFilter,
  type TelemetryScreen,
  type TelemetryUiAction,
  type TelemetryView,
} from './catalog';

export const TELEMETRY_ACTION = 'task.checklist.toggle';
export const TELEMETRY_ROUTE = '/api/tasks/:id/checklist/:itemId';

export type TelemetryOutcome = 'success' | 'rejected' | 'conflict' | 'failure' | 'cancelled';

export type ClientTelemetryEvent = {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  actionId: string;
  occurredAt: string;
  seq: number;
  traceId?: string;
} & (
  | {
      event: 'ui.action';
      action: TelemetryUiAction;
      /** Required for `screen.view`, forbidden for every other action. */
      screen?: TelemetryScreen;
      /** Required for `board.view.change`, forbidden for every other action. */
      view?: TelemetryView;
      /** Required for `board.filter.change`, forbidden for every other action. */
      filter?: TelemetryFilter;
    }
  | { event: 'client.render.failed'; action: 'app.render'; errorId: string; errorCode: 'RENDER_FAILURE' }
  | { event: 'client.problem.reported'; action: 'app.problem.report'; errorId: string;
      reason: ProblemReportReason; screen: TelemetryScreen; breadcrumbs: ProblemReportBreadcrumb[] }
  | {
      event: 'client.request.result';
      action: TelemetryUiAction;
      outcome: TelemetryOutcome;
      durationMs: number;
      statusCode?: number;
      requestId?: string;
      errorId?: string;
      errorCode?: BreadcrumbErrorCode;
    }
  | {
      event: 'client.breadcrumb';
      action: 'app.breadcrumb';
      kind: BreadcrumbKind;
      name: string;
      outcome?: TelemetryOutcome;
      statusCode?: number;
      durationMs?: number;
      attempt?: number;
      state?: ConnectivityState;
      errorCode?: BreadcrumbErrorCode;
    }
);

const PRIVILEGED_KEYS: readonly string[] = ['actorId', 'actorKey', 'source', 'trust', 'receivedAt', 'category'];
const FORBIDDEN_UI_KEYS: readonly string[] = ['outcome', 'durationMs', 'statusCode', 'requestId', 'errorId', 'status', 'duration', 'request', 'error'];
const RESULT_FORBIDDEN_KEYS: readonly string[] = ['screen', 'view', 'filter'];

type PropCheck = { state: 'missing' } | { state: 'invalid' } | { state: 'valid'; value: unknown };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasPrivilegedKey(obj: object): boolean {
  for (let i = 0; i < PRIVILEGED_KEYS.length; i++) {
    try {
      if (Object.getOwnPropertyDescriptor(obj, PRIVILEGED_KEYS[i]) !== undefined) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function getOwnData(obj: object, key: string): PropCheck {
  try {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (!d) return { state: 'missing' };
    if (d.get !== undefined || d.set !== undefined || !('value' in d)) return { state: 'invalid' };
    return { state: 'valid', value: d.value };
  } catch {
    return { state: 'invalid' };
  }
}

function parseUuid(v: unknown): string | null {
  return typeof v === 'string' && validCorrelationId(v) ? v.toLowerCase() : null;
}

function isValidUtcIso(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return false;
  try {
    return new Date(ms).toISOString() === v;
  } catch {
    return false;
  }
}

function isOutcome(v: unknown): v is TelemetryOutcome {
  return v === 'success' || v === 'rejected' || v === 'conflict' || v === 'failure' || v === 'cancelled';
}

type OptionalEnum<T extends string> =
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'valid'; value: T };

/** Reads an optional closed-vocabulary field without evaluating getters. */
function optionalEnum<T extends string>(obj: object, key: string, guard: (v: unknown) => v is T): OptionalEnum<T> {
  const descriptor = getOwnData(obj, key);
  if (descriptor.state === 'invalid') return { state: 'invalid' };
  if (descriptor.state === 'missing') return { state: 'missing' };
  return guard(descriptor.value) ? { state: 'valid', value: descriptor.value } : { state: 'invalid' };
}

export function parseClientTelemetryEvent(value: unknown): ClientTelemetryEvent | null {
  try {
    if (!isObject(value) || hasPrivilegedKey(value)) return null;

    const vVer = getOwnData(value, 'schemaVersion');
    if (vVer.state !== 'valid' || vVer.value !== 1) return null;

    const vEvId = getOwnData(value, 'eventId');
    const eventId = vEvId.state === 'valid' ? parseUuid(vEvId.value) : null;
    if (!eventId) return null;

    const vSesId = getOwnData(value, 'sessionId');
    const sessionId = vSesId.state === 'valid' ? parseUuid(vSesId.value) : null;
    if (!sessionId) return null;

    const vActId = getOwnData(value, 'actionId');
    const actionId = vActId.state === 'valid' ? parseUuid(vActId.value) : null;
    if (!actionId) return null;

    const vAct = getOwnData(value, 'action');
    if (vAct.state !== 'valid') return null;

    const vOcc = getOwnData(value, 'occurredAt');
    if (vOcc.state !== 'valid' || !isValidUtcIso(vOcc.value)) return null;
    const occurredAt = vOcc.value;

    const vSeq = getOwnData(value, 'seq');
    if (vSeq.state !== 'valid' || typeof vSeq.value !== 'number' || !Number.isSafeInteger(vSeq.value) || vSeq.value < 0) {
      return null;
    }
    const seq = vSeq.value;

    let traceId: string | undefined;
    const vTrace = getOwnData(value, 'traceId');
    if (vTrace.state === 'invalid') return null;
    if (vTrace.state === 'valid') {
      if (!validTraceId(vTrace.value)) return null;
      traceId = vTrace.value.toLowerCase();
    }

    const vEv = getOwnData(value, 'event');
    if (vEv.state !== 'valid') return null;

    if (vEv.value === 'client.problem.reported' && vAct.value === 'app.problem.report') {
      const allowed = new Set(['schemaVersion', 'eventId', 'sessionId', 'actionId', 'occurredAt', 'seq',
        'traceId', 'event', 'action', 'errorId', 'reason', 'screen', 'breadcrumbs']);
      if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).some(key => !allowed.has(key))) return null;
      const vError = getOwnData(value, 'errorId'), vReason = getOwnData(value, 'reason');
      const vScreen = getOwnData(value, 'screen'), vBreadcrumbs = getOwnData(value, 'breadcrumbs');
      const errorId = vError.state === 'valid' ? parseUuid(vError.value) : null;
      if (!errorId || vReason.state !== 'valid' || !isProblemReportReason(vReason.value)
        || vScreen.state !== 'valid' || !isTelemetryScreen(vScreen.value) || vBreadcrumbs.state !== 'valid') return null;
      const breadcrumbs = parseProblemReportBreadcrumbs(vBreadcrumbs.value, { seq, occurredAt });
      if (!breadcrumbs) return null;
      return { schemaVersion: 1, eventId, sessionId, actionId, occurredAt, seq,
        ...(traceId !== undefined ? { traceId } : {}), event: 'client.problem.reported', action: 'app.problem.report',
        errorId, reason: vReason.value, screen: vScreen.value, breadcrumbs };
    }

    if (vEv.value === 'client.breadcrumb' && vAct.value === 'app.breadcrumb') {
      const vKind = getOwnData(value, 'kind');
      if (vKind.state !== 'valid' || !isBreadcrumbKind(vKind.value)) return null;
      const kind = vKind.value;
      const vName = getOwnData(value, 'name');
      if (vName.state !== 'valid' || typeof vName.value !== 'string' || !isBreadcrumbName(kind, vName.value)) return null;
      const name = vName.value;

      let outcome: TelemetryOutcome | undefined;
      const vOut = getOwnData(value, 'outcome');
      if (vOut.state === 'invalid') return null;
      if (vOut.state === 'valid') {
        if (!isBreadcrumbOutcome(vOut.value)) return null;
        outcome = vOut.value;
      }

      let statusCode: number | undefined;
      const vStatus = getOwnData(value, 'statusCode');
      if (vStatus.state === 'invalid') return null;
      if (vStatus.state === 'valid') {
        if (typeof vStatus.value !== 'number' || !Number.isInteger(vStatus.value) || vStatus.value < 100 || vStatus.value > 599) {
          return null;
        }
        statusCode = vStatus.value;
      }

      let durationMs: number | undefined;
      const vDur = getOwnData(value, 'durationMs');
      if (vDur.state === 'invalid') return null;
      if (vDur.state === 'valid') {
        if (typeof vDur.value !== 'number' || !Number.isFinite(vDur.value) || vDur.value < 0 || vDur.value > 86400000) {
          return null;
        }
        durationMs = vDur.value;
      }

      let attempt: number | undefined;
      const vAttempt = getOwnData(value, 'attempt');
      if (vAttempt.state === 'invalid') return null;
      if (vAttempt.state === 'valid') {
        if (typeof vAttempt.value !== 'number' || !Number.isInteger(vAttempt.value) || vAttempt.value < 1 || vAttempt.value > 3) {
          return null;
        }
        attempt = vAttempt.value;
      }

      let state: ConnectivityState | undefined;
      const vState = getOwnData(value, 'state');
      if (vState.state === 'invalid') return null;
      if (vState.state === 'valid') {
        if (kind !== 'connectivity' || !isConnectivityState(vState.value)) return null;
        const expected = name === 'offline' ? 'offline' : 'online';
        if (vState.value !== expected) return null;
        state = vState.value;
      } else if (kind === 'connectivity') {
        return null;
      }

      let errorCode: BreadcrumbErrorCode | undefined;
      const vCode = getOwnData(value, 'errorCode');
      if (vCode.state === 'invalid') return null;
      if (vCode.state === 'valid') {
        if (!isBreadcrumbErrorCode(vCode.value)) return null;
        errorCode = vCode.value;
      }

      const crumb: Extract<ClientTelemetryEvent, { event: 'client.breadcrumb' }> = {
        schemaVersion: 1, eventId, sessionId, actionId, action: 'app.breadcrumb', occurredAt, seq,
        event: 'client.breadcrumb', kind, name,
      };
      if (traceId !== undefined) crumb.traceId = traceId;
      if (outcome !== undefined) crumb.outcome = outcome;
      if (statusCode !== undefined) crumb.statusCode = statusCode;
      if (durationMs !== undefined) crumb.durationMs = durationMs;
      if (attempt !== undefined) crumb.attempt = attempt;
      if (state !== undefined) crumb.state = state;
      if (errorCode !== undefined) crumb.errorCode = errorCode;
      return crumb;
    }
    if (vAct.value === 'app.breadcrumb') return null;

    if (vEv.value === 'client.render.failed' && vAct.value === 'app.render') {
      for (const key of ['outcome', 'durationMs', 'statusCode', 'requestId']) {
        if (Object.getOwnPropertyDescriptor(value, key) !== undefined) return null;
      }
      const rawErrorId = getOwnData(value, 'errorId');
      const errorId = rawErrorId.state === 'valid' ? parseUuid(rawErrorId.value) : null;
      const code = getOwnData(value, 'errorCode');
      if (!errorId || code.state !== 'valid' || code.value !== 'RENDER_FAILURE') return null;
      return { schemaVersion: 1, eventId, sessionId, actionId, action: 'app.render', occurredAt, seq,
        ...(traceId !== undefined ? { traceId } : {}),
        event: 'client.render.failed', errorId, errorCode: 'RENDER_FAILURE' };
    }
    if (vEv.value === 'ui.action') {
      if (!isTelemetryUiAction(vAct.value)) return null;
      const action = vAct.value;
      for (let i = 0; i < FORBIDDEN_UI_KEYS.length; i++) {
        try {
          if (Object.getOwnPropertyDescriptor(value, FORBIDDEN_UI_KEYS[i]) !== undefined) return null;
        } catch {
          return null;
        }
      }
      const screen = optionalEnum(value, 'screen', isTelemetryScreen);
      const view = optionalEnum(value, 'view', isTelemetryView);
      const filter = optionalEnum(value, 'filter', isTelemetryFilter);
      if (screen.state === 'invalid' || view.state === 'invalid' || filter.state === 'invalid') return null;
      if (action === 'screen.view') {
        if (screen.state !== 'valid' || view.state !== 'missing' || filter.state !== 'missing') return null;
      } else if (action === 'board.view.change') {
        if (view.state !== 'valid' || screen.state !== 'missing' || filter.state !== 'missing') return null;
      } else if (action === 'board.filter.change') {
        if (filter.state !== 'valid' || screen.state !== 'missing' || view.state !== 'missing') return null;
      } else if (screen.state !== 'missing' || view.state !== 'missing' || filter.state !== 'missing') {
        return null;
      }
      const intent: Extract<ClientTelemetryEvent, { event: 'ui.action' }> = {
        schemaVersion: 1, eventId, sessionId, actionId, action, occurredAt, seq,
        ...(traceId !== undefined ? { traceId } : {}), event: 'ui.action',
      };
      if (screen.state === 'valid') intent.screen = screen.value;
      if (view.state === 'valid') intent.view = view.value;
      if (filter.state === 'valid') intent.filter = filter.value;
      return intent;
    }

    if (vEv.value === 'client.request.result') {
      if (!isTelemetryUiAction(vAct.value)) return null;
      const action = vAct.value;
      for (let i = 0; i < RESULT_FORBIDDEN_KEYS.length; i++) {
        try {
          if (Object.getOwnPropertyDescriptor(value, RESULT_FORBIDDEN_KEYS[i]) !== undefined) return null;
        } catch {
          return null;
        }
      }
      const vOut = getOwnData(value, 'outcome');
      if (vOut.state !== 'valid' || !isOutcome(vOut.value)) return null;
      const outcome = vOut.value;

      const vDur = getOwnData(value, 'durationMs');
      if (vDur.state !== 'valid' || typeof vDur.value !== 'number' || !Number.isFinite(vDur.value) || vDur.value < 0 || vDur.value > 86400000) {
        return null;
      }
      const durationMs = vDur.value;

      let statusCode: number | undefined;
      const vStatus = getOwnData(value, 'statusCode');
      if (vStatus.state === 'invalid') return null;
      if (vStatus.state === 'valid') {
        if (typeof vStatus.value !== 'number' || !Number.isInteger(vStatus.value) || vStatus.value < 100 || vStatus.value > 599) {
          return null;
        }
        statusCode = vStatus.value;
      }

      let requestId: string | undefined;
      const vReq = getOwnData(value, 'requestId');
      if (vReq.state === 'invalid') return null;
      if (vReq.state === 'valid') {
        const parsed = parseUuid(vReq.value);
        if (!parsed) return null;
        requestId = parsed;
      }

      let errorId: string | undefined;
      const vErr = getOwnData(value, 'errorId');
      if (vErr.state === 'invalid') return null;
      if (vErr.state === 'valid') {
        const parsed = parseUuid(vErr.value);
        if (!parsed) return null;
        errorId = parsed;
      }

      let errorCode: BreadcrumbErrorCode | undefined;
      const vCode = getOwnData(value, 'errorCode');
      if (vCode.state === 'invalid') return null;
      if (vCode.state === 'valid') {
        if (!isBreadcrumbErrorCode(vCode.value)) return null;
        errorCode = vCode.value;
      }

      const res: ClientTelemetryEvent = {
        schemaVersion: 1, eventId, sessionId, actionId, action, occurredAt, seq,
        ...(traceId !== undefined ? { traceId } : {}),
        event: 'client.request.result', outcome, durationMs,
      };
      if (statusCode !== undefined) res.statusCode = statusCode;
      if (requestId !== undefined) res.requestId = requestId;
      if (errorId !== undefined) res.errorId = errorId;
      if (errorCode !== undefined) res.errorCode = errorCode;
      return res;
    }

    return null;
  } catch {
    return null;
  }
}

export function parseClientTelemetryBatch(value: unknown): { sessionId: string; sessionToken: string; events: ClientTelemetryEvent[] } | null {
  try {
    if (!isObject(value) || hasPrivilegedKey(value)) return null;

    const vSes = getOwnData(value, 'sessionId');
    const sessionId = vSes.state === 'valid' ? parseUuid(vSes.value) : null;
    if (!sessionId) return null;

    const token = getOwnData(value, 'sessionToken');
    if (token.state !== 'valid' || typeof token.value !== 'string' || !/^v1\.[0-9]{13}\.[a-f0-9]{64}$/.test(token.value)) return null;
    const vEvs = getOwnData(value, 'events');
    if (vEvs.state !== 'valid' || !Array.isArray(vEvs.value)) return null;
    const list = vEvs.value;
    const length = getOwnData(list, 'length');
    if (length.state !== 'valid' || typeof length.value !== 'number' || !Number.isInteger(length.value) || length.value < 1 || length.value > 10) return null;

    const events: ClientTelemetryEvent[] = [];
    for (let i = 0; i < length.value; i++) {
      let desc: PropertyDescriptor | undefined;
      try {
        desc = Object.getOwnPropertyDescriptor(list, String(i));
      } catch {
        return null;
      }
      if (!desc || desc.get !== undefined || desc.set !== undefined || !('value' in desc)) return null;
      const item = parseClientTelemetryEvent(desc.value);
      if (!item || item.sessionId !== sessionId) return null;
      events.push(item);
    }
    return { sessionId, sessionToken: token.value, events };
  } catch {
    return null;
  }
}

export function parseTelemetrySessionStart(value: unknown): { kind: 'session.start'; sessionId: string } | null {
  try {
    if (!isObject(value) || hasPrivilegedKey(value)) return null;

    const vKind = getOwnData(value, 'kind');
    if (vKind.state !== 'valid' || vKind.value !== 'session.start') return null;

    const vSes = getOwnData(value, 'sessionId');
    const sessionId = vSes.state === 'valid' ? parseUuid(vSes.value) : null;
    if (!sessionId) return null;

    return { kind: 'session.start', sessionId };
  } catch {
    return null;
  }
}
