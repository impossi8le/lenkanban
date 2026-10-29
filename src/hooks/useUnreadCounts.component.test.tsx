import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnreadCounts } from "./useUnreadCounts";

const boundary = vi.hoisted(() => ({ socket: null as unknown, fetch: vi.fn(), actor: "actor-1" as string | undefined, status: "authenticated" }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { id: boundary.actor } }, status: boundary.status }) }));
vi.mock("@/lib/socket-client", () => ({ getSocketInstance: () => boundary.socket }));
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => boundary.fetch(...args) }));

type Listener = (...args: unknown[]) => void;
class SocketBoundary {
  connected = true;
  listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: Listener) { this.listeners.get(event)?.delete(listener); }
  receive(event: string) {
    if (event === "connect") this.connected = true;
    if (event === "disconnect" || event === "connect_error") this.connected = false;
    for (const listener of [...this.listeners.get(event) ?? []]) listener();
  }
}

let socket: SocketBoundary;
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

beforeEach(() => {
  boundary.actor = "actor-1"; boundary.status = "authenticated";
  vi.useFakeTimers();
  socket = new SocketBoundary();
  boundary.socket = socket;
  boundary.fetch.mockReset().mockResolvedValue({ byProject: {}, byTask: {}, total: 0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

describe("unread counts fallback polling", () => {
  it("refreshes once per event when desktop and mobile both subscribe", async () => {
    renderHook(() => [useUnreadCounts(), useUnreadCounts()], { wrapper });
    await flush();
    expect(boundary.fetch).toHaveBeenCalledTimes(1);
    act(() => socket.receive("message:new"));
    await flush();
    expect(boundary.fetch).toHaveBeenCalledTimes(2);
    act(() => socket.receive("message:read"));
    await flush();
    expect(boundary.fetch).toHaveBeenCalledTimes(3);
    expect(boundary.fetch.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) });
  });
  it("does not poll while the socket is connected", async () => {
    socket.connected = true;
    renderHook(() => useUnreadCounts(), { wrapper });
    await flush();
    expect(boundary.fetch).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });

    expect(boundary.fetch).toHaveBeenCalledTimes(1);
  });

  it("polls while the socket is disconnected", async () => {
    socket.connected = false;
    renderHook(() => useUnreadCounts(), { wrapper });
    await flush();
    expect(boundary.fetch).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });

    expect(boundary.fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stops polling once the socket reconnects and refreshes missed state", async () => {
    socket.connected = false;
    renderHook(() => useUnreadCounts(), { wrapper });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(boundary.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);

    act(() => socket.receive("connect"));
    await flush();
    const afterReconnect = boundary.fetch.mock.calls.length;
    expect(afterReconnect).toBeGreaterThanOrEqual(3);

    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(boundary.fetch).toHaveBeenCalledTimes(afterReconnect);
  });

  it("resumes polling after the socket disconnects", async () => {
    socket.connected = true;
    renderHook(() => useUnreadCounts(), { wrapper });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(boundary.fetch).toHaveBeenCalledTimes(1);

    act(() => socket.receive("disconnect"));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
    expect(boundary.fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

it("does not fetch or subscribe before authentication and never reuses another actor's cached counts", async () => {
  boundary.status = "loading";
  client.setQueryData(["unread-counts", "actor-1"], { byProject: { private: 6 }, byTask: {}, total: 6 });
  const view = renderHook(() => useUnreadCounts(), { wrapper });
  await flush();
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(view.result.current.total).toBe(0);
  expect(socket.listeners.size).toBe(0);
  boundary.status = "authenticated";
  view.rerender();
  await flush();
  boundary.fetch.mockImplementation(() => new Promise(() => {}));
  boundary.actor = "actor-2";
  view.rerender();
  expect(view.result.current.byProject).toEqual({});
  expect(view.result.current.total).toBe(0);
  boundary.status = "unauthenticated";
  view.rerender();
  expect(view.result.current.byProject).toEqual({});
});
