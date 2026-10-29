import { describe, expect, it } from "vitest";
import { measureWorkingTime } from "./working-time";

const invalid = { ok: false, reason: "invalid_input" };
const interval = (start: number, end: number) => ({ start, end });

describe("working time without implicit SLA policy", () => {
  it("distinguishes an unconfigured calendar from a configured empty calendar", () => {
    expect(measureWorkingTime({ from: 0, to: 100 })).toEqual({ ok: false, reason: "calendar_not_configured" });
    expect(measureWorkingTime({ from: 0, to: 100, workingWindows: [] })).toEqual({ ok: true, elapsedMs: 0 });
  });

  it.each([
    [0, 10, [interval(0, 10)], [], 10],
    [5, 15, [interval(0, 20)], [], 10],
    [0, 10, [interval(10, 20)], [], 0],
    [10, 10, [interval(0, 20)], [], 0],
    [0, 100, [interval(30, 40), interval(0, 10)], [], 20],
    [0, 20, [interval(10, 20), interval(0, 10), interval(0, 20)], [], 20],
    [0, 20, [interval(0, 20)], [interval(5, 12), interval(9, 15), interval(5, 12)], 10],
    [0, 100, [interval(10, 20), interval(40, 50)], [interval(20, 40)], 20],
    [0, 100, [interval(10, 20), interval(40, 50)], [interval(0, 100)], 0],
    [0, 100, [interval(10, 20), interval(40, 50)], [interval(15, 45)], 10],
    [0, 10, [interval(0, 10)], [interval(10, 20), interval(3, 3)], 10],
    [10, 100, [interval(0, 50), interval(40, 80)], [interval(20, 35), interval(25, 40), interval(25, 40), interval(75, 90)], 45],
    [0, 1000, [interval(100, 300), interval(400, 600)], [interval(250, 450), interval(250, 450), interval(550, 700)], 250],
  ])("measures half-open range case %#", (from, to, workingWindows, pauses, elapsedMs) => {
    expect(measureWorkingTime({ from, to, workingWindows, pauses })).toEqual({ ok: true, elapsedMs });
  });

  it("counts an explicit eight-hour shift minus a two-hour clarification", () => {
    const hour = 3_600_000;
    expect(measureWorkingTime({ from: 9 * hour, to: 17 * hour, workingWindows: [interval(9 * hour, 17 * hour)], pauses: [interval(11 * hour, 13 * hour)] }))
      .toEqual({ ok: true, elapsedMs: 6 * hour });
  });

  it.each([null, undefined, false, 0, "0", [], { from: 0, to: 10, workingWindows: null }])("rejects malformed input %#", input => {
    expect(measureWorkingTime(input)).toEqual(invalid);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined])("rejects invalid numeric endpoints %#", endpoint => {
    expect(measureWorkingTime({ from: endpoint, to: 100, workingWindows: [] })).toEqual(invalid);
    expect(measureWorkingTime({ from: 0, to: endpoint, workingWindows: [] })).toEqual(invalid);
    expect(measureWorkingTime({ from: 0, to: 100, workingWindows: [{ start: endpoint, end: 100 }] })).toEqual(invalid);
    expect(measureWorkingTime({ from: 0, to: 100, workingWindows: [], pauses: [{ start: 0, end: endpoint }] })).toEqual(invalid);
  });

  it.each([{}, null, [], false, "window", { start: 10, end: 0 }, { start: 0 }, { end: 10 }])("rejects malformed interval %#", item => {
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: [item] })).toEqual(invalid);
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: [], pauses: [item] })).toEqual(invalid);
  });

  it("validates pauses before reporting a missing calendar", () => {
    expect(measureWorkingTime({ from: 0, to: 10, pauses: null })).toEqual(invalid);
    expect(measureWorkingTime({ from: 10, to: 0 })).toEqual(invalid);
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: [], pauses: {} })).toEqual(invalid);
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: new Array(1) })).toEqual(invalid);
  });

  it("accepts the configured volume limit and rejects excess before calculation", () => {
    const maximum = Array.from({ length: 10_000 }, () => interval(0, 0));
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: maximum, pauses: maximum })).toEqual({ ok: true, elapsedMs: 0 });
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: [...maximum, interval(0, 0)] })).toEqual(invalid);
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: [], pauses: [...maximum, interval(0, 0)] })).toEqual(invalid);
  });

  it("preserves frozen input arrays and objects across repeated calculations", () => {
    const input = Object.freeze({ from: 0, to: 100, workingWindows: Object.freeze([Object.freeze(interval(20, 80)), Object.freeze(interval(0, 30))]), pauses: Object.freeze([Object.freeze(interval(10, 40))]) });
    const before = JSON.stringify(input);
    expect(measureWorkingTime(input)).toEqual({ ok: true, elapsedMs: 50 });
    expect(measureWorkingTime(input)).toEqual({ ok: true, elapsedMs: 50 });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("matches an independent integer-grid oracle and partition invariants for 1000 seeded cases", () => {
    let seed = 0x125790;
    const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    const makeIntervals = () => Array.from({ length: random(8) }, () => { const a = random(101); const b = random(101); return interval(Math.min(a, b), Math.max(a, b)); });
    for (let sample = 0; sample < 1000; sample += 1) {
      const a = random(101); const b = random(101);
      const from = Math.min(a, b); const to = Math.max(a, b);
      const workingWindows = makeIntervals(); const pauses = makeIntervals();
      // Every integer millisecond is an independent membership decision, not a merge implementation.
      let expected = 0;
      for (let tick = from; tick < to; tick += 1) {
        if (workingWindows.some(w => w.start <= tick && tick < w.end) && !pauses.some(p => p.start <= tick && tick < p.end)) expected += 1;
      }
      const input = { from, to, workingWindows, pauses };
      expect(measureWorkingTime(input)).toEqual({ ok: true, elapsedMs: expected });
      expect(measureWorkingTime({ ...input, workingWindows: [...workingWindows, ...workingWindows].reverse(), pauses: [...pauses, ...pauses].reverse() })).toEqual({ ok: true, elapsedMs: expected });
      const split = from + random(to - from + 1);
      const left = measureWorkingTime({ ...input, to: split });
      const right = measureWorkingTime({ ...input, from: split });
      expect(left.ok && right.ok && left.elapsedMs + right.elapsedMs).toBe(expected);
    }
  });
});
