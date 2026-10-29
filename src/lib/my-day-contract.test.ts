import { describe, expect, it } from "vitest";
import { isDayKey, todayMoscow } from "./my-day-contract";

describe("diary calendar dates", () => {
  it.each(["2024-02-29", "2026-01-01", "2026-12-31"])("accepts calendar day %s", day => expect(isDayKey(day)).toBe(true));
  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "2026-1-01", "2026-01-01T00:00:00Z", "secret", null])("rejects invalid day %s", day => expect(isDayKey(day)).toBe(false));
  it("uses Moscow midnight across month and year boundaries", () => {
    expect(todayMoscow(new Date("2026-10-31T20:59:59Z"))).toBe("2026-10-31");
    expect(todayMoscow(new Date("2026-10-31T21:00:00Z"))).toBe("2026-11-01");
    expect(todayMoscow(new Date("2026-12-31T21:00:00Z"))).toBe("2027-01-01");
  });
});
