/** UTC interval arithmetic only. Missing calendar never implies a default schedule. */
export type WorkingTimeResult =
  | { ok: true; elapsedMs: number }
  | { ok: false; reason: "calendar_not_configured" | "invalid_input" };

type Interval = { start: number; end: number };
const MAX_INTERVALS = 10_000;

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readIntervals(value: unknown): Interval[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (!isTimestamp(length) || length > MAX_INTERVALS) return null;
  const intervals: Interval[] = [];
  for (let index = 0; index < length; index += 1) {
    const item: unknown = value[index];
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    // Snapshot once: validation and calculation must use the same endpoint values.
    const candidate = item as Record<string, unknown>;
    const start = candidate.start;
    const end = candidate.end;
    if (!isTimestamp(start) || !isTimestamp(end) || end < start) return null;
    if (end > start) intervals.push({ start, end });
  }
  return intervals;
}

function merge(intervals: Interval[]): Interval[] {
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const interval of intervals) {
    const last = result[result.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}

export function measureWorkingTime(input: unknown): WorkingTimeResult {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "invalid_input" };
    const candidate = input as Record<string, unknown>;
    const from = candidate.from;
    const to = candidate.to;
    if (!isTimestamp(from) || !isTimestamp(to) || to < from) return { ok: false, reason: "invalid_input" };
    const rawPauses = candidate.pauses;
    const pauses = readIntervals(rawPauses === undefined ? [] : rawPauses);
    if (!pauses) return { ok: false, reason: "invalid_input" };
    const rawWindows = candidate.workingWindows;
    if (rawWindows === undefined) return { ok: false, reason: "calendar_not_configured" };
    const windows = readIntervals(rawWindows);
    if (!windows) return { ok: false, reason: "invalid_input" };

    const working = merge(windows.map(window => ({ start: Math.max(from, window.start), end: Math.min(to, window.end) })).filter(window => window.end > window.start));
    const paused = merge(pauses);
    let elapsedMs = 0;
    let pauseIndex = 0;
    for (const window of working) {
      let remaining = window.end - window.start;
      while (pauseIndex < paused.length && paused[pauseIndex].end <= window.start) pauseIndex += 1;
      let index = pauseIndex;
      while (index < paused.length && paused[index].start < window.end) {
        remaining -= Math.max(0, Math.min(window.end, paused[index].end) - Math.max(window.start, paused[index].start));
        if (paused[index].end > window.end) break;
        index += 1;
      }
      pauseIndex = index;
      elapsedMs += remaining;
    }
    return { ok: true, elapsedMs };
  } catch {
    // Invalid getters/proxies are not allowed to escape or echo input values.
    return { ok: false, reason: "invalid_input" };
  }
}
