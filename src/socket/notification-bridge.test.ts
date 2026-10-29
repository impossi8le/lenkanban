import { EventEmitter } from "node:events";
import type { Notification } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitUserNotification } from "./board-events";
import { isInternalEmitPayload } from "./internal-emit-contract";
import { createInternalEmitRequestHandler } from "./internal-emit-handler";

const sink = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ socketLogger: sink }));
const serviceSecret = "synthetic-notification-service-credential";
const row: Notification = {
  id: "notice-1", userId: "actor-1", type: "task_assigned", title: "synthetic-title",
  message: "synthetic-private-message", actionUrl: "/my-tasks", metadata: {},
  read: false, readAt: null, createdAt: new Date("2026-10-21T10:00:00Z"),
};
beforeEach(() => {
  vi.stubEnv("INTERNAL_EMIT_SECRET", serviceSecret);
  vi.stubEnv("SOCKET_PORT", "3556");
  vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function requestFixture(envelope: unknown, remoteAddress = "127.0.0.1", authorization = `Bearer ${serviceSecret}`) {
  const req = Object.assign(new EventEmitter(), {
    method: "POST", url: "/internal/emit", headers: { authorization }, socket: { remoteAddress },
  });
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  createInternalEmitRequestHandler({ to }, { secret: serviceSecret })(req, res);
  req.emit("data", JSON.stringify(envelope)); req.emit("end");
  return { to, emit, res };
}

describe("personal notifications through the existing internal bridge", () => {
  it("sends the committed row to its exact personal room using the existing signed loopback transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    emitUserNotification(row);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3556/internal/emit");
    expect(options.headers.Authorization).toBe(`Bearer ${serviceSecret}`);
    const envelope = JSON.parse(options.body);
    expect(envelope).toEqual({ event: "notification:new", roomId: "user:actor-1", data: { ...row, createdAt: row.createdAt.toISOString() } });
    const f = requestFixture(envelope);
    expect(f.res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(f.to).toHaveBeenCalledExactlyOnceWith("user:actor-1");
    expect(f.emit).toHaveBeenCalledExactlyOnceWith("notification:new", envelope.data);
    await Promise.resolve();
    expect(sink.error).not.toHaveBeenCalled();
  });

  it.each([
    { roomId: "project:actor-1", data: row },
    { roomId: "user:actor-2", data: row },
    { roomId: "user:actor-1,actor-2", data: row },
    { roomId: "user:actor-1", data: { ...row, id: "" } },
    { roomId: "user:actor-1", data: { ...row, read: "false" } },
    { roomId: "user:actor-1", data: { ...row, userId: undefined } },
  ])("rejects a malformed or mismatched recipient envelope", input => {
    const envelope = { event: "notification:new", ...input };
    expect(isInternalEmitPayload(envelope)).toBe(false);
    const f = requestFixture(envelope);
    expect(f.res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(f.to).not.toHaveBeenCalled();
  });

  it.each([
    ["192.0.2.1", `Bearer ${serviceSecret}`, 403],
    ["127.0.0.1", "Bearer synthetic-wrong", 401],
  ] as const)("retains bridge authentication for %s", (address, authorization, status) => {
    const f = requestFixture({ event: "notification:new", roomId: "user:actor-1", data: row }, address, authorization);
    expect(f.res.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
    expect(f.to).not.toHaveBeenCalled();
  });

  it("does not grant project events access to personal rooms", () => {
    const f = requestFixture({ event: "task:updated", roomId: "user:actor-1", data: { id: "task-1" } });
    expect(f.res.writeHead).toHaveBeenCalledWith(400, expect.any(Object)); expect(f.to).not.toHaveBeenCalled();
  });
});
