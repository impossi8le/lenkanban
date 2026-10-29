import { TELEMETRY_COVERAGE, TELEMETRY_SAMPLING_POLICY, type TelemetryReportEvent, type TelemetrySummary } from './report-contract';
import { isTelemetryScreen, isTelemetryUiAction, TELEMETRY_SERVER_ROUTES } from './catalog';
import { isBreadcrumbName } from './breadcrumbs';

const key = (...parts: string[]) => JSON.stringify(parts);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
function timestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

/** Counts only the explicitly instrumented catalog within a bounded received window. */
export function summarizeTelemetryEvents(
  rows: readonly TelemetryReportEvent[],
  window: { from: string; to: string; timezone: 'UTC' },
  truncated: boolean,
  limit: number,
): TelemetrySummary {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 10000;
  const incomplete = truncated || rows.length > cap;
  const from = timestamp(window.from), to = timestamp(window.to);
  const seen = new Set<string>(), actions = new Set<string>(), sessions = new Set<string>();
  const actors = new Set<string>(), commits = new Set<string>(), failures = new Set<string>();
  const cancellations = new Set<string>(), renders = new Set<string>();
  const requests = new Map<string, number>();
  type LatencySource = 'client.observed' | 'server.handler';
  const latency = new Map<string, { route: string; source: LatencySource; observations: Map<string, number> }>();
  const measure = (route: string, source: LatencySource, identity: string, duration: unknown) => {
    // Missing/invalid measurements are not zero. No SQL/HTTP stage is inferred.
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 86_400_000) return;
    const groupKey = key(route, source);
    const group = latency.get(groupKey) ?? { route, source, observations: new Map<string, number>() };
    group.observations.set(identity, Math.max(group.observations.get(identity) ?? 0, duration));
    latency.set(groupKey, group);
  };
  const screens = new Map<string, Set<string>>(), features = new Map<string, Set<string>>();
  const count = (groups: Map<string, Set<string>>, label: string, identity: string) => {
    const values = groups.get(label) ?? new Set<string>();
    values.add(identity);
    groups.set(label, values);
  };
  let latest: string | null = null;
  for (const row of rows.slice(0, cap)) {
    if (!row || !row.payload || row.payload.synthetic === true || row.payload.schemaVersion !== 1 || !nonempty(row.actorKey) || !nonempty(row.eventId)) continue;
    const received = timestamp(row.receivedAt);
    if (received === null || timestamp(row.occurredAt) === null || from === null || to === null || received < from || received >= to) continue;
    const p = row.payload;
    const client = row.source === 'client' && row.trust === 'client_reported';
    // Any catalogued action counts; an unknown action is not usage.
    const catalogued = isTelemetryUiAction(p.action);
    const checklist = p.action === 'task.checklist.toggle';
    const clientAction = client && nonempty(row.actionId) && nonempty(row.sessionId);
    const intent = row.event === 'ui.action' && row.category === 'usage' && clientAction && catalogued
      && (p.action !== 'screen.view' || isTelemetryScreen(p.screen));
    const result = row.event === 'client.request.result' && row.category === 'diagnostic' && clientAction && catalogued
      && ['success', 'failure', 'cancelled', 'rejected', 'conflict'].includes(p.outcome ?? '');
    const render = row.event === 'client.render.failed' && row.category === 'diagnostic' && clientAction
      && p.action === 'app.render' && p.errorCode === 'RENDER_FAILURE' && nonempty(row.errorId);
    const report = row.event === 'client.problem.reported' && row.category === 'diagnostic' && clientAction
      && p.action === 'app.problem.report' && nonempty(row.errorId);
    const commit = row.event === 'task.checklist.updated' && row.category === 'usage' && row.source === 'server'
      && row.trust === 'authoritative' && checklist && nonempty(row.operationId);
    const request = (row.event === 'api.request.completed' || row.event === 'api.request.failed')
      && row.category === 'diagnostic' && row.source === 'server' && row.trust === 'server_observed'
      && nonempty(row.requestId) && TELEMETRY_SERVER_ROUTES.has(p.route ?? '')
      && typeof p.statusCode === 'number' && Number.isInteger(p.statusCode) && p.statusCode >= 100 && p.statusCode <= 599;
    const clientRequest = clientAction && row.event === 'client.breadcrumb' && row.category === 'diagnostic'
      && p.action === 'app.breadcrumb' && p.kind === 'request' && isBreadcrumbName('request', p.name)
      && typeof p.durationMs === 'number' && Number.isFinite(p.durationMs)
      && p.durationMs >= 0 && p.durationMs <= 86_400_000;
    if (!intent && !result && !render && !report && !commit && !request && !clientRequest) continue;
    if (latest === null || received > Date.parse(latest)) latest = row.receivedAt;
    const eventKey = key(row.actorKey, row.eventId);
    // Server request dedup remains conservative when repeated observations differ.
    if (request) {
      const requestKey = key(row.actorKey, row.requestId!);
      requests.set(requestKey, Math.max(requests.get(requestKey) ?? 0, p.statusCode!));
      // This store's server bridge writes handler measurements on five routes.
      // The separate physical HTTP observer remains in Pino, outside this scan.
      measure(p.route!, 'server.handler', requestKey, p.durationMs);
    }
    if (clientRequest) measure(p.name!, 'client.observed', eventKey, p.durationMs);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    if (intent) {
      actions.add(key(row.actorKey, row.actionId!));
      sessions.add(key(row.actorKey, row.sessionId!));
      actors.add(row.actorKey);
      if (p.action === 'screen.view') count(screens, p.screen!, key(row.actorKey, row.actionId!));
      else count(features, p.action!, key(row.actorKey, row.actionId!));
    }
    if (commit) commits.add(key(row.actorKey, row.operationId!));
    if (result && p.outcome === 'failure') failures.add(key(row.actorKey, row.actionId!));
    if (result && p.outcome === 'cancelled') cancellations.add(key(row.actorKey, row.actionId!));
    if (render) renders.add(key(row.actorKey, row.errorId!));
  }
  const statuses = [...requests.values()];
  const failed = statuses.filter(status => status >= 500).length;
  const latencyGroups = [...latency.values()].sort((a, b) => a.route.localeCompare(b.route) || a.source.localeCompare(b.source))
    .map(group => {
      const values = [...group.observations.values()].sort((a, b) => a - b);
      // Nearest rank; for tiny samples high percentiles legitimately equal max.
      const percentile = (fraction: number) => values[Math.ceil(fraction * values.length) - 1];
      return { route: group.route, source: group.source, count: values.length,
        p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
        maxMs: values[values.length - 1], slowCount: values.filter(value => value >= 1000).length };
    });
  return {
    requestLatency: { coverage: 'partial_stored_observations', percentileMethod: 'nearest_rank',
      slowThresholdMs: 1000, groups: latencyGroups },
    window: { ...window },
    collection: { state: 'available', coverage: [...TELEMETRY_COVERAGE], observedRows: seen.size,
      limit: cap, truncated: incomplete, latestReceivedAt: latest, collectorHealth: 'not_measured',
      sampling: TELEMETRY_SAMPLING_POLICY },
    usage: { uniqueActions: actions.size, clientSessions: sessions.size, clientActors: actors.size, committedChanges: commits.size,
      screens: [...screens].sort(([a], [b]) => a.localeCompare(b)).map(([screen, values]) => ({ screen, uniqueActions: values.size })),
      features: [...features].sort(([a], [b]) => a.localeCompare(b)).map(([action, values]) => ({ action, uniqueActions: values.size })) },
    diagnostics: { requestCount: requests.size, failedRequestCount: failed,
      rejectedRequestCount: statuses.filter(status => status >= 400 && status < 500 && status !== 409).length,
      conflictRequestCount: statuses.filter(status => status === 409).length,
      failureRate: incomplete || requests.size === 0 ? null : failed / requests.size,
      clientFailures: failures.size, clientCancellations: cancellations.size, renderFailures: renders.size },
  };
}
