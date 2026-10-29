import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma, TelemetryEvent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
import { safeError, validCorrelationId } from "@/lib/telemetry-sanitize";
import { TELEMETRY_SERVER_ROUTES } from "./catalog";
import type { ServerRequestTelemetry, TelemetryReportEvent, TelemetryReportFilters } from "./report-contract";
import {
  parseClientTelemetryBatch,
  parseClientTelemetryEvent,
  TELEMETRY_ACTION,
  TELEMETRY_ROUTE,
  type ClientTelemetryEvent,
} from "./contract";
import { validTraceId } from "./breadcrumbs";
import { parseProblemReportBreadcrumbs } from "./problem-report-contract";
import {
  telemetryConfiguration,
  requireTelemetryConfiguration,
  TelemetryHttpError,
  TELEMETRY_RETENTION_MS,
  TELEMETRY_SESSION_MS,
} from "./http";

type ClientTelemetryBatch = NonNullable<ReturnType<typeof parseClientTelemetryBatch>>;
const EVENT_CLOCK_WINDOW_MS = 5 * 60 * 1000;
const internalId = /^[a-zA-Z0-9_-]{1,128}$/;
const revisionPattern = /^[a-fA-F0-9]{7,64}$/;
const releasePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,127}$/;
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const errorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError", "UnknownError"]);

function requestOutcome(event: string, status: number) {
  return event === "api.request.failed" || status >= 500 ? "failure" as const
    : status === 409 ? "conflict" as const : status >= 400 ? "rejected" as const : "success" as const;
}

function requestErrorCode(event: string, status: number): string | undefined {
  if (event === "api.request.failed") return "UNHANDLED_EXCEPTION";
  if (status >= 500) return "HTTP_5XX";
  if (status === 409) return "HTTP_CONFLICT";
  if (status >= 400) return "HTTP_REJECTED";
  return undefined;
}

/** Release/build identifiers come from deployment environment, never the client. */
function buildMetadata(): { release?: string; buildId?: string; revision?: string; synthetic?: boolean } {
  const release = process.env.SENTRY_RELEASE;
  const buildId = process.env.BUILD_ID || process.env.NEXT_BUILD_ID;
  const revision = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT;
  return {
    ...(typeof release === "string" && releasePattern.test(release) ? { release } : {}),
    ...(typeof buildId === "string" && releasePattern.test(buildId) ? { buildId } : {}),
    ...(typeof revision === "string" && revisionPattern.test(revision) ? { revision: revision.toLowerCase() } : {}),
    ...(process.env.TELEMETRY_SYNTHETIC === "true" ? { synthetic: true } : {}),
  };
}

