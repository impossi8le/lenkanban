import { describe, expect, it } from "vitest";
import { parseSessionExpiry } from "./session-expiry";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const WINDOW = (24 * 60 + 5) * 60 * 1000;
const token = (expiry: number) => `v1.${String(expiry).padStart(13, "0")}.${"a".repeat(64)}`;
const iso = (expiry: number) => new Date(expiry).toISOString();

describe("coherent bounded session expiry", () => {
  it.each([1, 24 * 60 * 60 * 1000, WINDOW])("accepts future boundary offset %d", offset => {
    expect(parseSessionExpiry(token(NOW + offset), iso(NOW + offset), NOW)).toBe(NOW + offset);
  });
  it.each([-1, 0, WINDOW + 1])("rejects expired/out-of-window boundary %d", offset => {
    expect(parseSessionExpiry(token(NOW + offset), iso(NOW + offset), NOW)).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity, -1])("rejects invalid current clock %s", now => {
    expect(parseSessionExpiry(token(NOW + 1000), iso(NOW + 1000), now)).toBeNull();
  });
  it.each([
    undefined, null, {}, "", `v2.${NOW + 1000}.${"a".repeat(64)}`,
    `v1.${NOW + 1000}.${"A".repeat(64)}`, `v1.${NOW + 1000}.${"a".repeat(63)}`,
    token(NOW + 1000) + "\n", token(NOW + 1000) + "\r\n", " " + token(NOW + 1000),
  ])("rejects non-exact token format %#", value => {
    expect(parseSessionExpiry(value, iso(NOW + 1000), NOW)).toBeNull();
  });
  it.each([undefined, null, NOW + 1000, "2026-10-21T12:00:01Z", "2026-10-21T13:00:01.000+01:00", iso(NOW + 1001)])("rejects noncanonical or mismatched expiry %#", value => {
    expect(parseSessionExpiry(token(NOW + 1000), value, NOW)).toBeNull();
  });
});
