import { describe, expect, it } from "vitest";
import { measureWorkingTime } from "./working-time";

describe("working-time bounded input snapshots", () => {
  it("does not invoke an array-supplied iterator", () => {
    const windows = [{ start: 0, end: 10 }];
    windows[Symbol.iterator] = () => { throw new Error("custom iterator must not run"); };
    expect(measureWorkingTime({ from: 0, to: 10, workingWindows: windows })).toEqual({ ok: true, elapsedMs: 10 });
  });

  it("validates and measures the same endpoint snapshot", () => {
    let startReads = 0;
    let endReads = 0;
    const window = { get start() { startReads += 1; return startReads === 1 ? 0 : 90; }, get end() { endReads += 1; return endReads === 1 ? 10 : 100; } };
    expect(measureWorkingTime({ from: 0, to: 100, workingWindows: [window] })).toEqual({ ok: true, elapsedMs: 10 });
    expect(startReads).toBe(1);
    expect(endReads).toBe(1);
  });

  it("unions before adding lengths at the supported input and integer limits", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const workingWindows = Array.from({ length: 10_000 }, () => ({ start: 0, end: maximum }));
    expect(measureWorkingTime({ from: 0, to: maximum, workingWindows, pauses: [{ start: 1, end: 2 }] }))
      .toEqual({ ok: true, elapsedMs: maximum - 1 });
  });

  it("fails closed for a throwing input getter without exposing its value", () => {
    expect(measureWorkingTime({ get from() { throw new Error("synthetic-private-input"); }, to: 10, workingWindows: [] }))
      .toEqual({ ok: false, reason: "invalid_input" });
  });
});
