import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createInternalEmitRequestHandler, type InternalEmitHandlerOptions } from "./internal-emit-handler";

const secret = "test-bridge-secret";
const task = { id: "task-1", projectId: "project-1" };
const payload = { event: "task:updated", roomId: "project:project-1", data: task };

function fixture(options: InternalEmitHandlerOptions = { secret }) {
  const request = Object.assign(new EventEmitter(), {
    method: "POST", url: "/internal/emit",
    headers: { authorization: `Bearer ${secret}` } as Record<string, string | string[] | undefined>,
    socket: { remoteAddress: "127.0.0.1" },
  });
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const handler = createInternalEmitRequestHandler({ to }, options);
  const finish = (value: unknown = payload) => {
    request.emit("data", Buffer.from(JSON.stringify(value)));
    request.emit("end");
  };
  const expectStatus = (status: number) => {
    expect(response.writeHead).toHaveBeenCalledExactlyOnceWith(status, { "Content-Type": "application/json" });
    expect(response.end).toHaveBeenCalledOnce();
  };
  return { request, response, emit, to, handler, finish, expectStatus };
}

describe("createInternalEmitRequestHandler", () => {
  it("does not write a fallback response for Socket.IO requests", () => {
    const request = Object.assign(new EventEmitter(), {
      method: "GET",
      url: "/socket.io/?EIO=4&transport=polling",
    });
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const handler = createInternalEmitRequestHandler({
      to: vi.fn(),
    });

    handler(request, response);

    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });

  it("emits valid internal bridge payloads and returns success", () => {
    const request = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/internal/emit",
    });
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    Object.assign(request, { headers: { authorization: `Bearer ${secret}` }, socket: { remoteAddress: "127.0.0.1" } });
    const handler = createInternalEmitRequestHandler({ to }, { secret });
    const data = { id: "task-1", projectId: "1" };

    handler(request, response);
    request.emit(
      "data",
      JSON.stringify({ event: "task:updated", roomId: "project:1", data }),
    );
    request.emit("end");

    expect(to).toHaveBeenCalledWith("project:1");
    expect(emit).toHaveBeenCalledWith("task:updated", data);
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it.each(["/internal/emit-evil", "/internal/emit/extra"])("leaves unrelated path %s untouched", (url) => {
    const f = fixture(); f.request.url = url;
    f.handler(f.request, f.response);
    expect(f.response.writeHead).not.toHaveBeenCalled();
    expect(f.response.end).not.toHaveBeenCalled();
    expect(f.request.listenerCount("data")).toBe(0);
    expect(f.to).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "OPTIONS"])("rejects method %s before reading body", (method) => {
    const f = fixture(); f.request.method = method;
    f.handler(f.request, f.response); f.expectStatus(405);
    expect(f.request.listenerCount("data")).toBe(0);
    expect(f.to).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " ", "has space", "line\nsecret", "tab\tsecret", "nul\0secret", "nonascii-é"])("fails closed with invalid secret %j", (configuredSecret) => {
    const f = fixture({ secret: configuredSecret });
    f.handler(f.request, f.response); f.expectStatus(503);
    expect(f.request.listenerCount("data")).toBe(0);
    expect(f.to).not.toHaveBeenCalled();
    expect(JSON.stringify(f.response.end.mock.calls)).not.toContain(secret);
  });

  it.each([undefined, "", "Bearer wrong", `bearer ${secret}`, `Bearer ${secret} `, [`Bearer ${secret}`], [`Bearer ${secret}`, "Bearer wrong"]])("rejects invalid bearer %j without consuming body", (header) => {
    const f = fixture(); f.request.headers.authorization = header;
    f.handler(f.request, f.response); f.expectStatus(401);
    expect(f.request.listenerCount("data")).toBe(0);
    expect(f.to).not.toHaveBeenCalled();
    expect(JSON.stringify(f.response.end.mock.calls)).not.toContain(secret);
  });

  it.each(["192.0.2.1", "::ffff:192.0.2.1", "127.0.0.2", ""])("rejects nonloopback %s despite correct bearer", (remoteAddress) => {
    const f = fixture(); f.request.socket.remoteAddress = remoteAddress;
    f.handler(f.request, f.response); f.expectStatus(403);
    expect(f.request.listenerCount("data")).toBe(0);
    expect(f.to).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("emits authenticated task from %s", (remoteAddress) => {
    const f = fixture(); f.request.socket.remoteAddress = remoteAddress;
    f.handler(f.request, f.response); f.finish(); f.expectStatus(200);
    expect(f.to).toHaveBeenCalledExactlyOnceWith(payload.roomId);
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(payload.event, task);
  });

  it.each(["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.2.3", "::ffff:172.18.0.2", "::ffff:ac12:2", "0:0:0:0:0:ffff:ac12:2"])("allows authenticated private peer %s only with opt-in", remoteAddress => {
    const denied = fixture({ secret });
    denied.request.socket.remoteAddress = remoteAddress;
    denied.handler(denied.request, denied.response);
    denied.expectStatus(403);
    const f = fixture({ secret, allowPrivateNetwork: true });
    f.request.socket.remoteAddress = remoteAddress;
    f.handler(f.request, f.response); f.finish(); f.expectStatus(200);
    expect(f.emit).toHaveBeenCalledWith(payload.event, payload.data);
  });

  it.each(["10.0.0.1", "::ffff:172.18.0.2"])("requires the bearer even for opted-in private peer %s", remoteAddress => {
    const f = fixture({ secret, allowPrivateNetwork: true });
    f.request.socket.remoteAddress = remoteAddress;
    f.request.headers.authorization = "Bearer wrong";
    f.handler(f.request, f.response); f.expectStatus(401);
    expect(f.request.listenerCount("data")).toBe(0);
    expect(f.emit).not.toHaveBeenCalled();
  });

  it.each(["172.15.255.255", "172.32.0.1", "192.169.0.1", "8.8.8.8", "::ffff:8.8.8.8", "::ffff:808:808", "fc00::1", "169.254.1.1", "127.0.0.2", "10.00.0.1", "10.0.0.256", "10.1", "10.0.0.1:3556", ""])("rejects non-RFC1918 or malformed peer %s even with opt-in", remoteAddress => {
    const f = fixture({ secret, allowPrivateNetwork: true });
    f.request.socket.remoteAddress = remoteAddress;
    f.request.headers["x-forwarded-for"] = "172.18.0.2";
    f.handler(f.request, f.response); f.expectStatus(403);
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("keeps recipient dispatch mandatory when configured for private transport", async () => {
    const dispatch = vi.fn(async () => { throw new Error("recipient denied"); });
    const f = fixture({ secret, allowPrivateNetwork: true, dispatch });
    f.request.socket.remoteAddress = "172.18.0.2";
    f.handler(f.request, f.response); f.finish();
    await vi.waitFor(() => f.expectStatus(500));
    expect(dispatch).toHaveBeenCalledWith(payload.event, payload.roomId, payload.data);
    expect(f.emit).not.toHaveBeenCalled();
  });

  it.each([
    { event: "task:created", data: task },
    { event: "task:deleted", data: { taskId: "task-1", projectId: "project-1" } },
    { event: "task:moved", data: { operationId: "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93", boardRevision: 2, task: { id: "task-1", columnId: "column-2", version: 1, status: "IN_PROGRESS" } } },
    { event: "column:created", data: { id: "column-1", projectId: "project-1" } },
    { event: "column:updated", data: { id: "column-1", projectId: "project-1" } },
    { event: "column:deleted", data: { columnId: "column-1", projectId: "project-1" } },
    { event: "columns:reordered", data: [{ id: "column-1", projectId: "project-1", position: 0 }, { id: "column-2", projectId: "project-1", position: 1 }] },
    // Current member route selects id/role/user, without a projectId field.
    { event: "project:members:updated", data: { id: "member-1", role: "MEMBER", user: { id: "user-1" } } },
    { event: "project:member:deleted", data: { projectId: "project-1", memberId: "member-1" } },
  ])("accepts existing $event shape", ({ event, data }) => {
    const f = fixture(); f.handler(f.request, f.response);
    f.finish({ event, roomId: payload.roomId, data }); f.expectStatus(200);
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(event, data);
  });

  it.each([
    null, [], {},
    { ...payload, event: "notification:new" },
    { ...payload, event: "unknown:event" },
    { ...payload, roomId: "user:user-1" },
    { ...payload, roomId: "project:" },
    { ...payload, data: { id: "task-1", projectId: "other" } },
    { ...payload, data: { id: "" } },
    { ...payload, data: { taskId: "task-1" } },
    { ...payload, data: [] },
    { ...payload, event: "task:deleted", data: { taskId: "" } },
    { ...payload, event: "columns:reordered", data: [{ id: "column-1", projectId: "other" }] },
    { ...payload, event: "columns:reordered", data: [{ id: "" }] },
    { ...payload, event: "columns:reordered", data: {} },
    { ...payload, event: "project:members:updated", data: { id: "" } },
    { ...payload, event: "project:member:deleted", data: { memberId: "" } },
    ...[-1, 1.5, "1"].map(version => ({ ...payload, event: "task:moved", data: { operationId: "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93", boardRevision: 2, task: { id: "task-1", columnId: "column-1", version, status: "TODO" } } })),
    { ...payload, event: "task:moved", data: { operationId: "bad", boardRevision: 2, task: { id: "task-1", columnId: "column-1", version: 1, status: "TODO" } } },
    { ...payload, event: "task:moved", data: { operationId: "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93", boardRevision: -1, task: { id: "task-1", columnId: "column-1", version: 1, status: "TODO" } } },
    { ...payload, event: "task:moved", data: { operationId: "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93", boardRevision: 2, task: { id: "task-1", columnId: "column-1", version: 1, status: "TODO", projectId: "other" } } },
  ])("rejects malformed/foreign payload %#", (value) => {
    const f = fixture(); f.handler(f.request, f.response);
    f.finish(value); f.expectStatus(400);
    expect(f.to).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with one safe response", () => {
    const f = fixture(); f.handler(f.request, f.response);
    f.request.emit("data", "{private"); f.request.emit("end"); f.request.emit("end");
    f.expectStatus(400); expect(f.to).not.toHaveBeenCalled();
    expect(JSON.stringify(f.response.end.mock.calls)).not.toContain("private");
  });

  it("counts UTF-8 bytes across chunks and responds 413 exactly once", () => {
    const f = fixture({ secret, maxBodyBytes: 3 }); f.handler(f.request, f.response);
    f.request.emit("data", "é"); expect(f.response.end).not.toHaveBeenCalled();
    f.request.emit("data", "é"); f.request.emit("data", Buffer.from("ignored"));
    f.request.emit("end"); f.request.emit("error", Error("private"));
    f.expectStatus(413); expect(f.to).not.toHaveBeenCalled();
  });

  it("preserves UTF-8 split between buffer chunks at the exact limit", () => {
    const value = { ...payload, data: { ...task, title: "Заявка" } };
    const bytes = Buffer.from(JSON.stringify(value));
    const split = bytes.indexOf(Buffer.from("З")) + 1;
    const f = fixture({ secret, maxBodyBytes: bytes.length }); f.handler(f.request, f.response);
    f.request.emit("data", bytes.subarray(0, split)); f.request.emit("data", bytes.subarray(split)); f.request.emit("end");
    f.expectStatus(200); expect(f.emit).toHaveBeenCalledWith(value.event, value.data);
  });

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])("bounds the body limit with option %s", (maxBodyBytes) => {
    const f = fixture({ secret, maxBodyBytes }); f.handler(f.request, f.response);
    f.request.emit("data", Buffer.alloc(256 * 1024 + 1)); f.request.emit("end");
    f.expectStatus(413); expect(f.to).not.toHaveBeenCalled();
  });

  it("rejects unknown chunks without coercing hostile objects", () => {
    const f = fixture(); f.handler(f.request, f.response);
    const stringify = vi.fn(() => { throw Error("private"); });
    expect(() => f.request.emit("data", { toString: stringify })).not.toThrow();
    f.finish(); f.expectStatus(400);
    expect(stringify).not.toHaveBeenCalled(); expect(f.to).not.toHaveBeenCalled();
  });

  it("handles request errors and throwing diagnostic callbacks without emitting", () => {
    const onError = vi.fn(() => { throw Error("diagnostic failure"); });
    const f = fixture({ secret, onError }); f.handler(f.request, f.response);
    const original = Error("private request failure");
    expect(() => f.request.emit("error", original)).not.toThrow();
    f.finish(); f.expectStatus(500);
    expect(onError).toHaveBeenCalledWith(original); expect(f.to).not.toHaveBeenCalled();
    expect(JSON.stringify(f.response.end.mock.calls)).not.toContain("private");
  });

  it.each(["to", "emit"] as const)("returns one safe 500 when io.%s and diagnostics throw", (failure) => {
    const f = fixture({ secret, onError: () => { throw Error("diagnostic failure"); } });
    const explode = () => { throw Error("private io failure"); };
    if (failure === "to") f.to.mockImplementation(explode); else f.emit.mockImplementation(explode);
    f.handler(f.request, f.response); expect(() => f.finish()).not.toThrow();
    f.request.emit("end"); f.expectStatus(500);
    expect(JSON.stringify(f.response.end.mock.calls)).not.toContain("private");
  });
});
