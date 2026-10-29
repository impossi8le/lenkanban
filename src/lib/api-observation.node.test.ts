import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const sinks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: sinks }));
vi.mock("@/lib/telemetry/store", () => ({ recordServerRequestTelemetry: sinks.record }));
import { installNodeApiObservation, nativeApiObservationActiveCount } from "./api-observation.node";
import { API_OBSERVATION_CAPABILITY_HEADER } from "./api-observation";
import { withApiLogging } from "@/middleware/api-logger";
import { validCorrelationId } from "./telemetry-sanitize";

let server: Server | undefined, dispose: (() => void) | undefined;
const records = () => [...sinks.info.mock.calls, ...sinks.warn.mock.calls, ...sinks.error.mock.calls].map(call => call[0]);
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("No isolated port");
  return address.port;
}
function get(port: number, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; id?: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: pathname, headers, agent: false }, res => {
      res.resume(); res.on("end", () => resolve({ status: res.statusCode!, id: res.headers["x-request-id"] as string | undefined }));
    }); req.once("error", reject); req.end();
  });
}
function webRequest(req: IncomingMessage) {
  return new Request(`http://127.0.0.1${req.url}`, { headers: req.headers as Record<string, string>, method: req.method });
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false"); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  dispose?.(); dispose = undefined; vi.unstubAllEnvs();
});

it("observes the cold FIRST native request once and ignores forged IDs/private capabilities", async () => {
  dispose = installNodeApiObservation();
  expect(installNodeApiObservation()).toBe(dispose);
  const forged = "11111111-1111-4111-8111-111111111111";
  let privateOverwritten = false;
  const port = await listen((req, res) => {
    privateOverwritten = req.headers[API_OBSERVATION_CAPABILITY_HEADER] !== forged;
    res.statusCode = 403; res.end("PRIVATE response");
  });
  const response = await get(port, "/api/tasks/PRIVATE?password=PRIVATE", { "x-request-id": forged, [API_OBSERVATION_CAPABILITY_HEADER]: forged, "x-actor-id": "forgedActor" });
  await vi.waitFor(() => expect(records()).toHaveLength(1));
  expect(privateOverwritten).toBe(true); expect(validCorrelationId(response.id)).toBe(true); expect(response.id === forged).toBe(false);
  expect(records()[0]).toMatchObject({ requestId: response.id, route: "/api/tasks/:id", method: "GET", statusCode: 403, durationKind: "http", outcome: "rejected" });
  expect(records()[0]).not.toHaveProperty("actorId");
  expect(JSON.stringify(records())).not.toMatch(/PRIVATE|password|forgedActor|capability|cookie/i);
  expect(nativeApiObservationActiveCount()).toBe(0);
});

it("enriches native requests with verified wrapper context, retains HTTP errors and deduplicates nesting", async () => {
  vi.stubEnv("TELEMETRY_ENABLED", "true");
  dispose = installNodeApiObservation();
  const port = await listen((req, res) => {
    void withApiLogging(webRequest(req), inner => withApiLogging(inner, async (_, context) => {
      context.actorId = "verifiedActor"; context.projectId = "verifiedProject";
      return new Response(null, { status: 409 });
    }, { route: "/api/tasks/:id/checklist/:itemId" }), { route: "/api/tasks/:id/checklist/:itemId" }).then(result => {
      res.statusCode = result.status; for (const [key, value] of result.headers) res.setHeader(key, value); res.end();
    });
  });
  const response = await get(port, "/api/tasks/a/checklist/b");
  await vi.waitFor(() => expect(records()).toHaveLength(1));
  expect(records()[0]).toMatchObject({ requestId: response.id, actorId: "verifiedActor", projectId: "verifiedProject", statusCode: 409, outcome: "conflict", durationKind: "http", handlerDurationMs: expect.any(Number) });
  await vi.waitFor(() => expect(sinks.record).toHaveBeenCalledOnce());
  expect(sinks.record.mock.calls[0][0]).toMatchObject({ requestId: response.id, durationKind: "handler", actorId: "verifiedActor", statusCode: 409 });
  expect(nativeApiObservationActiveCount()).toBe(0);
});

