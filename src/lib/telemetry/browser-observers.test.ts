import { describe, expect, it } from 'vitest';
import { resourceObservation, screenForTelemetry } from './browser-observers';

const entry = (overrides: Record<string, unknown> = {}) => ({
  name: 'https://example.test/api/tasks/PRIVATE_TASK?token=SYNTHETIC_SECRET#PRIVATE_FRAGMENT',
  entryType: 'resource', initiatorType: 'fetch', startTime: 200, duration: 123.456, responseStatus: 200,
  ...overrides,
}) as unknown as PerformanceResourceTiming;

describe('passive request normalization', () => {
  it('only returns a closed template, duration and browser-reported status', () => {
    const observation = resourceObservation(entry(), 'https://example.test', 100);
    expect(observation).toEqual({ route: '/api/tasks/:id', details: { durationMs: 123.46, statusCode: 200, outcome: 'success' } });
    expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|SECRET|token|https/);
  });
  it.each([
    { name: 'https://other.test/api/tasks' },
    { name: 'https://user:password@example.test/api/tasks' },
    { name: 'https://example.test/projects/PRIVATE/board' },
    { name: 'https://example.test/api/telemetry' },
    { name: 'https://example.test/api/telemetry/cleanup' },
    { name: 'https://example.test/api/admin/telemetry/summary' },
    { initiatorType: 'img' }, { entryType: 'navigation' },
    { duration: NaN }, { duration: -1 }, { duration: Infinity },
    { startTime: 99 }, { startTime: NaN },
  ])('excludes other identities, non-API data and recursive diagnostics: %j', overrides => {
    expect(resourceObservation(entry(overrides), 'https://example.test', 100)).toBeNull();
  });
  it('does not infer HTTP success when browser status is absent or zero', () => {
    for (const responseStatus of [undefined, 0, 999, NaN]) {
      expect(resourceObservation(entry({ responseStatus }), 'https://example.test', 100)?.details)
        .toEqual({ durationMs: 123.46 });
    }
  });
  it.each([[403, 'rejected'], [409, 'conflict'], [503, 'failure']])('classifies a reported %i', (responseStatus, outcome) => {
    expect(resourceObservation(entry({ responseStatus }), 'https://example.test', 100)?.details.outcome).toBe(outcome);
  });
  it('normalizes unmatched paths without retaining their contents', () => {
    expect(resourceObservation(entry({ name: 'https://example.test/api/PRIVATE_UNKNOWN/SECRET' }), 'https://example.test', 100)?.route).toBe('/api/:unmatched');
  });
  it('contains hostile timing getters and invalid observation boundaries', () => {
    expect(resourceObservation(Object.defineProperty({}, 'entryType', { get() { throw Error('SYNTHETIC_SECRET'); } }) as PerformanceEntry, 'https://example.test', 100)).toBeNull();
    expect(resourceObservation(entry(), 'https://example.test', NaN)).toBeNull();
  });
});

it('reduces route navigation to closed screens, never private IDs', () => {
  expect(screenForTelemetry('/')).toBe('home');
  expect(screenForTelemetry('/projects/PRIVATE/board')).toBe('board');
  expect(screenForTelemetry('/projects/PRIVATE/tasks/SECRET')).toBe('task.detail');
  expect(screenForTelemetry('/admin/telemetry')).toBe('admin.telemetry');
  expect(screenForTelemetry('/admin/users')).toBe('admin');
  expect(screenForTelemetry('/settings')).toBe('settings');
  expect(screenForTelemetry('/PRIVATE_UNKNOWN')).toBeNull();
});
