import { describe, expect, it } from "vitest";
import {
  AttachmentBusyError, MAX_CONCURRENT_DECODES, MAX_QUEUED_DECODES, withDecodeSlot,
} from "./decode-gate";

describe("attachment decode gate", () => {
  it("bounds concurrent decodes and rejects work beyond the bounded queue", async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const releases: Array<() => void> = [];
    const work = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => { releases.push(resolve); });
      active -= 1;
      completed += 1;
    };

    const total = MAX_CONCURRENT_DECODES + MAX_QUEUED_DECODES;
    const running = Array.from({ length: total }, () => withDecodeSlot(work));
    await expect(withDecodeSlot(work)).rejects.toBeInstanceOf(AttachmentBusyError);
    expect(peak).toBe(MAX_CONCURRENT_DECODES);

    for (let guard = 0; completed < total && guard < total * 10; guard += 1) {
      releases.shift()?.();
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    await Promise.all(running);
    expect(completed).toBe(total);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_DECODES);
  });
});