/** Sanitization and persistence are both inside the nonthrowing boundary. */
export async function recordServerRequestTelemetry(input: ServerRequestTelemetry): Promise<void> {
  try {
    if (!telemetryConfiguration()) return;
    const actorKey = telemetryActorKey(input.actorId);
    if (!actorKey || !validCorrelationId(input.requestId)
      || !TELEMETRY_SERVER_ROUTES.has(input.route) || !methods.has(input.method)
      || !Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599
      || !Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 86_400_000
      || (input.event !== "api.request.completed" && input.event !== "api.request.failed")
      || (input.actionId !== undefined && !validCorrelationId(input.actionId))
      || (input.errorId !== undefined && !validCorrelationId(input.errorId))
      || (input.traceId !== undefined && !validTraceId(input.traceId))
      || (input.projectId !== undefined && !internalId.test(input.projectId))) return;
    const now = new Date();
    const payload: Record<string, Prisma.InputJsonValue> = {
      schemaVersion: 1, route: input.route, method: input.method,
      statusCode: input.statusCode, durationMs: input.durationMs,
      outcome: requestOutcome(input.event, input.statusCode),
    };
    const errorCode = requestErrorCode(input.event, input.statusCode);
    if (errorCode) payload.errorCode = errorCode;
    if (input.err !== undefined) payload.errorType = safeError(input.err).type;
    if (input.traceId !== undefined) payload.traceId = input.traceId.toLowerCase();
    if (["development", "test", "production"].includes(process.env.NODE_ENV ?? "")) payload.env = process.env.NODE_ENV!;
    Object.assign(payload, buildMetadata());
    await prisma.telemetryEvent.createMany({
      data: [{
        actorKey, eventId: randomUUID(), requestId: input.requestId.toLowerCase(),
        ...(input.actionId ? { actionId: input.actionId.toLowerCase() } : {}),
        ...(input.errorId ? { errorId: input.errorId.toLowerCase() } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        receivedAt: now, occurredAt: now, event: input.event,
        category: "diagnostic", source: "server", trust: "server_observed", payload,
      }],
      skipDuplicates: true,
    });
  } catch { /* Collection cannot affect an API response or leak the thrown value. */ }
}

export function telemetryActorKey(actorId: string): string | null {
  const configuration = telemetryConfiguration();
  if (!configuration || typeof actorId !== "string" || !internalId.test(actorId)) return null;
  return `v1:${createHmac("sha256", configuration.hmacSecret)
    .update(`telemetry-actor|${actorId}`)
    .digest("hex")}`;
}

function sessionMac(sessionId: string, actorKey: string, expiresMs: string): string | null {
  const configuration = telemetryConfiguration();
  if (!configuration) return null;
  return createHmac("sha256", configuration.hmacSecret)
    .update(`telemetry-session|${sessionId}|${actorKey}|${expiresMs}`)
    .digest("hex");
}

function sessionToken(sessionId: string, actorKey: string, expiresAt: Date): string {
  const expires = String(expiresAt.getTime()).padStart(13, "0");
  const mac = sessionMac(sessionId, actorKey, expires);
  if (!mac || !/^[0-9]{13}$/.test(expires)) throw new TelemetryHttpError(503, "TELEMETRY_UNAVAILABLE");
  return `v1.${expires}.${mac}`;
}

function verifySessionToken(sessionId: string, actorKey: string, token: string, now: Date): number | null {
  const parts = /^v1\.([0-9]{13})\.([a-f0-9]{64})$/.exec(token);
  if (!parts) return null;
  const expires = Number(parts[1]);
  if (!Number.isFinite(now.getTime()) || expires <= now.getTime()
    || expires > now.getTime() + TELEMETRY_SESSION_MS + EVENT_CLOCK_WINDOW_MS) return null;
  const expected = sessionMac(sessionId, actorKey, parts[1]);
  if (!expected || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts[2], "hex"))) return null;
  return expires;
}

export async function consumeTelemetryRateLimits(actorKey: string, now = new Date()): Promise<void> {
  requireTelemetryConfiguration();
  // Both shared budgets commit together; an actor rejection rolls back the
  // global increment. Every replica acquires these rows in the same order.
  await prisma.$transaction(async tx => {
    await consumeRateLimit({ database: tx, key: "telemetry:global:deployment", limit: 600, windowMs: 60_000, now });
    await consumeRateLimit({ database: tx, key: `telemetry:actor:${actorKey}`, limit: 60, windowMs: 60_000, now });
  });
}

export async function startTelemetrySession(actorKey: string, sessionId: string, now = new Date()): Promise<{
  sessionId: string;
  expiresAt: string;
  sessionToken: string;
}> {
  requireTelemetryConfiguration();
  if (!validCorrelationId(sessionId)) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_SESSION");
  const id = sessionId.toLowerCase();
  const session = await prisma.$transaction(async tx => {
    // Concurrent initializations of one UUID have exactly one winner. The loser
    // reads the winning binding and can neither overwrite nor extend its expiry.
    await tx.telemetrySession.createMany({
      data: [{ id, actorKey, createdAt: now, expiresAt: new Date(now.getTime() + TELEMETRY_SESSION_MS) }],
      skipDuplicates: true,
    });
    const binding = await tx.telemetrySession.findUnique({ where: { id } });
    if (!binding || binding.actorKey !== actorKey || binding.expiresAt <= now) {
      throw new TelemetryHttpError(401, "TELEMETRY_SESSION_REJECTED");
    }
    return binding;
  });
  return {
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    sessionToken: sessionToken(session.id, actorKey, session.expiresAt),
  };
}

