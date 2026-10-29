/** Browser-safe diary types; never import server persistence into the editor. */
export const MY_DAY_MAX_LENGTH = 50_000;
export const MY_DAY_ACTOR_HEADER = "X-My-Day-Actor-Id";
export const MY_DAY_SESSION_CHANGED = "MY_DAY_SESSION_CHANGED";
export type MyDayEntry = {
  date: string;
  text: string;
  version: number;
  updatedAt: string | null;
  today: string;
};

export function todayMoscow(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
