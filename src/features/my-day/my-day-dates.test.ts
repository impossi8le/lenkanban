import { describe, expect, it } from "vitest";
import { calendarDateToDayKey, dayKeyToCalendarDate, formatMyDayHeading, msUntilNextMoscowMidnight, shiftDayKey } from "./my-day-dates";

describe("diary calendar navigation", () => {
  it.each([["2026-10-31", 1, "2026-11-01"], ["2026-01-01", -1, "2025-12-31"], ["2024-02-28", 1, "2024-02-29"], ["2026-02-28", 1, "2026-03-01"]] as const)("shifts %s by %s calendar days", (date, delta, expected) => {
    expect(shiftDayKey(date, delta)).toBe(expected);
    expect(calendarDateToDayKey(dayKeyToCalendarDate(expected))).toBe(expected);
  });
  it("formats the correct Russian weekday", () => expect(formatMyDayHeading("2026-10-29")).toBe("Четверг, 29 октября 2026"));
  it("schedules refresh at Moscow midnight even across months", () => {
    expect(msUntilNextMoscowMidnight(new Date("2026-10-31T20:59:58Z"))).toBe(2100);
    expect(msUntilNextMoscowMidnight(new Date("2026-10-31T21:00:00Z"))).toBe(86_400_100);
  });
});