function clientPayload(event: ClientTelemetryEvent): Prisma.InputJsonObject {
  const payload: Record<string, Prisma.InputJsonValue> = { schemaVersion: 1, action: event.action, seq: event.seq };
  if (event.traceId !== undefined) payload.traceId = event.traceId;
  // Closed per-action facets only: screen/view/filter names, never user values.
  if (event.event === "ui.action") {
    if (event.screen !== undefined) payload.screen = event.screen;
    if (event.view !== undefined) payload.view = event.view;
    if (event.filter !== undefined) payload.filter = event.filter;
  }
  if (event.event === "client.request.result") {
    payload.outcome = event.outcome;
    payload.durationMs = event.durationMs;
    if (event.statusCode !== undefined) payload.statusCode = event.statusCode;
    if (event.errorCode !== undefined) payload.errorCode = event.errorCode;
  }
  if (event.event === "client.render.failed") payload.errorCode = "RENDER_FAILURE";
  if (event.event === "client.problem.reported") {
    payload.reason = event.reason;
    payload.screen = event.screen;
    payload.breadcrumbs = event.breadcrumbs.map(breadcrumb => ({ ...breadcrumb }));
  }
  if (event.event === "client.breadcrumb") {
    payload.kind = event.kind;
    payload.name = event.name;
    if (event.outcome !== undefined) payload.outcome = event.outcome;
    if (event.statusCode !== undefined) payload.statusCode = event.statusCode;
    if (event.durationMs !== undefined) payload.durationMs = event.durationMs;
    if (event.attempt !== undefined) payload.attempt = event.attempt;
    if (event.state !== undefined) payload.state = event.state;
    if (event.errorCode !== undefined) payload.errorCode = event.errorCode;
  }
  return payload;
}

export async function ingestTelemetryBatch(actorKey: string, input: unknown, now = new Date()): Promise<string[]> {
  requireTelemetryConfiguration();
  // Re-parse at the persistence boundary too; callers cannot bypass the closed
  // client union by casting unknown input or supplying trusted server fields.
  const batch: ClientTelemetryBatch | null = parseClientTelemetryBatch(input);
  if (!batch) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_BATCH");
  const expires = verifySessionToken(batch.sessionId, actorKey, batch.sessionToken, now);
  if (expires === null) throw new TelemetryHttpError(401, "TELEMETRY_SESSION_REJECTED");
  if (batch.events.some(event => Math.abs(new Date(event.occurredAt).getTime() - now.getTime()) > EVENT_CLOCK_WINDOW_MS)) {
    throw new TelemetryHttpError(400, "TELEMETRY_EVENT_TIME_REJECTED");
  }

  return prisma.$transaction(async tx => {
    const binding = await tx.telemetrySession.findUnique({ where: { id: batch.sessionId } });
    if (!binding || binding.actorKey !== actorKey || binding.expiresAt <= now || binding.expiresAt.getTime() !== expires) {
      throw new TelemetryHttpError(401, "TELEMETRY_SESSION_REJECTED");
    }
    const reports = batch.events.filter(event => event.event === "client.problem.reported");
    if (reports.length > 0) {
      const byPublicId = new Map<string, string>();
      for (const report of reports) {
        const previous = byPublicId.get(report.errorId);
        if (previous !== undefined && previous !== report.eventId) {
          throw new TelemetryHttpError(409, "TELEMETRY_REPORT_ID_CONFLICT");
        }
        byPublicId.set(report.errorId, report.eventId);
      }
      // Serialize report writers in a stable lock order. Other server error
      // writers do not acquire this lock: readers still defend against ambiguity.
      const ids = [...byPublicId.keys()].sort();
      for (const id of ids) {
        const lockKey = `telemetry:problem-report:${id}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS locked`;
      }
      const anchors = await tx.telemetryEvent.findMany({
        where: { errorId: { in: ids }, receivedAt: { gt: new Date(now.getTime() - TELEMETRY_RETENTION_MS) } },
        select: { actorKey: true, eventId: true, event: true, errorId: true }, take: 101,
      });
      if (anchors.length > 100 || anchors.some(anchor => anchor.actorKey !== actorKey
        || anchor.event !== "client.problem.reported" || anchor.eventId !== byPublicId.get(anchor.errorId!))) {
        throw new TelemetryHttpError(409, "TELEMETRY_REPORT_ID_CONFLICT");
      }
    }
    await tx.telemetryEvent.createMany({
      data: batch.events.map(event => ({
        actorKey,
        eventId: event.eventId,
        receivedAt: now,
        occurredAt: new Date(event.occurredAt),
        event: event.event,
        category: event.event === "ui.action" ? "usage" : "diagnostic",
        source: "client",
        trust: "client_reported",
        actionId: event.actionId,
        sessionId: event.sessionId,
        requestId: event.event === "client.request.result" ? event.requestId : undefined,
        errorId: event.event === "client.request.result" || event.event === "client.render.failed"
          || event.event === "client.problem.reported" ? event.errorId : undefined,
        // Deployment identity is assigned here, never accepted from a browser.
        payload: { ...clientPayload(event), ...buildMetadata() },
      })),
      // Existing eventId receipts are acknowledgements, never updates. In
      // particular a retry cannot extend the first server receivedAt.
      skipDuplicates: true,
    });
    if (reports.length > 0) {
      const stored = await tx.telemetryEvent.findMany({
        where: { actorKey, eventId: { in: reports.map(event => event.eventId) } },
        select: { eventId: true, event: true, errorId: true, sessionId: true, actionId: true, occurredAt: true, payload: true },
      });
      for (const event of reports) {
        const receipt = stored.find(row => row.eventId === event.eventId);
        const payload = receipt?.payload && typeof receipt.payload === "object" && !Array.isArray(receipt.payload)
          ? receipt.payload : {};
        // PostgreSQL jsonb does not preserve object key order. Compare the shared
        // canonical scalar snapshot, while still rejecting any changed values.
        const savedBreadcrumbs = parseProblemReportBreadcrumbs(payload.breadcrumbs, event);
        if (!receipt || receipt.event !== event.event || receipt.errorId !== event.errorId
          || receipt.sessionId !== event.sessionId || receipt.actionId !== event.actionId
          || receipt.occurredAt.getTime() !== Date.parse(event.occurredAt)
          || payload.schemaVersion !== 1 || payload.action !== event.action || payload.traceId !== event.traceId
          || payload.seq !== event.seq || payload.reason !== event.reason || payload.screen !== event.screen
          || savedBreadcrumbs === null || JSON.stringify(savedBreadcrumbs) !== JSON.stringify(event.breadcrumbs)) {
          throw new TelemetryHttpError(400, "TELEMETRY_REPORT_REPLAY_MISMATCH");
        }
      }
    }
    return [...new Set(batch.events.map(event => event.eventId))];
  });
}

