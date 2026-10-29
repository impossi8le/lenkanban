/**
 * Bounded shallow mail overview window support: strict parsing and classification of
 * topic activity dates. Pure string logic only - no DOM, no network, and no host
 * timezone assumptions (ordering keys are constructed directly from source digits).
 */

/** The overview is bounded to this inclusive window (YYYY-MM-DD). */
export const MAIL_OVERVIEW_WINDOW = { from: '2025-01-01', to: '2026-10-20' };

/** Included in every summary: what the numbers are, and what they are not. */
export const MAIL_WINDOW_STATEMENT = 'Topic activity observations only: secondary list header dates are neither message totals nor proven recurrence.';

const TIMESTAMP_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) { return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0; }

function daysInMonth(year, month) { return month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1]; }

/** Strict valid Gregorian 'DD.MM.YYYY HH:MM[:SS]' -> fixed-width sortable local ISO key; null otherwise. */
export function parseMailTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(String(value ?? ''));
  if (!match) return null;
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6] ?? '00'}`;
}

function isCalendarDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Strict YYYY-MM-DD window requiring from <= to; returns normalized { from, to } or null. */
export function validateMailDateWindow(window = {}) {
  const from = String(window?.from ?? ''), to = String(window?.to ?? '');
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return null;
  return { from, to };
}

/** Classify ONLY from list_header_dates.secondary_header; creation dates are never substituted. */
export function classifyTopicActivity(topic, window = MAIL_OVERVIEW_WINDOW) {
  const valid = validateMailDateWindow(window ?? {});
  if (!valid) throw new Error('INVALID_MAIL_DATE_WINDOW');
  const timestamp = parseMailTimestamp(topic?.list_header_dates?.secondary_header);
  if (!timestamp) return 'unknown';
  const day = timestamp.slice(0, 10);
  if (day < valid.from) return 'before_window';
  if (day > valid.to) return 'after_window';
  return 'in_window';
}

/** Pure distinct-topic aggregate of activity buckets, known extremes and in-window months. */
export function summarizeMailWindow(topics, window = MAIL_OVERVIEW_WINDOW) {
  const valid = validateMailDateWindow(window ?? {});
  if (!valid) throw new Error('INVALID_MAIL_DATE_WINDOW');
  const distinct = new Map();
  for (const item of Array.isArray(topics) ? topics : []) {
    const key = item?.topic_id ?? item;
    if (!distinct.has(key)) distinct.set(key, item);
  }
  const topic_counts = { in_window: 0, before_window: 0, after_window: 0, unknown: 0 };
  const months = new Map();
  let oldest_known = null, latest_known = null;
  for (const topic of distinct.values()) {
    const secondary = topic?.list_header_dates?.secondary_header ?? null;
    const timestamp = parseMailTimestamp(secondary);
    if (timestamp) {
      if (!oldest_known || timestamp < oldest_known.timestamp) oldest_known = { topic_id: topic.topic_id ?? null, secondary_header: secondary, timestamp };
      if (!latest_known || timestamp > latest_known.timestamp) latest_known = { topic_id: topic.topic_id ?? null, secondary_header: secondary, timestamp };
    }
    const bucket = classifyTopicActivity(topic, valid);
    topic_counts[bucket] += 1;
    if (bucket === 'in_window') months.set(timestamp.slice(0, 7), (months.get(timestamp.slice(0, 7)) ?? 0) + 1);
  }
  return { window: valid, distinct_topics: distinct.size, topic_counts, in_window_month_counts: Object.fromEntries([...months.entries()].sort()), oldest_known, latest_known, statement: MAIL_WINDOW_STATEMENT };
}
