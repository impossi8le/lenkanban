import {
  isDayKey,
  MY_DAY_MAX_LENGTH,
  todayMoscow,
  type MyDayEntry,
} from "@/lib/my-day-contract";

export { isDayKey, MY_DAY_MAX_LENGTH, todayMoscow, type MyDayEntry };

/**
 * Convert a validated YYYY-MM-DD day key into a local calendar Date at noon
 * so react-day-picker never shifts the day across timezones or DST boundaries.
 */
export function dayKeyToCalendarDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/**
 * Extract YYYY-MM-DD from a local calendar Date produced by react-day-picker
 * without using toISOString() (which would shift by the local UTC offset).
 */
export function calendarDateToDayKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Add or subtract calendar days on a YYYY-MM-DD string without local timezone drift.
 */
export function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays, 12, 0, 0, 0));
  const nextYear = String(utc.getUTCFullYear()).padStart(4, "0");
  const nextMonth = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(utc.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

/**
 * Format YYYY-MM-DD in Russian, e.g. "Четверг, 29 октября 2026".
 */
export function formatMyDayHeading(dayKey: string): string {
  if (!isDayKey(dayKey)) return dayKey;
  const [year, month, day] = dayKey.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  const formatted = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(utc)
    .replace(/\s*г\.?$/i, "")
    .trim();

  if (!formatted) return dayKey;
  return formatted[0].toUpperCase() + formatted.slice(1);
}

/**
 * Compute milliseconds until the next midnight in Europe/Moscow.
 */
export function msUntilNextMoscowMidnight(now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const getPart = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value ?? "0");
    const hours = getPart("hour") % 24;
    const minutes = getPart("minute");
    const seconds = getPart("second");
    const ms = now.getMilliseconds();
    const elapsedMs = ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
    const dayMs = 24 * 60 * 60 * 1000;
    return Math.max(1_000, dayMs - elapsedMs + 100);
  } catch {
    return 60_000;
  }
}

/**
 * Create a lowercase RFC 4122 v4 UUID for idempotent PUT operations.
 */
export function createMyDayOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().toLowerCase();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
