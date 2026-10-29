import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskChat } from "./useTaskChat";

const boundary = vi.hoisted(() => ({ socket: null as unknown }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => boundary.socket }));

type Listener = (...args: unknown[]) => void;
class SocketBoundary {
  connected = true;
  listeners = new Map<string, Set<Listener>>();
  joins: { taskId: string; ack: (response: unknown) => void }[] = [];
  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: Listener) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, payload: { taskId: string }, ack: (response: unknown) => void) {
    if (event === "task:join") this.joins.push({ ...payload, ack });
  }
  receive(event: string, ...args: unknown[]) {
    if (event === "disconnect" || event === "connect_error") this.connected = false;
    if (event === "connect") this.connected = true;
    for (const listener of [...this.listeners.get(event) ?? []]) listener(...args);
  }
}

let socket: SocketBoundary;
beforeEach(() => { vi.useFakeTimers(); socket = new SocketBoundary(); boundary.socket = socket; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("task chat room membership", () => {
  it("joins the requested task only after successful ACK", () => {
    const { result } = renderHook(() => useTaskChat({ taskId: "alpha" }));
    expect(result.current.isJoined).toBe(false);
    expect(socket.joins[0].taskId).toBe("alpha");
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(true);
    expect(result.current.lastError).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports timeout, stays unjoined and rejects a late ACK", () => {
    const { result } = renderHook(() => useTaskChat({ taskId: "alpha" }));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.lastError).toBeTruthy();
    expect(result.current.isJoined).toBe(false);
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(false);
  });

  it.each([{ ok: false, error: "AccessDenied" }, undefined, { ok: "true" }])(
    "rejects malformed or denied ACK %j", (response) => {
      const { result } = renderHook(() => useTaskChat({ taskId: "alpha" }));
      act(() => socket.joins[0].ack(response));
      expect(result.current.isJoined).toBe(false);
      expect(result.current.lastError).toBeTruthy();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores the old connection ACK until the reconnect join is acknowledged", () => {
    const { result } = renderHook(() => useTaskChat({ taskId: "alpha" }));
    act(() => socket.receive("disconnect"));
    expect(result.current.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    act(() => socket.receive("connect"));
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(false);
    act(() => socket.joins[1].ack({ ok: true }));
    expect(result.current.isJoined).toBe(true);
    expect(result.current.isConnected).toBe(true);
  });

  it("ignores ACK received while disconnected", () => {
    const { result } = renderHook(() => useTaskChat({ taskId: "alpha" }));
    act(() => socket.receive("disconnect"));
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(false);
  });

  it("clears membership and reports connection errors, then resets on reconnect", () => {
    const { result } = renderHook(() => useTaskChat({ taskId: "alpha" }));
    act(() => socket.joins[0].ack({ ok: true }));
    act(() => socket.receive("connect_error", new Error("Transport failed")));
    expect(result.current.isJoined).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.lastError).toBe("Transport failed");
    act(() => socket.receive("connect"));
    expect(result.current.lastError).toBeNull();
    expect(result.current.isJoined).toBe(false);
  });

  it("cancels old timers and callbacks on task change and unmount", () => {
    const { result, rerender, unmount } = renderHook(
      ({ taskId }) => useTaskChat({ taskId }), { initialProps: { taskId: "alpha" } },
    );
    rerender({ taskId: "beta" });
    expect(vi.getTimerCount()).toBe(1);
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(false);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("resets connection state when the task is removed", () => {
    const { result, rerender } = renderHook(
      ({ taskId }: { taskId: string | null }) => useTaskChat({ taskId }),
      { initialProps: { taskId: "alpha" as string | null } },
    );
    act(() => socket.joins[0].ack({ ok: true }));
    rerender({ taskId: null });
    expect(result.current.socket).toBeNull();
    expect(result.current.isJoined).toBe(false);
    expect(result.current.isConnected).toBe(false);
  });
});
