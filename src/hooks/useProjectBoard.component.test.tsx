import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectBoard } from "./useProjectBoard";

const boundary = vi.hoisted(() => ({ socket: null as unknown }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => boundary.socket }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

type Listener = (...args: unknown[]) => void;
class SocketBoundary {
  connected = true;
  listeners = new Map<string, Set<Listener>>();
  joins: { projectId: string; ack: (response: unknown) => void }[] = [];
  leaves: string[] = [];
  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  once(event: string, listener: Listener) {
    const once: Listener = (...args) => { this.off(event, once); listener(...args); };
    this.on(event, once);
  }
  off(event: string, listener: Listener) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, payload: { projectId: string }, ack: (response: unknown) => void) {
    if (event === "project:join") this.joins.push({ ...payload, ack });
    if (event === "project:leave") this.leaves.push(payload.projectId);
  }
  receive(event: string, ...args: unknown[]) {
    if (event === "disconnect" || event === "connect_error") this.connected = false;
    if (event === "connect") this.connected = true;
    for (const listener of [...this.listeners.get(event) ?? []]) listener(...args);
  }
}

let socket: SocketBoundary;
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  vi.useFakeTimers();
  socket = new SocketBoundary();
  boundary.socket = socket;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("project room membership", () => {
  it("keeps the board subscribed when an overlapping task panel closes", () => {
    const board = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    const panel = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    panel.unmount();
    expect(socket.leaves).toEqual([]);
    board.unmount();
    expect(socket.leaves).toEqual(["alpha"]);
  });
  it("waits for the matching join ACK, ignoring unrelated joined events", () => {
    const { result } = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    act(() => socket.receive("project:joined", { projectId: "other" }));
    expect(result.current.isJoined).toBe(false);
    expect(socket.joins[0].projectId).toBe("alpha");
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(true);
    expect(result.current.lastError).toBeNull();
  });

  it("reports a timeout without granting membership and ignores a late ACK", () => {
    const { result } = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.isJoined).toBe(false);
    expect(result.current.lastError).toBeTruthy();
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(false);
  });

  it.each([{ ok: false, error: "AccessDenied" }, undefined, { ok: "true" }])(
    "reports rejected or malformed ACK %j without granting membership", (response) => {
      const { result } = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
      act(() => socket.joins[0].ack(response));
      expect(result.current.isJoined).toBe(false);
      expect(result.current.lastError).toBeTruthy();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("invalidates a pending join on disconnect and requires the reconnect ACK", () => {
    const { result } = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    act(() => socket.receive("disconnect"));
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.isConnected).toBe(false);
    act(() => socket.receive("connect"));
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(false);
    act(() => socket.joins[1].ack({ ok: true }));
    expect(result.current.isJoined).toBe(true);
    expect(result.current.isConnected).toBe(true);
  });

  it("clears membership and reports connect_error, then clears the error on reconnect", () => {
    const { result } = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    act(() => socket.joins[0].ack({ ok: true }));
    act(() => socket.receive("connect_error", new Error("Transport failed")));
    expect(result.current.isJoined).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.lastError).toBe("Transport failed");
    act(() => socket.receive("connect"));
    expect(result.current.lastError).toBeNull();
    expect(result.current.isJoined).toBe(false);
  });

  it("cancels pending timers and callbacks when the project changes or unmounts", () => {
    const { result, rerender, unmount } = renderHook(
      ({ projectId }) => useProjectBoard({ projectId }), { wrapper, initialProps: { projectId: "alpha" } },
    );
    rerender({ projectId: "beta" });
    expect(vi.getTimerCount()).toBe(1);
    act(() => socket.joins[0].ack({ ok: true }));
    expect(result.current.isJoined).toBe(false);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("clears the revoked project's cache and leaves its board once", () => {
    client.setQueryData(["tasks", "alpha"], [{ id: "t1" }]);
    client.setQueryData(["tasks", "beta"], [{ id: "t2" }]);
    const first = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    const second = renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    act(() => socket.receive("project:access-revoked", { projectId: "alpha" }));
    const keys = client.getQueryCache().getAll().map(query => query.queryKey);
    expect(keys).toEqual([["tasks", "beta"]]);
    first.unmount();
    second.unmount();
    // The board and its task panel share one room; the leave is sent once.
    expect(socket.leaves).toEqual(["alpha"]);
  });

  it("ignores a revocation for another project", () => {
    client.setQueryData(["tasks", "alpha"], [{ id: "t1" }]);
    renderHook(() => useProjectBoard({ projectId: "alpha" }), { wrapper });
    act(() => socket.receive("project:access-revoked", { projectId: "beta" }));
    expect(client.getQueryCache().getAll().map(query => query.queryKey)).toEqual([["tasks", "alpha"]]);
  });

  it("resets connection state when project is removed", () => {
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string | null }) => useProjectBoard({ projectId }),
      { wrapper, initialProps: { projectId: "alpha" as string | null } },
    );
    act(() => socket.joins[0].ack({ ok: true }));
    rerender({ projectId: null });
    expect(result.current.socket).toBeNull();
    expect(result.current.isJoined).toBe(false);
    expect(result.current.isConnected).toBe(false);
  });
});