it("isolates concurrent verified actors and overwrites a captured capability on a new native request", async () => {
  dispose = installNodeApiObservation();
  let captured = "";
  const port = await listen((req, res) => {
    captured ||= req.headers[API_OBSERVATION_CAPABILITY_HEADER] as string;
    const actorId = req.url === "/api/tasks/a" ? "actorA" : "actorB";
    void withApiLogging(webRequest(req), async (_, context) => {
      context.actorId = actorId; await Promise.resolve(); return new Response(null);
    }, { route: "/api/tasks/:id" }).then(result => { res.statusCode = result.status; res.end(); });
  });
  await get(port, "/api/tasks/a");
  await Promise.all([get(port, "/api/tasks/b", { [API_OBSERVATION_CAPABILITY_HEADER]: captured }), get(port, "/api/tasks/a")]);
  await vi.waitFor(() => expect(records()).toHaveLength(3));
  expect(records().map(row => row.actorId).sort()).toEqual(["actorA", "actorA", "actorB"]);
  expect(new Set(records().map(row => row.requestId)).size).toBe(3);
  expect(nativeApiObservationActiveCount()).toBe(0);
});

it.each([false, true])("records real client abort (headers already sent=%s), cleans state and suppresses late wrapper duplicates", async headersSent => {
  dispose = installNodeApiObservation();
  let release!: () => void, admitted!: () => void, done!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { admitted = resolve; }), completed = new Promise<void>(resolve => { done = resolve; });
  const port = await listen((req, res) => {
    const input = webRequest(req);
    if (headersSent) { res.writeHead(200); res.write("PRIVATE partial body"); }
    admitted();
    void blocked.then(() => withApiLogging(input, async (_, context) => {
      context.actorId = "lateActor"; return new Response(null);
    }, { route: "/api/tasks/:id" })).finally(done);
  });
  const client = httpRequest({ host: "127.0.0.1", port, path: "/api/tasks/a", agent: false });
  client.on("error", () => undefined); client.on("response", response => { response.on("error", () => undefined); response.resume(); }); client.end();
  try {
    await seen; client.destroy();
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]).toMatchObject({ event: "api.request.failed", durationKind: "http", outcome: "aborted" });
    if (headersSent) expect(records()[0].statusCode).toBe(200); else expect(records()[0]).not.toHaveProperty("statusCode");
    expect(nativeApiObservationActiveCount()).toBe(0);
  } finally { release(); await completed; }
  expect(records()).toHaveLength(1);
});

it("keeps unrelated HTTP and caller error handling intact and survives hostile subscriber/sink inputs", async () => {
  dispose = installNodeApiObservation();
  expect(() => channel("http.server.request.start").publish(new Proxy({}, { get() { throw Error("PRIVATE"); } }))).not.toThrow();
  const original = new Error("PRIVATE application error"); let retained = false;
  const port = await listen((req, res) => {
    if (req.url === "/public") { res.statusCode = 204; res.end(); return; }
    try { throw original; } catch (error) { retained = error === original; res.statusCode = 418; res.end(); }
  });
  expect((await get(port, "/public")).status).toBe(204); expect(records()).toHaveLength(0);
  expect((await get(port, "/api/unregistered/PRIVATE")).status).toBe(418); expect(retained).toBe(true);
  expect(records()[0]).toMatchObject({ route: "/api/:unmatched", statusCode: 418 });
  sinks.warn.mockImplementationOnce(() => { throw Error("PRIVATE sink"); });
  expect((await get(port, "/api/unregistered/PRIVATE")).status).toBe(418);
  expect(nativeApiObservationActiveCount()).toBe(0);
});

it("labels an existing HTTP timeout response without imposing a timeout or changing its status", async () => {
  dispose = installNodeApiObservation();
  const port = await listen((_req, res) => { res.statusCode = 408; res.end(); });
  expect((await get(port, "/api/tasks")).status).toBe(408);
  expect(records()[0]).toMatchObject({ statusCode: 408, outcome: "timeout", durationKind: "http" });
});
