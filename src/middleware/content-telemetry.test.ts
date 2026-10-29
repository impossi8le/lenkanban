import { afterEach, expect, it, vi } from "vitest";
const sink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry/store", () => ({ recordServerRequestTelemetry: sink }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { withApiLogging } from "./api-logger";

afterEach(() => { sink.mockReset(); vi.unstubAllEnvs(); });
// `/api/tasks/:id/attachments` has no POST handler (only PATCH for metadata);
// real uploads use /api/uploads/direct and presign/finalize, so it is not a
// logged server route and asserting otherwise would claim a non-existent event.
it.each(["/api/tasks/:id/messages"])("forwards %s completion with no body or query", async route => {
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  const request = new Request("https://app.invalid/private?query=synthetic-private-query", {
    method: "POST", body: JSON.stringify({ contentText: "synthetic-private-comment", name: "synthetic-private-file.pdf" }),
  });
  const result = await withApiLogging(request, async () => new Response(null, { status: 201 }), { route, actorId: "actor" });
  expect(result.status).toBe(201);
  await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
  expect(sink.mock.calls[0][0]).toMatchObject({ route, actorId: "actor", event: "api.request.completed", method: "POST", statusCode: 201 });
  expect(JSON.stringify(sink.mock.calls)).not.toContain("synthetic-private");
  // The wrapper never consumes the body, including multipart uploads.
  expect(request.bodyUsed).toBe(false);
});