/** A postcommit projection can fail without changing the checklist operation. */
export async function projectChecklistTelemetry(receiptId: string): Promise<void> {
  if (!telemetryConfiguration()) return;
  try {
    await prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ChecklistOperationReceipt" WHERE "id" = ${receiptId} FOR UPDATE
      `;
      if (rows.length === 0) return;
      const receipt = await tx.checklistOperationReceipt.findUnique({ where: { id: receiptId } });
      if (!receipt || receipt.telemetryProjectedAt) return;
      const now = new Date();
      const actorKey = telemetryActorKey(receipt.actorId);
      if (!actorKey) return;
      if (receipt.changed && receipt.committedAt.getTime() > now.getTime() - TELEMETRY_RETENTION_MS) {
        await tx.telemetryEvent.createMany({
          data: [{
            actorKey,
            eventId: receipt.eventId,
            receivedAt: now,
            occurredAt: receipt.committedAt,
            event: "task.checklist.updated",
            category: "usage",
            source: "server",
            trust: "authoritative",
            actionId: receipt.actionId,
            requestId: receipt.requestId,
            operationId: receipt.operationId,
            projectId: receipt.projectId,
            taskId: receipt.taskId,
            payload: {
              schemaVersion: 1,
              action: TELEMETRY_ACTION,
              route: TELEMETRY_ROUTE,
              method: "PATCH",
              outcome: "success",
              ...buildMetadata(),
            },
          }],
          skipDuplicates: true,
        });
      }
      // Also mark unchanged/expired receipts: purging analytics must not make an
      // old committed operation eligible for publication again.
      await tx.checklistOperationReceipt.update({
        where: { id: receiptId },
        data: { telemetryProjectedAt: now },
      });
    });
  } catch { /* No raw receipt/error log, and no rejection into the business path. */ }
}

export async function projectPendingChecklistTelemetry(limit = 50): Promise<void> {
  if (!telemetryConfiguration()) return;
  try {
    const take = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    const receipts = await prisma.checklistOperationReceipt.findMany({
      where: { telemetryProjectedAt: null },
      orderBy: [{ committedAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true },
    });
    for (const receipt of receipts) await projectChecklistTelemetry(receipt.id);
  } catch { /* A later bounded repair can retry unprojected receipts. */ }
}

type AdminCursor = { id: string; receivedAt: Date };

function decodeCursor(value: string): AdminCursor {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const { id, receivedAt } = parsed as { id?: unknown; receivedAt?: unknown };
    if (typeof id !== "string" || !internalId.test(id) || typeof receivedAt !== "string") throw new Error();
    const date = new Date(receivedAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== receivedAt) throw new Error();
    return { id, receivedAt: date };
  } catch {
    throw new TelemetryHttpError(400, "TELEMETRY_INVALID_CURSOR");
  }
}

export function safeAdminEvent(row: TelemetryEvent): TelemetryReportEvent | null {
  try {
    if (!/^v1:[a-f0-9]{64}$/.test(row.actorKey) || !internalId.test(row.id)
      || !validCorrelationId(row.eventId)
      || !Number.isFinite(row.receivedAt.getTime()) || !Number.isFinite(row.occurredAt.getTime())) return null;
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {};
    if (payload.schemaVersion !== 1 || payload.synthetic === true) return null;
    const metadata = {
      ...(typeof payload.release === "string" && releasePattern.test(payload.release) ? { release: payload.release } : {}),
      ...(typeof payload.buildId === "string" && releasePattern.test(payload.buildId) ? { buildId: payload.buildId } : {}),
      ...(typeof payload.revision === "string" && revisionPattern.test(payload.revision) ? { revision: payload.revision.toLowerCase() } : {}),
    };
    const base = {
      id: row.id, actorKey: row.actorKey, eventId: row.eventId.toLowerCase(),
      receivedAt: row.receivedAt.toISOString(), occurredAt: row.occurredAt.toISOString(),
      ...(validCorrelationId(row.actionId) ? { actionId: row.actionId!.toLowerCase() } : {}),
      ...(validCorrelationId(row.requestId) ? { requestId: row.requestId!.toLowerCase() } : {}),
      ...(validCorrelationId(row.errorId) ? { errorId: row.errorId!.toLowerCase() } : {}),
      ...(validCorrelationId(row.operationId) ? { operationId: row.operationId!.toLowerCase() } : {}),
      ...(validCorrelationId(row.sessionId) ? { sessionId: row.sessionId!.toLowerCase() } : {}),
      ...(row.projectId && internalId.test(row.projectId) ? { projectId: row.projectId } : {}),
      ...(row.taskId && internalId.test(row.taskId) ? { taskId: row.taskId } : {}),
    };
    if (row.source === "server" && row.trust === "authoritative" && row.event === "task.checklist.updated" && row.category === "usage") {
      return {
        ...base, event: "task.checklist.updated", category: "usage", source: "server", trust: "authoritative",
        payload: { schemaVersion: 1, action: TELEMETRY_ACTION, route: TELEMETRY_ROUTE, method: "PATCH", outcome: "success", ...metadata },
      };
    }
    if (row.source === "server" && row.trust === "server_observed" && row.category === "diagnostic"
      && (row.event === "api.request.completed" || row.event === "api.request.failed")) {
      const { route, method, statusCode, durationMs } = payload;
      if (typeof route !== "string" || !TELEMETRY_SERVER_ROUTES.has(route)
        || typeof method !== "string" || !methods.has(method)
        || typeof statusCode !== "number" || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599
        || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000
        || !validCorrelationId(row.requestId)) return null;
      const errorCode = requestErrorCode(row.event, statusCode);
      return {
        ...base, event: row.event, category: "diagnostic", source: "server", trust: "server_observed",
        payload: {
          schemaVersion: 1, route, method, statusCode, durationMs, outcome: requestOutcome(row.event, statusCode),
          ...(errorCode ? { errorCode } : {}),
          ...(typeof payload.errorType === "string" && errorTypes.has(payload.errorType) ? { errorType: payload.errorType } : {}),
          ...(typeof payload.env === "string" && ["development", "test", "production"].includes(payload.env) ? { env: payload.env } : {}),
          ...(typeof payload.revision === "string" && revisionPattern.test(payload.revision) ? { revision: payload.revision.toLowerCase() } : {}),
          ...(typeof payload.traceId === "string" && validTraceId(payload.traceId) ? { traceId: payload.traceId.toLowerCase() } : {}),
          ...(typeof payload.release === "string" && releasePattern.test(payload.release) ? { release: payload.release } : {}),
          ...(typeof payload.buildId === "string" && releasePattern.test(payload.buildId) ? { buildId: payload.buildId } : {}),
        },
      };
    }
    if (row.source !== "client" || row.trust !== "client_reported") return null;
    const parsed = parseClientTelemetryEvent({
      schemaVersion: payload.schemaVersion, action: payload.action, seq: payload.seq,
      event: row.event, eventId: row.eventId, actionId: row.actionId, sessionId: row.sessionId,
      occurredAt: row.occurredAt.toISOString(),
      ...(typeof payload.traceId === "string" ? { traceId: payload.traceId } : {}),
      ...(row.event === "client.render.failed" ? { errorId: row.errorId, errorCode: "RENDER_FAILURE" } : {}),
      ...(row.event === "client.problem.reported" ? {
        errorId: row.errorId, reason: payload.reason, screen: payload.screen, breadcrumbs: payload.breadcrumbs,
      } : {}),
      ...(row.event === "ui.action" ? {
        ...(typeof payload.screen === "string" ? { screen: payload.screen } : {}),
        ...(typeof payload.view === "string" ? { view: payload.view } : {}),
        ...(typeof payload.filter === "string" ? { filter: payload.filter } : {}),
      } : {}),
      ...(row.event === "client.request.result" ? {
        outcome: payload.outcome, durationMs: payload.durationMs,
        ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
        ...(payload.errorCode !== undefined ? { errorCode: payload.errorCode } : {}),
        ...(row.requestId ? { requestId: row.requestId } : {}),
        ...(row.errorId ? { errorId: row.errorId } : {}),
      } : {}),
      ...(row.event === "client.breadcrumb" ? {
        kind: payload.kind, name: payload.name,
        ...(payload.outcome !== undefined ? { outcome: payload.outcome } : {}),
        ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
        ...(payload.state !== undefined ? { state: payload.state } : {}),
        ...(payload.errorCode !== undefined ? { errorCode: payload.errorCode } : {}),
      } : {}),
    });
    if (!parsed || row.category !== (parsed.event === "ui.action" ? "usage" : "diagnostic")) return null;
    return {
      ...base, event: parsed.event, category: row.category, source: "client", trust: "client_reported",
      // Client events can never acquire server-only project/task/operation metadata.
      projectId: undefined, taskId: undefined, operationId: undefined,
      requestId: parsed.event === "client.request.result" ? parsed.requestId : undefined,
      errorId: parsed.event === "client.request.result" || parsed.event === "client.render.failed"
        || parsed.event === "client.problem.reported" ? parsed.errorId : undefined,
      payload: {
        schemaVersion: 1, action: parsed.action, seq: parsed.seq,
        ...metadata,
        ...(parsed.traceId !== undefined ? { traceId: parsed.traceId } : {}),
        ...(parsed.event === "ui.action" ? {
          ...(parsed.screen !== undefined ? { screen: parsed.screen } : {}),
          ...(parsed.view !== undefined ? { view: parsed.view } : {}),
          ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
        } : {}),
        ...(parsed.event === "client.request.result" ? {
          outcome: parsed.outcome, durationMs: parsed.durationMs,
          ...(parsed.statusCode !== undefined ? { statusCode: parsed.statusCode } : {}),
          ...(parsed.errorCode !== undefined ? { errorCode: parsed.errorCode } : {}),
        } : {}),
        ...(parsed.event === "client.render.failed" ? { errorCode: "RENDER_FAILURE" } : {}),
        ...(parsed.event === "client.problem.reported" ? {
          reason: parsed.reason, screen: parsed.screen, breadcrumbs: parsed.breadcrumbs,
        } : {}),
        ...(parsed.event === "client.breadcrumb" ? {
          kind: parsed.kind, name: parsed.name,
          ...(parsed.outcome !== undefined ? { outcome: parsed.outcome } : {}),
          ...(parsed.statusCode !== undefined ? { statusCode: parsed.statusCode } : {}),
          ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
          ...(parsed.attempt !== undefined ? { attempt: parsed.attempt } : {}),
          ...(parsed.state !== undefined ? { state: parsed.state } : {}),
          ...(parsed.errorCode !== undefined ? { errorCode: parsed.errorCode } : {}),
        } : {}),
      },
    };
  } catch { return null; }
}

export function telemetryReportWindow(filters: TelemetryReportFilters = {}, now = new Date()) {
  const canonical = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
      throw new TelemetryHttpError(400, "TELEMETRY_INVALID_WINDOW");
    }
    return date;
  };
  if (!Number.isFinite(now.getTime())) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_WINDOW");
  const to = filters.to === undefined ? now : canonical(filters.to);
  const from = filters.from === undefined ? new Date(to.getTime() - 24 * 60 * 60 * 1000) : canonical(filters.from);
  const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_MS);
  if (from >= to || to > now || to.getTime() - from.getTime() > TELEMETRY_RETENTION_MS) {
    throw new TelemetryHttpError(400, "TELEMETRY_INVALID_WINDOW");
  }
  if (filters.projectId !== undefined && !internalId.test(filters.projectId)) {
    throw new TelemetryHttpError(400, "TELEMETRY_INVALID_PROJECT");
  }
  if (filters.revision !== undefined && !revisionPattern.test(filters.revision)) {
    throw new TelemetryHttpError(400, "TELEMETRY_INVALID_REVISION");
  }
  if (filters.release !== undefined && !releasePattern.test(filters.release)) {
    throw new TelemetryHttpError(400, "TELEMETRY_INVALID_RELEASE");
  }
  const where: Prisma.TelemetryEventWhereInput = {
    receivedAt: { gte: from, lt: to, gt: cutoff },
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.revision ? { payload: { path: ["revision"], equals: filters.revision.toLowerCase() } } : {}),
    ...(filters.release ? { AND: [{ payload: { path: ["release"], equals: filters.release } }] } : {}),
  };
  return { window: { from: from.toISOString(), to: to.toISOString(), timezone: "UTC" as const }, where };
}
export async function readAdminTelemetry({
  limit = 50,
  cursor,
  category,
  ...filters
}: TelemetryReportFilters & { limit?: number; cursor?: string; category?: "usage" | "diagnostic" }, now = new Date()) {
  requireTelemetryConfiguration();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TelemetryHttpError(400, "TELEMETRY_INVALID_LIMIT");
  const after = cursor ? decodeCursor(cursor) : undefined;
  const { where } = telemetryReportWindow(filters, now);
  const rows = await prisma.telemetryEvent.findMany({
    where: {
      ...where,
      ...(category ? { category } : {}),
      ...(after ? { OR: [
        { receivedAt: { lt: after.receivedAt } },
        { receivedAt: after.receivedAt, id: { lt: after.id } },
      ] } : {}),
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const scanned = rows.slice(0, limit);
  const last = scanned.at(-1);
  return {
    items: scanned.map(safeAdminEvent).filter(event => event !== null),
    nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({ id: last.id, receivedAt: last.receivedAt.toISOString() })).toString("base64url")
      : null,
  };
}

export async function cleanupTelemetry(now = new Date(), limit = 5000): Promise<{ eventsDeleted: number; sessionsDeleted: number }> {
  requireTelemetryConfiguration();
  const take = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 5000;
  const cutoff = new Date(now.getTime() - TELEMETRY_RETENTION_MS);
  return prisma.$transaction(async tx => {
    const events = await tx.telemetryEvent.findMany({
      where: { receivedAt: { lte: cutoff } },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      select: { id: true },
      take,
    });
    const deleted = await tx.telemetryEvent.deleteMany({
      where: { id: { in: events.map(event => event.id) }, receivedAt: { lte: cutoff } },
    });
    const remaining = Math.max(0, take - deleted.count);
    let sessionsDeleted = 0;
    if (remaining > 0) {
      const sessions = await tx.telemetrySession.findMany({
        where: { expiresAt: { lte: now } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: remaining,
      });
      const result = await tx.telemetrySession.deleteMany({
        where: { id: { in: sessions.map(session => session.id) }, expiresAt: { lte: now } },
      });
      sessionsDeleted = result.count;
    }
    return { eventsDeleted: deleted.count, sessionsDeleted };
  });
}
