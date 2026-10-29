import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { info, warn, error } = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: {
    info,
    warn,
    error
  }
}));
import { withApiLogging } from "./api-logger";
import { validCorrelationId } from "@/lib/telemetry-sanitize";
it("labels the existing handler-return interval explicitly", async () => {
  await withApiLogging(new Request("https://app.invalid/api/tasks"), async () => new Response(null), { route: "/api/tasks" });
  expect(info).toHaveBeenCalledWith(expect.objectContaining({ durationKind: "handler" }));
});
it("coalesces same-Request nested wrappers into one handler record and identity", async () => {
  const request = new Request("https://app.invalid/api/tasks");
  const response = await withApiLogging(request, input => withApiLogging(input, async () => new Response(null), { route: "/api/tasks" }), { route: "/api/tasks" });
  expect(info).toHaveBeenCalledOnce();
  expect(info.mock.calls[0][0].requestId).toBe(response.headers.get("x-request-id"));
});
beforeEach(() => {
  info.mockReset();
  warn.mockReset();
  error.mockReset();
});
const actionId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
it.each([[200, "success", info], [403, "rejected", warn], [409, "conflict", warn], [503, "failure", error]] as const)("records returned %i and preserves body/status with correlation header", async (status, outcome, sink) => {
  const request = new NextRequest("https://app.invalid/api/tasks/real-id?token=private", {
    headers: {
      "X-Action-Id": actionId
    }
  });
  let requestId: string | undefined;
  const response = await withApiLogging(request, async (_, context) => {
    requestId = context.requestId;
    return new Response("result", {
      status
    });
  }, {
    route: "/api/tasks/:id",
    actorId: "actor-1"
  });
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("result");
  expect(response.headers.get("X-Request-Id")).toBe(requestId);
  if (status >= 400) {
    const errorId = response.headers.get("X-Error-Id");
    expect(validCorrelationId(errorId)).toBe(true);
    expect(sink.mock.calls[0][0].errorId).toBe(errorId);
  } else {
    expect(response.headers.has("X-Error-Id")).toBe(false);
  }
  expect(sink).toHaveBeenCalledOnce();
  expect(sink.mock.calls[0][0]).toMatchObject({
    requestId,
    actionId,
    route: "/api/tasks/:id",
    outcome,
    statusCode: status,
    actorId: "actor-1"
  });
  expect(JSON.stringify(sink.mock.calls)).not.toContain("private");
  expect(info.mock.calls.length + warn.mock.calls.length + error.mock.calls.length).toBe(1);
});
it("handles immutable redirect headers", async () => {
  const result = await withApiLogging(new NextRequest("https://app.invalid"), async () => Response.redirect("https://app.invalid/login"));
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe("https://app.invalid/login");
  expect(result.headers.get("x-request-id")).toBeTruthy();
});
it("preserves success and original thrown value when sink fails", async () => {
  info.mockImplementation(() => {
    throw Error("sink offline");
  });
  error.mockImplementation(() => {
    throw Error("sink offline");
  });
  const request = new NextRequest("https://app.invalid");
  expect((await withApiLogging(request, async () => new Response(null, {
    status: 204
  }))).status).toBe(204);
  const original = Error("original");
  await expect(withApiLogging(request, async () => {
    throw original;
  })).rejects.toBe(original);
});
it("isolates overlapping requests and gives retries different request IDs", async () => {
  const request = () => new NextRequest("https://app.invalid", {
    headers: {
      "x-action-id": actionId
    }
  });
  const responses = await Promise.all(["one", "two"].map(actorId => withApiLogging(request(), async () => {
    await Promise.resolve();
    return new Response(null);
  }, {
    actorId
  })));
  const records = info.mock.calls.map(call => call[0]);
  expect(records.map(record => record.actorId).sort()).toEqual(["one", "two"]);
  expect(records[0].requestId).not.toBe(records[1].requestId);
  expect(responses.map(response => response.headers.get("x-request-id")).sort()).toEqual(records.map(record => record.requestId).sort());
});
it("ignores a forged native capability and actor headers in the direct fallback", async () => {
  const forged = "11111111-1111-4111-8111-111111111111";
  const response = await withApiLogging(new NextRequest("https://app.invalid/api/tasks/private", {
    headers: { "x-request-id": forged, "x-lenkanban-api-observation": forged + "." + "0".repeat(32) + "." + "0".repeat(64), "x-actor-id": "forgedActor" }
  }), async () => new Response(null), { route: "/api/tasks/:id" });
  expect(info).toHaveBeenCalledOnce();
  expect(info.mock.calls[0][0]).toMatchObject({ durationKind: "handler", requestId: response.headers.get("x-request-id") });
  expect(info.mock.calls[0][0]).not.toHaveProperty("actorId");
  expect(response.headers.get("x-request-id")).not.toBe(forged);
});

it("assigns new server error IDs to handled failures instead of trusting incoming or response IDs", async () => {
  const forged = "bc3dab9f-39e9-4d14-9b58-f709c418b701";
  const responses = await Promise.all([400, 401, 403, 409, 500].map(status => withApiLogging(
    new NextRequest("https://app.invalid/api/tasks/1", { headers: { "X-Action-Id": actionId, "X-Error-Id": forged, "X-Request-Id": forged } }),
    async () => new Response("business error", { status, headers: { "X-Error-Id": forged, "X-Request-Id": forged } }),
    { route: "/api/tasks/:id" },
  )));
  const ids = responses.map(response => response.headers.get("X-Error-Id"));
  expect(new Set(ids).size).toBe(5);
  const records = [...warn.mock.calls, ...error.mock.calls].map(([record]) => record);
  for (const response of responses) {
    const errorId = response.headers.get("X-Error-Id");
    expect(validCorrelationId(errorId)).toBe(true);
    expect(errorId).not.toBe(forged);
    expect(response.headers.get("X-Request-Id")).not.toBe(forged);
    expect(records.find(record => record.errorId === errorId)).toMatchObject({ requestId: response.headers.get("X-Request-Id"), statusCode: response.status });
  }
});

it("keeps thrown values unchanged while recording a fresh safe error ID for the attempt", async () => {
  const thrown = { private: "synthetic-sensitive-thrown-object" };
  const request = new NextRequest("https://app.invalid/api/tasks/1", { headers: { "X-Action-Id": actionId } });
  await expect(withApiLogging(request, async () => { throw thrown; }, { route: "/api/tasks/:id" })).rejects.toBe(thrown);
  expect(error).toHaveBeenCalledTimes(1);
  const record = error.mock.calls[0][0];
  expect(validCorrelationId(record.errorId)).toBe(true);
  expect(validCorrelationId(record.requestId)).toBe(true);
  expect(record).toMatchObject({ actionId, outcome: "failure", event: "api.request.failed", statusCode: 500 });
  // The wrapper logs through the existing sanitizer; it does not fabricate an HTTP response.
});
