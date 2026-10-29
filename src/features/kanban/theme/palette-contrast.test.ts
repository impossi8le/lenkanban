import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = postcss.parse(readFileSync(resolve(process.cwd(), "src/app/design-system.css"), "utf8"));
function tokens(selector: string) {
  const values: Record<string, string> = {};
  css.walkRules(selector, (rule) => { rule.walkDecls((decl) => { values[decl.prop] = decl.value; }); });
  return values;
}
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/.{2}/g)!.map((v) => parseInt(v, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + .05) / (dark + .05);
}

describe.each([":root", ".dark"])("%s accessible theme pairs", (theme) => {
  const palette = { ...tokens(":root"), ...tokens(theme) };
  it.each([
    ["--foreground", "--background"], ["--card-foreground", "--card"],
    ["--muted-foreground", "--card"], ["--muted-foreground", "--muted"],
    ["--text-tertiary", "--background"], ["--primary-foreground", "--primary"],
    ["--primary-foreground", "--primary-hover"], ["--destructive-foreground", "--destructive"],
    ["--accent-foreground", "--accent"], ["--popover-foreground", "--popover"],
    ["--danger-bright", "--danger-muted"], ["--warning-bright", "--warning-muted"],
    ["--urgent-bright", "--urgent-muted"], ["--success-bright", "--success-muted"],
    ["--info-bright", "--info-muted"],
  ])("%s on %s meets WCAG AA for normal text", (foreground, background) => {
    expect(contrast(palette[foreground], palette[background])).toBeGreaterThanOrEqual(4.5);
  });
  it("input borders are visible against their surface", () => {
    expect(contrast(palette["--input"], palette["--card"])).toBeGreaterThanOrEqual(3);
  });
});

const calendarSource = readFileSync(resolve(process.cwd(), "src/components/ui/calendar.tsx"), "utf8");
const calendarClassNames = [
  "months", "month", "month_caption", "caption_label", "nav", "button_previous",
  "button_next", "chevron", "dropdowns", "dropdown_root", "dropdown", "month_grid",
  "weekdays", "weekday", "week", "day", "day_button", "range_start", "range_end",
  "selected", "today", "outside", "disabled", "range_middle", "hidden",
];
function calendarClass(key: string) {
  const start = calendarSource.indexOf(`\n        ${key}:`);
  if (start < 0) return "";
  const next = calendarClassNames
    .map((name) => calendarSource.indexOf(`\n        ${name}:`, start + 1))
    .filter((index) => index > start)
    .sort((a, b) => a - b)[0];
  return calendarSource.slice(start, next ?? calendarSource.length);
}

describe("calendar navigation and inactive days", () => {
  it.each(["button_previous", "button_next", "outside", "disabled"])(
    "%s keeps readable content instead of fading it with opacity",
    (key) => {
      expect(calendarClass(key)).not.toMatch(/\bopacity-50\b/);
    },
  );

  it.each(["button_previous", "button_next"])(
    "%s uses an explicit muted icon color and an opaque disabled state",
    (key) => {
      expect(calendarClass(key)).toContain("text-muted-foreground");
      // DayPicker marks unavailable navigation with aria-disabled, not disabled.
      expect(calendarClass(key)).toContain("aria-disabled:text-[var(--text-disabled)]");
    },
  );

  it("day buttons override the shared button variant's disabled fade", () => {
    expect(calendarClass("day_button")).toContain("disabled:text-muted-foreground");
    expect(calendarClass("day_button")).toContain("disabled:opacity-100");
  });

  it.each(["--card", "--popover"])(
    "outside and disabled day text meets WCAG AA on %s",
    (surface) => {
      for (const theme of [":root", ".dark"]) {
        const palette = { ...tokens(":root"), ...tokens(theme) };
        expect(calendarClass("outside")).toContain("text-muted-foreground");
        expect(calendarClass("disabled")).toContain("text-muted-foreground");
        expect(contrast(palette["--muted-foreground"], palette[surface])).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(["--card", "--popover"])(
    "the disabled navigation icon stays distinguishable on %s",
    (surface) => {
      for (const theme of [":root", ".dark"]) {
        const palette = { ...tokens(":root"), ...tokens(theme) };
        expect(calendarClass("button_previous")).toContain("disabled:text-[var(--text-disabled)]");
        expect(calendarClass("button_next")).toContain("disabled:text-[var(--text-disabled)]");
        expect(contrast(palette["--text-disabled"], palette[surface])).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each(["--card", "--popover"])(
    "the calendar navigation border is visible on %s",
    (surface) => {
      for (const theme of [":root", ".dark"]) {
        const palette = { ...tokens(":root"), ...tokens(theme) };
        expect(contrast(palette["--input"], palette[surface])).toBeGreaterThanOrEqual(3);
      }
    },
  );
});
