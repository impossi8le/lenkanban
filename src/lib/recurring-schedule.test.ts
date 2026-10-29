import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  normalizeRecurringSchedule,
  firstRecurringOccurrence,
  nextRecurringOccurrence,
  type RecurringSchedule,
} from './recurring-schedule';

/** Walk the anchored calendar the same way cron does, starting at `startDate`. */
function occurrenceChain(schedule: RecurringSchedule, count: number): string[] {
  const out: string[] = [];
  let current = firstRecurringOccurrence(schedule, schedule.startDate);
  while (current && out.length < count) {
    out.push(current.toISOString());
    current = nextRecurringOccurrence(schedule, current);
  }
  return out;
}

describe('recurring-schedule', () => {
  it('rejects reversed dates, null and out-of-database-range intervals', () => {
    const base = { frequency: 'daily', startDate: '2026-10-20' };
    for (const interval of [null, 0, -1, 1.5, NaN, Infinity, 2147483648]) {
      expect(() => normalizeRecurringSchedule({ ...base, interval })).toThrow();
    }
    expect(() => normalizeRecurringSchedule({ ...base, endDate: '2026-10-19' })).toThrow();
  });

  it('supports early civil years consistently for strings and Date objects', () => {
    const source = new Date('0099-01-31T11:47:23.456Z');
    const schedule = normalizeRecurringSchedule({ frequency: 'monthly', startDate: source });
    const textSchedule = normalizeRecurringSchedule({ frequency: 'monthly', startDate: source.toISOString() });
    expect(schedule.startDate).toEqual(textSchedule.startDate);
    expect(nextRecurringOccurrence(schedule, source)?.toISOString()).toBe('0099-02-28T11:47:23.456Z');
    expect(() => normalizeRecurringSchedule({ frequency: 'daily', startDate: '0000-01-01' })).toThrow();
    expect(() => normalizeRecurringSchedule({ frequency: 'daily', startDate: new Date(8640000000000000) })).toThrow();
  });

  it('preserves annual time and ignores monthly-only dayOfMonth', () => {
    const start = new Date('2026-07-14T11:47:23.456Z');
    const schedule = normalizeRecurringSchedule({ frequency: 'yearly', dayOfMonth: 31, startDate: start });
    expect(nextRecurringOccurrence(schedule, start)?.toISOString()).toBe('2027-07-14T11:47:23.456Z');
  });

  it('keeps multiple weekdays in active anchored weeks and skips inactive weeks', () => {
    const schedule = normalizeRecurringSchedule({ frequency: 'weekly', interval: 2, daysOfWeek: [3, 1], startDate: '2026-10-21T08:00:00Z' });
    const monday = nextRecurringOccurrence(schedule, schedule.startDate)!;
    expect(monday.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(nextRecurringOccurrence(schedule, monday)?.toISOString()).toBe('2026-11-04T08:00:00.000Z');
    expect(firstRecurringOccurrence(schedule, new Date('2026-10-01'))?.toISOString()).toBe('2026-10-21T08:00:00.000Z');
  });

  it('includes an exact end instant but never advances beyond it', () => {
    const schedule = normalizeRecurringSchedule({ frequency: 'daily', startDate: '2026-10-20T08:00:00Z', endDate: '2026-10-21T08:00:00Z' });
    expect(firstRecurringOccurrence(schedule, schedule.endDate!)?.toISOString()).toBe('2026-10-21T08:00:00.000Z');
    expect(nextRecurringOccurrence(schedule, schedule.endDate!)).toBeNull();
    const earlier = normalizeRecurringSchedule({ ...schedule, endDate: '2026-10-21T07:59:59.999Z' });
    expect(nextRecurringOccurrence(earlier, earlier.startDate)).toBeNull();
  });

  it('normalizes offset instants and rejects calendar/time rollover', () => {
    const input = { frequency: 'daily', startDate: '2026-01-01T01:47:23.456+03:00' };
    expect(normalizeRecurringSchedule(input).startDate.toISOString()).toBe('2025-12-31T22:47:23.456Z');
    for (const startDate of ['2026-02-30T12:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T12:60:00Z', '2026-01-01T12:00:00']) {
      expect(() => normalizeRecurringSchedule({ ...input, startDate })).toThrow();
    }
  });

  it.each(['daily', 'weekly', 'monthly', 'yearly'])('terminates at the supported date boundary for %s', frequency => {
    const schedule = normalizeRecurringSchedule({ frequency, startDate: '9999-12-31T23:59:59.999Z' });
    expect(firstRecurringOccurrence(schedule, schedule.startDate)).toEqual(schedule.startDate);
    expect(nextRecurringOccurrence(schedule, schedule.startDate)).toBeNull();
    const sparse = normalizeRecurringSchedule({ frequency, interval: 2147483647, startDate: '2026-10-20' });
    expect(nextRecurringOccurrence(sparse, sparse.startDate)).toBeNull();
  });

  it('handles Jan31 to Feb28 then Mar31 clamping and restore', () => {
    const s = normalizeRecurringSchedule({ frequency: 'monthly', interval: 1, startDate: '2023-01-31T10:00:00Z' });
    const o1 = firstRecurringOccurrence(s, new Date('2023-01-01T00:00:00Z'));
    expect(o1?.toISOString()).toBe('2023-01-31T10:00:00.000Z');
    const o2 = nextRecurringOccurrence(s, o1!);
    expect(o2?.toISOString()).toBe('2023-02-28T10:00:00.000Z');
    const o3 = nextRecurringOccurrence(s, o2!);
    expect(o3?.toISOString()).toBe('2023-03-31T10:00:00.000Z');
  });

  it('handles leap Feb29 annual restoration', () => {
    const s = normalizeRecurringSchedule({ frequency: 'yearly', interval: 1, startDate: '2024-02-29T12:00:00Z' });
    const o1 = firstRecurringOccurrence(s, new Date('2024-01-01T00:00:00Z'))!;
    expect(o1.toISOString()).toBe('2024-02-29T12:00:00.000Z');
    const o2 = nextRecurringOccurrence(s, o1)!;
    expect(o2.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    const o3 = nextRecurringOccurrence(s, new Date('2027-12-01T00:00:00Z'))!;
    expect(o3.toISOString()).toBe('2028-02-29T12:00:00.000Z');
  });

  it('handles interval 2 weekly Monday to 14 days jump', () => {
    const s = normalizeRecurringSchedule({ frequency: 'weekly', interval: 2, startDate: '2023-01-09T08:00:00Z' });
    const o1 = firstRecurringOccurrence(s, new Date('2023-01-01T00:00:00Z'))!;
    expect(o1.toISOString()).toBe('2023-01-09T08:00:00.000Z');
    const o2 = nextRecurringOccurrence(s, o1)!;
    expect(o2.toISOString()).toBe('2023-01-23T08:00:00.000Z');
  });

  it('handles multiweek Monday/Sunday boundary', () => {
    const s = normalizeRecurringSchedule({ frequency: 'weekly', interval: 1, daysOfWeek: [1, 0], startDate: '2023-01-09T00:00:00Z' });
    const o1 = nextRecurringOccurrence(s, new Date('2023-01-09T00:00:00Z'))!;
    expect(o1.toISOString()).toBe('2023-01-15T00:00:00.000Z');
    const o2 = nextRecurringOccurrence(s, o1)!;
    expect(o2.toISOString()).toBe('2023-01-16T00:00:00.000Z');
  });

  it('handles monthly interval 2', () => {
    const s = normalizeRecurringSchedule({ frequency: 'monthly', interval: 2, startDate: '2023-01-15T00:00:00Z' });
    const next = nextRecurringOccurrence(s, new Date('2023-01-15T00:00:00Z'))!;
    expect(next.toISOString()).toBe('2023-03-15T00:00:00.000Z');
  });

  it('handles equal and future start date', () => {
    const s = normalizeRecurringSchedule({ frequency: 'daily', startDate: '2023-05-10T12:00:00Z' });
    expect(firstRecurringOccurrence(s, new Date('2023-05-10T12:00:00Z'))?.toISOString()).toBe('2023-05-10T12:00:00.000Z');
    expect(firstRecurringOccurrence(s, new Date('2023-01-01T00:00:00Z'))?.toISOString()).toBe('2023-05-10T12:00:00.000Z');
  });

  it('handles past anchor arithmetic jump', () => {
    const s = normalizeRecurringSchedule({ frequency: 'daily', interval: 3, startDate: '2020-01-01T00:00:00Z' });
    const first = firstRecurringOccurrence(s, new Date('2023-01-01T00:00:00Z'))!;
    expect(first >= new Date('2023-01-01T00:00:00Z')).toBe(true);
    expect((first.getTime() - new Date('2020-01-01T00:00:00Z').getTime()) % (3 * 86400000)).toBe(0);
  });

  it('rejects invalid inputs: Feb30, invalid frequency, zero interval, invalid weekday', () => {
    expect(() => normalizeRecurringSchedule({ frequency: 'daily', startDate: '2023-02-30' })).toThrow();
    expect(() => normalizeRecurringSchedule({ frequency: 'unknown', startDate: '2023-01-01' })).toThrow();
    expect(() => normalizeRecurringSchedule({ frequency: 'daily', interval: 0, startDate: '2023-01-01' })).toThrow();
    expect(() => normalizeRecurringSchedule({ frequency: 'weekly', daysOfWeek: [7], startDate: '2023-01-01' })).toThrow();
  });

  it('respects inclusive date-only end date and returns null beyond', () => {
    const s = normalizeRecurringSchedule({ frequency: 'daily', startDate: '2023-01-01T12:00:00Z', endDate: '2023-01-02' });
    expect(firstRecurringOccurrence(s, new Date('2023-01-01T00:00:00Z'))?.toISOString()).toBe('2023-01-01T12:00:00.000Z');
    const o2 = nextRecurringOccurrence(s, new Date('2023-01-01T12:00:00Z'))!;
    expect(o2.toISOString()).toBe('2023-01-02T12:00:00.000Z');
    expect(nextRecurringOccurrence(s, o2)).toBeNull();
  });

  // #37 acceptance: 29/30/31, leap years, interval>1, several weekdays.
  it.each([
    { day: 29, start: '2027-01-29T10:00:00Z', expected: ['2027-01-29T10:00:00.000Z', '2027-02-28T10:00:00.000Z', '2027-03-29T10:00:00.000Z'] },
    { day: 30, start: '2027-01-30T10:00:00Z', expected: ['2027-01-30T10:00:00.000Z', '2027-02-28T10:00:00.000Z', '2027-03-30T10:00:00.000Z'] },
    { day: 31, start: '2027-01-31T10:00:00Z', expected: ['2027-01-31T10:00:00.000Z', '2027-02-28T10:00:00.000Z', '2027-03-31T10:00:00.000Z'] },
  ])('monthly day $day clamps into February and restores afterwards', ({ day, start, expected }) => {
    const schedule = normalizeRecurringSchedule({ frequency: 'monthly', startDate: start });
    expect(occurrenceChain(schedule, 3)).toEqual(expected);
    // The stored day is never rewritten by clamping.
    expect(schedule.startDate.getUTCDate()).toBe(day);
  });

  it('monthly restores 29 February in a leap year and clamps in a common year', () => {
    const leap = normalizeRecurringSchedule({ frequency: 'monthly', startDate: '2028-01-29T10:00:00Z' });
    expect(occurrenceChain(leap, 3)).toEqual([
      '2028-01-29T10:00:00.000Z', '2028-02-29T10:00:00.000Z', '2028-03-29T10:00:00.000Z',
    ]);
    const common = normalizeRecurringSchedule({ frequency: 'monthly', startDate: '2027-01-29T10:00:00Z' });
    expect(occurrenceChain(common, 2)[1]).toBe('2027-02-28T10:00:00.000Z');
  });

  it('monthly crosses the year boundary without skipping February', () => {
    const schedule = normalizeRecurringSchedule({ frequency: 'monthly', startDate: '2027-12-31T10:00:00Z' });
    expect(occurrenceChain(schedule, 4)).toEqual([
      '2027-12-31T10:00:00.000Z', '2028-01-31T10:00:00.000Z',
      '2028-02-29T10:00:00.000Z', '2028-03-31T10:00:00.000Z',
    ]);
  });

  it('monthly interval 2 never fires in a skipped month and still clamps', () => {
    const schedule = normalizeRecurringSchedule({ frequency: 'monthly', interval: 2, startDate: '2027-01-31T10:00:00Z' });
    expect(occurrenceChain(schedule, 4)).toEqual([
      '2027-01-31T10:00:00.000Z', '2027-03-31T10:00:00.000Z',
      '2027-05-31T10:00:00.000Z', '2027-07-31T10:00:00.000Z',
    ]);
  });

  it('monthly dayOfMonth 31 overrides a start day that is not 31', () => {
    const schedule = normalizeRecurringSchedule({ frequency: 'monthly', dayOfMonth: 31, startDate: '2027-01-15T10:00:00Z' });
    expect(occurrenceChain(schedule, 4)).toEqual([
      '2027-01-31T10:00:00.000Z', '2027-02-28T10:00:00.000Z',
      '2027-03-31T10:00:00.000Z', '2027-04-30T10:00:00.000Z',
    ]);
  });

  // The audit reproduced 04.01 + interval 2 + Monday => 11.01; the anchored
  // calendar must produce 18.01 instead.
  it('weekly interval 2 advances two anchored weeks, not one', () => {
    const schedule = normalizeRecurringSchedule({
      frequency: 'weekly', interval: 2, daysOfWeek: [1], startDate: '2027-01-04T09:00:00Z',
    });
    expect(occurrenceChain(schedule, 3)).toEqual([
      '2027-01-04T09:00:00.000Z', '2027-01-18T09:00:00.000Z', '2027-02-01T09:00:00.000Z',
    ]);
  });

  it('weekly keeps every selected weekday inside the active week and skips inactive weeks', () => {
    const schedule = normalizeRecurringSchedule({
      frequency: 'weekly', interval: 3, daysOfWeek: [3, 1], startDate: '2027-01-04T09:00:00Z',
    });
    expect(occurrenceChain(schedule, 5)).toEqual([
      '2027-01-04T09:00:00.000Z', '2027-01-06T09:00:00.000Z',
      '2027-01-25T09:00:00.000Z', '2027-01-27T09:00:00.000Z',
      '2027-02-15T09:00:00.000Z',
    ]);
  });

  it('anchors weeks on Monday even when the start day is Sunday', () => {
    // 2027-01-03 is a Sunday; its Monday-based week starts 2026-12-28.
    const monday = normalizeRecurringSchedule({
      frequency: 'weekly', daysOfWeek: [1], startDate: '2027-01-03T09:00:00Z',
    });
    expect(occurrenceChain(monday, 2)).toEqual([
      '2027-01-04T09:00:00.000Z', '2027-01-11T09:00:00.000Z',
    ]);
    const sunday = normalizeRecurringSchedule({
      frequency: 'weekly', daysOfWeek: [0], startDate: '2027-01-03T09:00:00Z',
    });
    expect(occurrenceChain(sunday, 2)).toEqual([
      '2027-01-03T09:00:00.000Z', '2027-01-10T09:00:00.000Z',
    ]);
  });

  it('yearly interval 2 keeps 29 February anchored and clamps odd years', () => {
    const schedule = normalizeRecurringSchedule({ frequency: 'yearly', interval: 2, startDate: '2024-02-29T12:00:00Z' });
    expect(occurrenceChain(schedule, 4)).toEqual([
      '2024-02-29T12:00:00.000Z', '2026-02-28T12:00:00.000Z',
      '2028-02-29T12:00:00.000Z', '2030-02-28T12:00:00.000Z',
    ]);
  });

  // #37 acceptance: the timezone is explicit UTC; an equivalent instant written
  // with an offset must produce the identical anchored calendar.
  it('produces the same calendar for the same instant expressed with an offset', () => {
    const utc = normalizeRecurringSchedule({ frequency: 'weekly', interval: 2, daysOfWeek: [1, 4], startDate: '2027-01-04T09:00:00Z' });
    const offset = normalizeRecurringSchedule({ frequency: 'weekly', interval: 2, daysOfWeek: [1, 4], startDate: '2027-01-04T12:00:00+03:00' });
    expect(offset.startDate.getTime()).toBe(utc.startDate.getTime());
    expect(occurrenceChain(offset, 5)).toEqual(occurrenceChain(utc, 5));
    // Occurrences keep the UTC wall time of the anchor, never the machine zone.
    expect(occurrenceChain(utc, 2)).toEqual([
      '2027-01-04T09:00:00.000Z', '2027-01-07T09:00:00.000Z',
    ]);
  });

  // #37 acceptance: "same result when configuring and when cron runs".
  it.each([
    { name: 'daily', schedule: { frequency: 'daily', interval: 3, startDate: '2027-01-04T09:00:00Z' }, now: '2027-01-10T00:00:00Z' },
    { name: 'weekly', schedule: { frequency: 'weekly', interval: 2, daysOfWeek: [1, 4], startDate: '2027-01-04T09:00:00Z' }, now: '2027-01-12T00:00:00Z' },
    { name: 'monthly', schedule: { frequency: 'monthly', startDate: '2027-01-31T09:00:00Z' }, now: '2027-02-10T00:00:00Z' },
    { name: 'yearly', schedule: { frequency: 'yearly', startDate: '2024-02-29T09:00:00Z' }, now: '2027-01-01T00:00:00Z' },
  ] as const)('$name gives the same occurrence when scheduling and when cron advances', ({ schedule: input, now }) => {
    const schedule = normalizeRecurringSchedule(input);
    const chain = occurrenceChain(schedule, 8);
    const at = new Date(now);
    const fromChain = chain.find(value => new Date(value).getTime() >= at.getTime());
    expect(fromChain).toBeDefined();
    // Creation path (POST/PATCH) picks the first occurrence at or after now.
    expect(firstRecurringOccurrence(schedule, at)?.toISOString()).toBe(fromChain);
    // Cron path advances from the stored occurrence using the same calendar.
    const storedIndex = chain.indexOf(fromChain!);
    expect(occurrenceChain(schedule, storedIndex + 2).at(-1)).toBe(chain[storedIndex + 1]);
  });

  // Architecture guard: the three consumers must delegate to this module. A
  // re-introduced local calculateNextRun or local-time mutator fails here.
  it('is the single calendar used by POST, PATCH and cron', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const consumers = [
      'src/app/api/recurring-tasks/route.ts',
      'src/app/api/recurring-tasks/[id]/route.ts',
      'src/lib/recurring-processor.ts',
    ];
    for (const relative of consumers) {
      const source = readFileSync(`${root}${relative}`, 'utf8');
      expect(source, relative).toMatch(/from "@\/lib\/recurring-schedule"|from "\.\/recurring-schedule"/);
      expect(source, relative).not.toMatch(/function calculateNextRun/);
      expect(source, relative).not.toMatch(/\.set(?:Month|Date|Hours|Minutes|Seconds|FullYear)\(/);
    }
    const calendar = readFileSync(`${root}src/lib/recurring-schedule.ts`, 'utf8');
    expect(calendar).not.toMatch(/\.set(?:Month|Date|Hours|Minutes|Seconds)\(/);
    expect(calendar).not.toMatch(/getTimezoneOffset|new Date\(\)/);
  });

  it('preserves immutability of input Dates and now/after parameters', () => {
    const d = new Date('2023-01-01T00:00:00Z');
    const originalTime = d.getTime();
    const s = normalizeRecurringSchedule({ frequency: 'daily', startDate: d });
    d.setUTCFullYear(2025);
    expect(s.startDate.getTime()).toBe(originalTime);
    const queryDate = new Date('2023-01-01T00:00:00Z');
    firstRecurringOccurrence(s, queryDate);
    expect(queryDate.getTime()).toBe(originalTime);
  });
});
