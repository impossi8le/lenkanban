import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sinks = vi.hoisted(() => ({ record: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: sinks.info, warn: sinks.warn, error: sinks.error } }));
vi.mock("@/lib/telemetry/store", () => ({ recordServerRequestTelemetry: sinks.record }));
import { withApiLogging } from "./api-logger";

const actionId = "11111111-1111-4111-8111-111111111111";
const route = "/api/tasks/:id/checklist/:itemId";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  sinks.record.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

function request() {
  return new Request("https://app.test/api/tasks/task1/checklist/item1?private=SECRET", {
    method: "PATCH", headers: { "X-Action-Id": actionId, "X-Request-Id": actionId },
  });
}
async function settleImports() {
  // Real dynamic import is asynchronous; this bounded macrotask drains its
  // promise and a potentially rejected telemetry sink without touching business.
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("API technical outcome bridges to product diagnostics", () => {
  it.each([200, 400, 409, 500, 503])("shares response request/error IDs for status %s", async (status) => {
    const response = await withApiLogging(request(), async (_, context) => {
      context.actorId = "verifiedActor";
      context.projectId = "verifiedProject";
      return new Response("business body", { status, headers: { "X-Business": "kept" } });
    }, { route });
    await vi.waitFor(() => expect(sinks.record).toHaveBeenCalledOnce());
    const input = sinks.record.mock.calls[0][0];
    expect(input).toMatchObject({ actorId: "verifiedActor", projectId: "verifiedProject", actionId, route,
      event: "api.request.completed", method: "PATCH", statusCode: status,
      requestId: response.headers.get("X-Request-Id"), durationMs: expect.any(Number) });
    expect(input.requestId).not.toBe(actionId); // inbound request ID is not authoritative
    if (status >= 400) expect(input.errorId).toBe(response.headers.get("X-Error-Id"));
    else expect(input.errorId).toBeUndefined();
    expect(response.headers.get("X-Business")).toBe("kept");
    expect(await response.text()).toBe("business body");
    expect(JSON.stringify(input)).not.toMatch(/private|SECRET|business body/);
  });

  it("keeps the original thrown error and shares one error ID with Pino", async () => {
    const original = Error("private error message");
    await expect(withApiLogging(request(), async (_, context) => {
      context.actorId = "verifiedActor";
      throw original;
    }, { route })).rejects.toBe(original);
    await vi.waitFor(() => expect(sinks.record).toHaveBeenCalledOnce());
    expect(sinks.record.mock.calls[0][0]).toMatchObject({ event: "api.request.failed", statusCode: 500,
      errorId: sinks.error.mock.calls[0][0].errorId, requestId: sinks.error.mock.calls[0][0].requestId, err: original });
  });

  it.each(["reject", "throw"])("does not alter a successful response when telemetry sink %s", async (kind) => {
    if (kind === "reject") sinks.record.mockRejectedValue(Error("private sink failure"));
    else sinks.record.mockImplementation(() => { throw Error("private sink failure"); });
    const response = await withApiLogging(request(), async (_, context) => {
      context.actorId = "verifiedActor";
      return Response.json({ business: "success" }, { status: 201 });
    }, { route });
    await settleImports();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ business: "success" });
  });

  it("does not replace a business exception when both diagnostic sinks fail", async () => {
    sinks.record.mockRejectedValue(Error("private collector failure"));
    sinks.error.mockImplementation(() => { throw Error("private log failure"); });
    const original = Error("business failure");
    await expect(withApiLogging(request(), async () => { throw original; }, { route, actorId: "verifiedActor" }))
      .rejects.toBe(original);
    await settleImports();
  });

  it.each([
    ["/api/telemetry", "verifiedActor"], ["/api/telemetry/cleanup", "verifiedActor"],
    ["/api/admin/telemetry", "verifiedActor"], ["/api/admin/telemetry/summary", "verifiedActor"],
    ["/api/admin/telemetry/errors/:errorId", "verifiedActor"], [route, undefined],
  ])("excludes noncatalog/noactor route %s from analytics", async (template, actorId) => {
    expect((await withApiLogging(request(), async () => new Response("ok"), { route: template, actorId })).status).toBe(200);
    await settleImports();
    expect(sinks.record).not.toHaveBeenCalled();
    expect(sinks.info).toHaveBeenCalledOnce();
  });

  it("does no analytics when explicitly disabled", async () => {
    vi.stubEnv("TELEMETRY_ENABLED", "false");
    await withApiLogging(request(), async () => new Response("ok"), { route, actorId: "verifiedActor" });
    await settleImports();
    expect(sinks.record).not.toHaveBeenCalled(); expect(sinks.info).toHaveBeenCalledOnce();
  });
});
