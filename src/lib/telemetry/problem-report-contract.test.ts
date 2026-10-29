import { describe, expect, it, vi } from 'vitest';
import { parseClientTelemetryBatch, parseClientTelemetryEvent } from './contract';
import { parseProblemReportBreadcrumbs } from './problem-report-contract';

const now = '2026-10-26T12:00:00.000Z';
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const crumb = (seq = 0) => ({ eventId: uuid(seq + 10), seq, occurredAt: now, kind: 'navigation', name: 'root' });
const report = () => ({ schemaVersion: 1, event: 'client.problem.reported', action: 'app.problem.report',
  eventId: uuid(1), actionId: uuid(2), sessionId: uuid(3), errorId: uuid(4), occurredAt: now,
  seq: 50, reason: 'slow', screen: 'home', breadcrumbs: [crumb()] });

describe('problem report closed immutable snapshot contract', () => {
  it('accepts a report with a home screen and detached scalar snapshot in the existing signed envelope', () => {
    const input = report();
    const parsed = parseClientTelemetryEvent(input);
    expect(parsed).toEqual(input);
    input.breadcrumbs[0].name = 'PRIVATE';
    expect(parsed).toMatchObject({ breadcrumbs: [{ name: 'root' }] });
    const batch = { sessionId: uuid(3), sessionToken: `v1.1793016000000.${'a'.repeat(64)}`, events: [report()] };
    expect(parseClientTelemetryBatch(batch)?.events).toHaveLength(1);
  });

  it.each(['private text', 'error?token=PRIVATE', '', {}, null])('rejects an arbitrary reason %#', reason => {
    expect(parseClientTelemetryEvent({ ...report(), reason })).toBeNull();
  });

  it.each(['message', 'url', 'cookie', 'actorId', 'source', 'trust', 'receivedAt'])('rejects extra report context %s', field => {
    expect(parseClientTelemetryEvent({ ...report(), [field]: 'PRIVATE' })).toBeNull();
  });

  it('rejects nested fields, arbitrary labels, local clocks and getters without evaluating them', () => {
    const getter = vi.fn(() => 'PRIVATE');
    for (const extra of [{ text: 'PRIVATE' }, { name: 'PRIVATE' }, { at: 12 }, { outcome: { message: 'PRIVATE' } }]) {
      expect(parseClientTelemetryEvent({ ...report(), breadcrumbs: [{ ...crumb(), ...extra }] })).toBeNull();
    }
    const hostile = Object.defineProperty(crumb(), 'name', { get: getter });
    expect(parseClientTelemetryEvent({ ...report(), breadcrumbs: [hostile] })).toBeNull();
    const event = Object.defineProperty(report(), 'reason', { get: getter });
    expect(parseClientTelemetryEvent(event)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it('enforces count, chronological window, unique ordered sequences and unique event IDs', () => {
    const anchor = { seq: 50, occurredAt: now };
    expect(parseProblemReportBreadcrumbs(Array.from({ length: 50 }, (_, i) => crumb(i)), anchor)).toHaveLength(50);
    expect(parseProblemReportBreadcrumbs(Array.from({ length: 51 }, (_, i) => crumb(i)), anchor)).toBeNull();
    for (const crumbs of [[crumb(1), crumb(0)], [crumb(), crumb()], [crumb(51)],
      [{ ...crumb(), occurredAt: '2026-10-26T11:54:59.999Z' }],
      [{ ...crumb(), occurredAt: '2026-10-26T12:00:00.001Z' }]]) {
      expect(parseProblemReportBreadcrumbs(crumbs, anchor)).toBeNull();
    }
    expect(parseProblemReportBreadcrumbs([{ ...crumb(), occurredAt: '2026-10-26T11:55:00.000Z' }], anchor)).toHaveLength(1);
  });

  it('rejects a large otherwise valid snapshot instead of silently truncating or accepting it', () => {
    const crumbs = Array.from({ length: 50 }, (_, seq) => ({ ...crumb(seq), kind: 'request',
      name: '/api/tasks/:id/checklist/:itemId', outcome: 'failure', statusCode: 500,
      durationMs: 10000, attempt: 3, errorCode: 'HTTP_5XX' }));
    expect(new TextEncoder().encode(JSON.stringify(crumbs)).byteLength).toBeGreaterThan(8192);
    expect(parseClientTelemetryEvent({ ...report(), breadcrumbs: crumbs })).toBeNull();
  });
});
