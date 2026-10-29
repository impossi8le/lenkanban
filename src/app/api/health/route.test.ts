import { afterEach, expect, it, vi } from "vitest";
import { GET, dynamic, runtime } from "./route";

afterEach(() => vi.useRealTimers());

it("returns fresh public liveness without disclosing release metadata", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    status: "ok", timestamp: "2026-10-22T10:00:00.000Z",
  });
  vi.advanceTimersByTime(1000);
  expect((await GET().json()).timestamp).toBe("2026-10-22T10:00:01.000Z");
  expect(runtime).toBe("nodejs");
  expect(dynamic).toBe("force-dynamic");
});
