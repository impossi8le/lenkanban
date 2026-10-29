import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSocketConnection, disconnectSocket, getSocketInstance } from "./socket-client";

const boundary = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock("socket.io-client", () => ({ io: (...args: unknown[]) => boundary.io(...args) }));

type Listener = (...args: unknown[]) => void;
class FakeSocket {
  disconnect = vi.fn();
  listeners = new Map<string, Listener[]>();
  anyListeners: Listener[] = [];
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); return this;
  }
  onAny(listener: Listener) { this.anyListeners.push(listener); return this; }
  receive(event: string, ...args: unknown[]) {
    for (const listener of this.anyListeners) listener(event, ...args);
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}
const created: FakeSocket[] = [];
const methods = ["debug", "info", "log", "warn", "error", "trace"] as const;
beforeEach(() => {
  created.length = 0;
  boundary.io.mockReset().mockImplementation(() => {
    const socket = new FakeSocket(); created.push(socket); return socket;
  });
  methods.forEach(method => vi.spyOn(console, method).mockImplementation(() => {}));
  vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", undefined);
});
afterEach(() => { disconnectSocket(); vi.unstubAllEnvs(); });

describe("shared socket connection configuration", () => {
  it.each([undefined, "", "   "])("uses same origin when endpoint is %j", endpoint => {
    vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", endpoint);
    createSocketConnection();
    expect(boundary.io).toHaveBeenCalledExactlyOnceWith(undefined, {
      path: "/socket.io", transports: ["polling", "websocket"], withCredentials: true, autoConnect: true,
    });
  });
  it("uses the configured endpoint with the same options", () => {
    vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", " https://socket.example.invalid ");
    createSocketConnection();
    expect(boundary.io).toHaveBeenCalledExactlyOnceWith("https://socket.example.invalid", {
      path: "/socket.io", transports: ["polling", "websocket"], withCredentials: true, autoConnect: true,
    });
  });
  it("keeps the singleton until disconnect then recreates it", () => {
    const first = getSocketInstance();
    expect(getSocketInstance()).toBe(first);
    expect(boundary.io).toHaveBeenCalledTimes(1);
    disconnectSocket(); disconnectSocket();
    expect(created[0].disconnect).toHaveBeenCalledTimes(1);
    const next = getSocketInstance();
    expect(next).not.toBe(first);
    expect(getSocketInstance()).toBe(next);
    expect(boundary.io).toHaveBeenCalledTimes(2);
  });
  it("creates independent channels without replacing the board singleton", () => {
    const board = getSocketInstance();
    const notificationA = createSocketConnection();
    const notificationB = createSocketConnection();
    expect(notificationA).not.toBe(notificationB);
    expect(notificationA).not.toBe(board);
    expect(getSocketInstance()).toBe(board);
    disconnectSocket();
    expect(created[0].disconnect).toHaveBeenCalledTimes(1);
    expect(created[1].disconnect).not.toHaveBeenCalled();
    expect(created[2].disconnect).not.toHaveBeenCalled();
  });
  it("never logs event payloads, cycles, getters, raw errors or URL secrets", () => {
    const secret = "synthetic-socket-secret-49";
    vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", `https://socket.example.invalid/?token=${secret}`);
    getSocketInstance();
    const getter = vi.fn(() => { throw new Error(secret); });
    const payload: { token: string; nested?: unknown } = { token: secret };
    payload.nested = payload;
    const unusual = Object.defineProperty({}, "secret", { enumerable: true, get: getter });
    expect(() => {
      created[0].receive("notification:new", payload, unusual);
      created[0].receive("connect_error", new Error(secret));
      created[0].receive("disconnect", secret);
      created[0].receive("connect", { token: secret });
    }).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(created[0].anyListeners).toEqual([]);
    expect([...created[0].listeners.keys()].sort()).toEqual([
      "auth.revoked", "connect", "disconnect", "project:access-revoked",
    ]);
    methods.forEach(method => expect(console[method]).not.toHaveBeenCalled());
  });
  it("preserves a creation failure without logging its raw exception", () => {
    const failure = new Error("synthetic-token-in-connection-error");
    boundary.io.mockImplementationOnce(() => { throw failure; });
    expect(() => getSocketInstance()).toThrow(failure);
    expect(() => getSocketInstance()).not.toThrow();
    expect(boundary.io).toHaveBeenCalledTimes(2);
    methods.forEach(method => expect(console[method]).not.toHaveBeenCalled());
  });
});
