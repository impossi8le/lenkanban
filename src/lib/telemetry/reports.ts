import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validCorrelationId } from "@/lib/telemetry-sanitize";
import { apiLogger } from "@/lib/logger";
import { readProblemReportComment } from "@/lib/problem-report-comment-store";
import { requireTelemetryConfiguration, telemetryConfiguration, TelemetryHttpError } from "./http";
import { safeAdminEvent, telemetryReportWindow } from "./store";
import { summarizeTelemetryEvents } from "./summarize";
import { isTelemetryScreen } from "./catalog";
import type {
  TelemetryErrorDetail, TelemetryReportEvent, TelemetryReportFilters, TelemetrySummary,
} from "./report-contract";

export const TELEMETRY_SUMMARY_LIMIT = 10_000;

/** Query strings never enter the audit record; route owners provide operation. */
export function auditTelemetryView(actorId: string, operation: "summary" | "events" | "error"): void {
  try {
    apiLogger.info({ schemaVersion: 1, event: "telemetry.admin.viewed", source: "server", actorId, operation });
  } catch { /* Audit sink failure cannot replace an authorized response. */ }
}

export function parseTelemetryReportFilters(params: URLSearchParams, extras: readonly string[] = []): TelemetryReportFilters {
  const allowed = new Set(["from", "to", "projectId", "revision", "release", ...extras]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1 || !params.get(key)) {
      throw new TelemetryHttpError(400, "TELEMETRY_INVALID_FILTER");
    }
  }
  return {
    ...(params.has("from") ? { from: params.get("from")! } : {}),
    ...(params.has("to") ? { to: params.get("to")! } : {}),
    ...(params.has("projectId") ? { projectId: params.get("projectId")! } : {}),
    ...(params.has("revision") ? { revision: params.get("revision")! } : {}),
    ...(params.has("release") ? { release: params.get("release")! } : {}),
  };
}

export async function getTelemetrySummary(filters: TelemetryReportFilters, now = new Date()): Promise<TelemetrySummary> {
  const { window, where } = telemetryReportWindow(filters, now);
  if (!telemetryConfiguration()) {
    const empty = summarizeTelemetryEvents([], window, false, TELEMETRY_SUMMARY_LIMIT);
    empty.collection.state = process.env.TELEMETRY_ENABLED === "true" ? "unconfigured" : "disabled";
    return empty;
  }
  const rows = await prisma.telemetryEvent.findMany({
    where, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: TELEMETRY_SUMMARY_LIMIT + 1,
  });
  // The scan itself is bounded too, including malformed historic rows. A cap
  // therefore remains visible even if some scanned records are rejected.
  const events = rows.slice(0, TELEMETRY_SUMMARY_LIMIT).map(safeAdminEvent).filter(row => row !== null);
  return summarizeTelemetryEvents(events, window, rows.length > TELEMETRY_SUMMARY_LIMIT, TELEMETRY_SUMMARY_LIMIT);
}

function pair(event: TelemetryReportEvent): Prisma.TelemetryEventWhereInput | null {
  if (!event.requestId || !event.actionId) return null;
  return { actorKey: event.actorKey, requestId: event.requestId, actionId: event.actionId };
}

function uniqueEvents(events: TelemetryReportEvent[]): TelemetryReportEvent[] {
  return [...new Map(events.map(event => [event.id, event])).values()];
}

