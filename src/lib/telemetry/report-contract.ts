import type { TelemetryOutcome } from "./contract";
import type { ProblemReportReason, ProblemReportBreadcrumb } from "./problem-report-contract";
import type { TelemetryScreen } from "./catalog";

/** Collector sampling is independent of Sentry tracing/replay configuration. */
export const TELEMETRY_SAMPLING_POLICY = Object.freeze({
  mode: "none",
  rate: 1,
  metricBasis: "observed_events",
} as const);

/**
 * Actions with *confirmed* collection end to end. The versioned catalog in
 * `catalog.ts` accepts more names, but a name becomes coverage only once a
 * call site actually records it — an entry here is a claim about collection,
 * not about the contract's vocabulary.
 */
export const TELEMETRY_COVERAGE = [
  "task.checklist.toggle",
  "app.render",
  "screen.view",
  "board.view.change",
  "board.filter.change",
  "board.search",
  "task.create",
  "task.update",
  "task.move",
  "comment.create",
  "attachment.upload",
] as const;
export type TelemetryCategory = "usage" | "diagnostic";
export interface TelemetryReportFilters {
  from?: string;
  to?: string;
  projectId?: string;
  revision?: string;
  release?: string;
}
export interface TelemetryReportEvent {
  id: string;
  actorKey: string;
  eventId: string;
  receivedAt: string;
  occurredAt: string;
  event: string;
  category: TelemetryCategory;
  source: "client" | "server";
  trust: "client_reported" | "authoritative" | "server_observed";
  actionId?: string | null;
  requestId?: string | null;
  errorId?: string | null;
  operationId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  payload: {
    schemaVersion: 1;
    action?: string;
    seq?: number;
    outcome?: TelemetryOutcome;
    statusCode?: number;
    durationMs?: number;
    route?: string;
    method?: string;
    env?: string;
    revision?: string;
    release?: string;
    buildId?: string;
    /** Server-assigned provenance; synthetic records never enter reports. */
    synthetic?: boolean;
    traceId?: string;
    errorCode?: string;
    errorType?: string;
    kind?: string;
    name?: string;
    attempt?: number;
    state?: string;
    /** Closed catalog facets of a UI intent; never user-entered values. */
    screen?: string;
    view?: string;
    filter?: string;
    reason?: ProblemReportReason;
    breadcrumbs?: ProblemReportBreadcrumb[];
  };
}
export interface TelemetrySummary {
  /** Only persisted measurements in the existing bounded window, never all HTTP. */
  requestLatency?: {
    coverage: "partial_stored_observations";
    percentileMethod: "nearest_rank";
    slowThresholdMs: 1000;
    groups: {
      route: string;
      /** client.observed may be adapter or ResourceTiming request breadcrumbs. */
      source: "client.observed" | "server.handler";
      count: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      maxMs: number;
      slowCount: number;
    }[];
  };
  window: { from: string; to: string; timezone: "UTC" };
  collection: {
    state: "disabled" | "unconfigured" | "available";
    coverage: string[];
    observedRows: number;
    limit: number;
    truncated: boolean;
    latestReceivedAt: string | null;
    collectorHealth: "not_measured";
    /** Optional for compatibility with older report consumers/fixtures. */
    sampling?: typeof TELEMETRY_SAMPLING_POLICY;
  };
  usage: {
    uniqueActions: number; clientSessions: number; clientActors: number; committedChanges: number;
    /** Unique actor/action intentions per closed catalog label, not persisted successes. */
    screens?: { screen: string; uniqueActions: number }[];
    features?: { action: string; uniqueActions: number }[];
  };
  diagnostics: {
    requestCount: number;
    failedRequestCount: number;
    rejectedRequestCount: number;
    conflictRequestCount: number;
    failureRate: number | null;
    clientFailures: number;
    clientCancellations: number;
    renderFailures: number;
  };
}
export interface TelemetryEventsPage { items: TelemetryReportEvent[]; nextCursor: string | null }
export interface TelemetryErrorDetail {
  errorId: string;
  events: TelemetryReportEvent[];
  breadcrumbs: TelemetryReportEvent[];
  truncated: boolean;
  linkage: "server_verified" | "client_reported";
  problemReport?: { reportId: string; reason: ProblemReportReason; screen: TelemetryScreen; breadcrumbCount: number; comment?: string };
}

export interface ServerRequestTelemetry {
  requestId: string;
  actorId: string;
  actionId?: string;
  projectId?: string;
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  errorId?: string;
  /** Optional 32-hex technical trace, supplied by a trusted server boundary. */
  traceId?: string;
  event: "api.request.completed" | "api.request.failed";
  err?: unknown;
}
