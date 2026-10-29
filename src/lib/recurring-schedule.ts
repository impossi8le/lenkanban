export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RecurringSchedule {
  frequency: Frequency;
  interval: number;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: Date;
  endDate: Date | null;
}

// The API accepts civil years 0001..9999, matching its four-digit ISO format.
// Keeping Date inputs in the same range also keeps timestamp arithmetic exact.
function utcTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}
const MIN_TIME = utcTime(1, 0, 1);
const MAX_TIME = utcTime(9999, 11, 31, 23, 59, 59, 999);

function assertDateRange(time: number): void {
  if (!Number.isFinite(time) || time < MIN_TIME || time > MAX_TIME) {
    throw new Error('Date outside supported years 0001..9999');
  }
}

function parseStrictDate(val: unknown, isEndDateOnly = false): Date {
  if (val instanceof Date) {
    assertDateRange(val.getTime());
    return new Date(val.getTime());
  }
  if (typeof val !== 'string') throw new Error('Invalid date type');

  const dOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
  if (dOnly) {
    const y = Number(dOnly[1]);
    const m = Number(dOnly[2]);
    const d = Number(dOnly[3]);
    const dt = new Date(utcTime(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      throw new Error('Invalid calendar date');
    }
    assertDateRange(dt.getTime());
    return isEndDateOnly ? new Date(utcTime(y, m - 1, d, 23, 59, 59, 999)) : dt;
  }

  const full = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(val);
  if (!full) throw new Error('Invalid ISO date string');
  const y = Number(full[1]);
  const m = Number(full[2]);
  const d = Number(full[3]);
  const hh = Number(full[4]);
  const mm = Number(full[5]);
  const ss = Number(full[6]);
  if (hh > 23 || mm > 59 || ss > 59) throw new Error('Invalid time component');
  const checkD = new Date(utcTime(y, m - 1, d));
  if (checkD.getUTCFullYear() !== y || checkD.getUTCMonth() !== m - 1 || checkD.getUTCDate() !== d) {
    throw new Error('Invalid calendar date');
  }
  const ms = Number((full[7] || '0').slice(0, 3).padEnd(3, '0'));
  let utcMs = utcTime(y, m - 1, d, hh, mm, ss, ms);
  if (full[8]) {
    const sign = full[8] === '+' ? -1 : 1;
    const offH = Number(full[9]);
    const offM = Number(full[10]);
    if (offH > 23 || offM > 59) throw new Error('Invalid timezone offset');
    utcMs += sign * (offH * 60 + offM) * 60000;
  }
  const res = new Date(utcMs);
  assertDateRange(res.getTime());
  return res;
}

export function normalizeRecurringSchedule(input: unknown): RecurringSchedule {
  if (!input || typeof input !== 'object') throw new Error('Schedule must be an object');
  const raw = input as Record<string, unknown>;
  if (raw.frequency !== 'daily' && raw.frequency !== 'weekly' && raw.frequency !== 'monthly' && raw.frequency !== 'yearly') {
    throw new Error('Invalid frequency');
  }
  let interval = 1;
  if (raw.interval !== undefined) {
    if (typeof raw.interval !== 'number' || !Number.isInteger(raw.interval) || raw.interval < 1 || raw.interval > 2147483647) {
      throw new Error('Interval must be a positive 32-bit integer');
    }
    interval = raw.interval;
  }
  if (raw.startDate === undefined || raw.startDate === null) {
    throw new Error('startDate is required');
  }
  const startDate = parseStrictDate(raw.startDate, false);
  let endDate: Date | null = null;
  if (raw.endDate !== undefined && raw.endDate !== null) {
    endDate = parseStrictDate(raw.endDate, true);
    if (endDate.getTime() < startDate.getTime()) throw new Error('End date precedes start date');
  }
  let daysOfWeek: number[] = [];
  if (raw.daysOfWeek !== undefined && raw.daysOfWeek !== null) {
    if (!Array.isArray(raw.daysOfWeek)) throw new Error('daysOfWeek must be an array');
    const set = new Set<number>();
    for (const d of raw.daysOfWeek) {
      if (typeof d !== 'number' || !Number.isSafeInteger(d) || d < 0 || d > 6) {
        throw new Error('daysOfWeek must contain integers 0-6');
      }
      if (set.has(d)) throw new Error('Duplicate day in daysOfWeek');
      set.add(d);
    }
    daysOfWeek = Array.from(set).sort((a, b) => a - b);
  }
  let dayOfMonth: number | null = null;
  if (raw.dayOfMonth !== undefined && raw.dayOfMonth !== null) {
    if (typeof raw.dayOfMonth !== 'number' || !Number.isSafeInteger(raw.dayOfMonth) || raw.dayOfMonth < 1 || raw.dayOfMonth > 31) {
      throw new Error('dayOfMonth must be 1-31');
    }
    dayOfMonth = raw.dayOfMonth;
  }
  return {
    frequency: raw.frequency,
    interval,
    daysOfWeek,
    dayOfMonth,
    startDate,
    endDate,
  };
}

function findOccurrence(schedule: RecurringSchedule, minTime: number): Date | null {
  const start = schedule.startDate;
  const startMs = start.getTime();
  const effectiveMin = Math.max(minTime, startMs);
  const endMs = schedule.endDate ? schedule.endDate.getTime() : MAX_TIME;
  if (effectiveMin > endMs) return null;

  const targetH = start.getUTCHours();
  const targetM = start.getUTCMinutes();
  const targetS = start.getUTCSeconds();
  const targetMs = start.getUTCMilliseconds();
  const timeOfDayMs = ((targetH * 60 + targetM) * 60 + targetS) * 1000 + targetMs;

  if (schedule.frequency === 'daily') {
    const step = schedule.interval * 86400000;
    let k = 0;
    if (effectiveMin > startMs) {
      k = Math.ceil((effectiveMin - startMs) / step);
    }
    let candMs = startMs + k * step;
    if (candMs < effectiveMin) candMs += step;
    return Number.isFinite(candMs) && candMs >= effectiveMin && candMs <= endMs && candMs <= MAX_TIME ? new Date(candMs) : null;
  }

  if (schedule.frequency === 'weekly') {
    const startDay = start.getUTCDay();
    const monOffset = (startDay + 6) % 7;
    const anchorMonMs = utcTime(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - monOffset);
    const days = schedule.daysOfWeek.length > 0 ? schedule.daysOfWeek : [startDay];
    const dayOffsets = Array.from(new Set(days))
      .map((d) => (d + 6) % 7)
      .sort((a, b) => a - b);
    const weekMs = 7 * 86400000;
    const stepWeeks = schedule.interval;
    let w = 0;
    if (effectiveMin > anchorMonMs) {
      const diffWeeks = Math.floor((effectiveMin - anchorMonMs) / weekMs);
      w = Math.max(0, Math.floor(diffWeeks / stepWeeks) * stepWeeks);
    }
    for (let loop = 0; loop < 3; loop++, w += stepWeeks) {
      const weekStartMs = anchorMonMs + w * weekMs;
      if (!Number.isFinite(weekStartMs) || weekStartMs > endMs || weekStartMs > MAX_TIME) return null;
      for (const offset of dayOffsets) {
        const candMs = weekStartMs + offset * 86400000 + timeOfDayMs;
        if (candMs >= effectiveMin && candMs >= startMs) {
          return candMs <= endMs && candMs <= MAX_TIME ? new Date(candMs) : null;
        }
      }
    }
    return null;
  }

  if (schedule.frequency === 'monthly') {
    const targetDay = schedule.dayOfMonth ?? start.getUTCDate();
    const startY = start.getUTCFullYear();
    const startM = start.getUTCMonth();
    const minDate = new Date(effectiveMin);
    const monthDiff = (minDate.getUTCFullYear() - startY) * 12 + (minDate.getUTCMonth() - startM);
    let k = Math.max(0, Math.floor(monthDiff / schedule.interval));
    for (let loop = 0; loop < 3; loop++, k++) {
      const totalM = startM + k * schedule.interval;
      const y = startY + Math.floor(totalM / 12);
      const m = ((totalM % 12) + 12) % 12;
      if (y > 9999) return null;
      const maxD = new Date(utcTime(y, m + 1, 0)).getUTCDate();
      const d = Math.min(targetDay, maxD);
      const candMs = utcTime(y, m, d, targetH, targetM, targetS, targetMs);
      if (candMs >= effectiveMin && candMs >= startMs) {
        return candMs <= endMs && candMs <= MAX_TIME ? new Date(candMs) : null;
      }
    }
    return null;
  }

  if (schedule.frequency === 'yearly') {
    const targetMonth = start.getUTCMonth();
    const targetDay = start.getUTCDate();
    const startY = start.getUTCFullYear();
    const minDate = new Date(effectiveMin);
    let k = Math.max(0, Math.floor((minDate.getUTCFullYear() - startY) / schedule.interval));
    for (let loop = 0; loop < 3; loop++, k++) {
      const y = startY + k * schedule.interval;
      if (y > 9999) return null;
      const maxD = new Date(utcTime(y, targetMonth + 1, 0)).getUTCDate();
      const d = Math.min(targetDay, maxD);
      const candMs = utcTime(y, targetMonth, d, targetH, targetM, targetS, targetMs);
      if (candMs >= effectiveMin && candMs >= startMs) {
        return candMs <= endMs && candMs <= MAX_TIME ? new Date(candMs) : null;
      }
    }
    return null;
  }

  return null;
}

export function firstRecurringOccurrence(schedule: RecurringSchedule, now: Date): Date | null {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid now Date');
  return findOccurrence(schedule, Math.max(now.getTime(), schedule.startDate.getTime()));
}

export function nextRecurringOccurrence(schedule: RecurringSchedule, after: Date): Date | null {
  if (!Number.isFinite(after.getTime())) throw new Error('Invalid after Date');
  return findOccurrence(schedule, Math.max(after.getTime() + 1, schedule.startDate.getTime()));
}