export async function readTelemetryError(
  errorId: string, filters: TelemetryReportFilters = {}, now = new Date(),
): Promise<TelemetryErrorDetail | null> {
  requireTelemetryConfiguration();
  if (!validCorrelationId(errorId)) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_ERROR_ID");
  const { where } = telemetryReportWindow(filters, now);
  const seedsRaw = await prisma.telemetryEvent.findMany({
    where: { AND: [where, { errorId: errorId.toLowerCase() }] },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 101,
  });
  const safeSeeds = seedsRaw.slice(0, 100).map(safeAdminEvent).filter(event => event !== null);
  // A caller-selected report UUID is never allowed to hide a trusted server
  // error. Manual anchors with the same public number are otherwise ambiguous.
  let trustedServer = safeSeeds.some(event => event.source === "server" && event.trust === "server_observed"
    && event.errorId === errorId.toLowerCase() && event.requestId);
  const manualReports = safeSeeds.filter(event => event.event === "client.problem.reported");
  if (!trustedServer && manualReports.length > 0) {
    // A newer manual anchor cannot conceal an older trusted anchor beyond the
    // bounded mixed seed page. This read is only needed for manual reports.
    const serverRows = await prisma.telemetryEvent.findMany({
      where: { AND: [where, { errorId: errorId.toLowerCase(), source: "server", trust: "server_observed" }] },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 101,
    });
    const anchors = serverRows.slice(0, 100).map(safeAdminEvent).filter((event): event is TelemetryReportEvent => event !== null
      && event.source === "server" && event.trust === "server_observed"
      && event.errorId === errorId.toLowerCase() && Boolean(event.requestId));
    if (anchors.length > 0) { safeSeeds.push(...anchors); trustedServer = true; }
  }
  if (!trustedServer && (manualReports.length > 0 && seedsRaw.length > 100
    || new Set(manualReports.map(event => JSON.stringify([event.actorKey, event.eventId]))).size > 1)) {
    throw new TelemetryHttpError(409, "TELEMETRY_REPORT_ID_CONFLICT");
  }
  const seeds = trustedServer ? safeSeeds.filter(event => event.event !== "client.problem.reported") : safeSeeds;
  if (!seeds.length) return null;

  // A submitted report owns its immutable snapshot. A guessed error UUID must
  // neither add another actor's events nor promote the report to a server error.
  const report = seeds.find(event => event.event === "client.problem.reported");
  if (report && report.errorId && report.payload.reason && isTelemetryScreen(report.payload.screen)
    && report.payload.breadcrumbs) {
    const breadcrumbs: TelemetryReportEvent[] = report.payload.breadcrumbs.map(breadcrumb => ({
      id: `${report.id}-${breadcrumb.seq}`, actorKey: report.actorKey, eventId: breadcrumb.eventId,
      receivedAt: report.receivedAt, occurredAt: breadcrumb.occurredAt,
      event: "client.breadcrumb", category: "diagnostic", source: "client", trust: "client_reported",
      sessionId: report.sessionId, payload: { schemaVersion: 1, action: "app.breadcrumb",
        seq: breadcrumb.seq, kind: breadcrumb.kind, name: breadcrumb.name,
        ...(breadcrumb.outcome !== undefined ? { outcome: breadcrumb.outcome } : {}),
        ...(breadcrumb.statusCode !== undefined ? { statusCode: breadcrumb.statusCode } : {}),
        ...(breadcrumb.durationMs !== undefined ? { durationMs: breadcrumb.durationMs } : {}),
        ...(breadcrumb.attempt !== undefined ? { attempt: breadcrumb.attempt } : {}),
        ...(breadcrumb.state !== undefined ? { state: breadcrumb.state } : {}),
        ...(breadcrumb.errorCode !== undefined ? { errorCode: breadcrumb.errorCode } : {}) },
    }));
    const comment = await readProblemReportComment(report.id, report.errorId);
    return { errorId: report.errorId, events: [report], breadcrumbs, truncated: seedsRaw.length > 100,
      linkage: "client_reported", problemReport: { reportId: report.errorId, reason: report.payload.reason,
        screen: report.payload.screen, breadcrumbCount: breadcrumbs.length, ...(comment !== undefined ? { comment } : {}) } };
  }

  // A client-provided UUID is only a hint. Authority requires the same actor,
  // server request and action together, never an action/error UUID by itself.
  const candidates = seeds.map(pair).filter(value => value !== null);
  const anchorsRaw = candidates.length ? await prisma.telemetryEvent.findMany({
    where: { AND: [where, { source: "server", trust: "server_observed", errorId: errorId.toLowerCase(), OR: candidates }] },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 101,
  }) : [];
  const anchors = uniqueEvents([
    ...seeds.filter(event => event.source === "server" && event.trust === "server_observed"),
    ...anchorsRaw.map(safeAdminEvent).filter(event => event !== null),
  ]).filter(event => event.source === "server" && event.trust === "server_observed"
    && event.errorId === errorId.toLowerCase() && event.requestId);
  const links = anchors.map(pair).filter(value => value !== null);
  const linkedRaw = links.length ? await prisma.telemetryEvent.findMany({
    where: { AND: [where, { OR: links }] },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 101,
  }) : [];
  const linked = linkedRaw.map(safeAdminEvent).filter(event => event !== null);
  const combined = uniqueEvents([...seeds, ...anchors, ...linked]);

  const crumbSeeds = combined.filter(event => event.source === "client" && event.sessionId
    && typeof event.payload.seq === "number");
  const crumbConditions: Prisma.TelemetryEventWhereInput[] = crumbSeeds.map(event => ({
    actorKey: event.actorKey, sessionId: event.sessionId, source: "client", trust: "client_reported",
    payload: { path: ["seq"], lte: event.payload.seq! },
  }));
  const crumbsRaw = crumbConditions.length ? await prisma.telemetryEvent.findMany({
    where: { AND: [where, { OR: crumbConditions }] },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 41,
  }) : [];
  const breadcrumbs = crumbsRaw.slice(0, 40).map(safeAdminEvent).filter(event => event !== null)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || (a.payload.seq ?? 0) - (b.payload.seq ?? 0) || a.id.localeCompare(b.id));
  return {
    errorId: errorId.toLowerCase(), events: combined.slice(0, 100), breadcrumbs,
    truncated: seedsRaw.length > 100 || anchorsRaw.length > 100 || linkedRaw.length > 100 || combined.length > 100 || crumbsRaw.length > 40,
    linkage: anchors.length ? "server_verified" : "client_reported",
  };
}
