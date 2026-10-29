import { describe, expect, it } from "vitest";
import { readTelemetryJson } from "./http";

function request(body: string, contentType = "application/json") {
  return new Request("https://app.example/api/tasks/task", { method: "PATCH", body,
    headers: { "content-type": contentType } });
}

describe("bounded JSON reader options", () => {
  it.each([0, -1, NaN, Infinity, 1.5, 256 * 1024 + 1])("rejects invalid maximum %s", async maxBytes => {
    await expect(readTelemetryJson(request("{}"), { maxBytes })).rejects.toMatchObject({ status: 400 });
  });
  it("retains the16KiB default while explicitly allowing a bounded larger command", async () => {
    const body = JSON.stringify({ description: "я".repeat(10000) });
    await expect(readTelemetryJson(request(body))).rejects.toMatchObject({ status: 413 });
    await expect(readTelemetryJson(request(body), { maxBytes: 256 * 1024 })).resolves.toEqual(JSON.parse(body));
  });
  it("counts actual UTF8 bytes even with the larger limit option", async () => {
    const body = JSON.stringify({ value: "я".repeat(20) });
    expect(body.length).toBeLessThan(50);
    await expect(readTelemetryJson(request(body), { maxBytes: 50 })).rejects.toMatchObject({ status: 413 });
  });
  it("keeps strict JSON by default and makes legacy acceptance explicit", async () => {
    await expect(readTelemetryJson(request("{}", "text/plain"))).rejects.toMatchObject({ status: 415 });
    await expect(readTelemetryJson(request("{}", "text/plain"), { requireJsonContentType: false })).resolves.toEqual({});
    await expect(readTelemetryJson(request("not-json", "text/plain"), { requireJsonContentType: false })).rejects.toMatchObject({ status: 400 });
  });
  it("rejects an invalid content-type option instead of weakening validation", async () => {
    await expect(readTelemetryJson(request("{}"), { requireJsonContentType: "false" as unknown as boolean }))
      .rejects.toMatchObject({ status: 400 });
  });
});
