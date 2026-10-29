import { StrictMode, useEffect, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNotificationSocket } from "./useNotificationSocket";

const controls = vi.hoisted(() => ({
  createConnection: vi.fn(),
  session: { data: { user: { id: "actor-a" } } as { user: { id: string } } | null, status: "authenticated" },
  navigate: vi.fn(),
  queryClient: { clear: vi.fn(), removeQueries: vi.fn(), invalidateQueries: vi.fn(async (options: { queryKey: readonly unknown[] }) => { void options; }) },
}));
vi.mock("next-auth/react", () => ({ useSession: () => controls.session }));
vi.mock("@/lib/socket-client", () => ({ createSocketConnection: controls.createConnection }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: controls.navigate }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => controls.queryClient }));

type Listener = (...args: unknown[]) => void;
class TestSocket {
  connected = false;
  listeners = new Map<string, Set<Listener>>();
  acknowledgements: ((response: unknown) => void)[] = [];
  constructor(readonly id: string) {}
  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit = vi.fn((event: string, acknowledge?: (response: unknown) => void) => {
    if (event === "notification:join" && acknowledge) this.acknowledgements.push(acknowledge);
    return this;
  });
  receive(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
  connect() { this.connected = true; this.receive("connect"); }
  disconnect = vi.fn(() => {
    this.connected = false;
    this.receive("disconnect", "transport close");
    return this;
  });
}

let sockets: TestSocket[] = [];
function Consumer({ name }: { name: string }) {
  const { socket, connected } = useNotificationSocket();
  const [events, setEvents] = useState(0);
  useEffect(() => {
    if (!socket) return;
    const receive = () => setEvents(value => value + 1);
    socket.on("notification:new", receive);
    return () => { socket.off("notification:new", receive); };
  }, [socket]);
  return <output data-testid={name}>{socket?.id ?? "none"}:{String(connected)}:{events}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  controls.session = { data: { user: { id: "actor-a" } }, status: "authenticated" };
  controls.createConnection.mockReset().mockImplementation(() => {
    const socket = new TestSocket(`socket-${sockets.length + 1}`);
    sockets.push(socket);
    return socket;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('refreshes queue and notification counts once for shared consumers without project join', async () => {
  render(<><Consumer name="queue" /><Consumer name="browser-notification" /></>);
  act(() => sockets[0].connect());
  expect(sockets[0].listeners.get('request:queue:invalidated')?.size ?? 0).toBe(0);
  act(() => sockets[0].acknowledgements[0]({ ok: true }));
  controls.queryClient.invalidateQueries.mockClear();
  act(() => sockets[0].receive('request:queue:invalidated', { count: 2, taskId: 'private' }));
  expect(controls.queryClient.invalidateQueries).not.toHaveBeenCalled();
  act(() => sockets[0].receive('request:queue:invalidated', {}));
  expect(controls.queryClient.invalidateQueries.mock.calls.map(([options]) => options.queryKey)).toEqual([
    ['request-queue-unseen', 'actor-a'], ['tasks'], ['my-tasks', 'actor-a'], ['task'], ['task-lifecycle'], ['notifications', 'actor-a'],
  ]);
  expect(sockets[0].emit.mock.calls.some(([event]) => event === 'project:join')).toBe(false);
  expect(screen.getByTestId('queue')).toHaveTextContent('socket-1:true:0');
  await act(async () => undefined);
  controls.queryClient.invalidateQueries.mockClear();
  act(() => sockets[0].receive('request:queue:invalidated', {}));
  expect(controls.queryClient.invalidateQueries).toHaveBeenCalledTimes(6);
});
it('reconciles a read in another tab once per personal connection without a new-notification popup', async () => {
  render(<><Consumer name="one"/><Consumer name="two"/></>);
  act(() => { sockets[0].connect(); sockets[0].acknowledgements[0]({ ok: true }); });
  controls.queryClient.invalidateQueries.mockClear();
  act(() => sockets[0].receive('notification:changed', { version: 1, taskId: 'private' }));
  expect(controls.queryClient.invalidateQueries).not.toHaveBeenCalled();
  act(() => sockets[0].receive('notification:changed', { version: 1 }));
  expect(controls.queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
  expect(controls.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['notifications', 'actor-a'] });
  expect(screen.getByTestId('one')).toHaveTextContent('socket-1:true:0');
  await act(async () => undefined);
  const stale = [...sockets[0].listeners.get('notification:changed')!][0];
  act(() => sockets[0].disconnect()); controls.queryClient.invalidateQueries.mockClear();
  act(() => stale({ version: 1 }));
  expect(controls.queryClient.invalidateQueries).not.toHaveBeenCalled();
});

it('rejects late queue callbacks after disconnect, account switch and A-to-B-to-A replacement', () => {
  const view = render(<Consumer name="queue" />);
  act(() => { sockets[0].connect(); sockets[0].acknowledgements[0]({ ok: true }); });
  const stale = [...sockets[0].listeners.get('request:queue:invalidated')!][0];
  controls.queryClient.invalidateQueries.mockClear();
  act(() => { sockets[0].disconnect(); stale({}); });
  expect(controls.queryClient.invalidateQueries).not.toHaveBeenCalled();
  controls.session = { data: { user: { id: 'actor-b' } }, status: 'authenticated' };
  view.rerender(<Consumer name="queue" />);
  act(() => stale({}));
  expect(controls.queryClient.invalidateQueries).not.toHaveBeenCalled();
  controls.session = { data: { user: { id: 'actor-a' } }, status: 'authenticated' };
  view.rerender(<Consumer name="queue" />);
  act(() => { sockets[2].connect(); sockets[2].acknowledgements[0]({ ok: true }); stale({}); });
  expect(controls.queryClient.invalidateQueries).not.toHaveBeenCalled();
  act(() => sockets[2].receive('request:queue:invalidated', {}));
  expect(controls.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['request-queue-unseen', 'actor-a'] });
  view.unmount();
  expect(sockets[2].listeners.get('request:queue:invalidated')?.size ?? 0).toBe(0);
});

it("bounds a missing personal-room acknowledgement and shares one retry before joining", () => {
  render(<><Consumer name="first" /><Consumer name="second" /></>);
  act(() => sockets[0].connect());
  const stale = sockets[0].acknowledgements[0];
  act(() => vi.advanceTimersByTime(4999));
  expect(sockets[0].acknowledgements).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1));
  expect(sockets[0].acknowledgements).toHaveLength(2);
  act(() => stale({ ok: true }));
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:false");
  expect(screen.getByTestId("second")).toHaveTextContent("socket-1:false");
  act(() => sockets[0].acknowledgements[1]({ ok: true }));
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:true");
  expect(screen.getByTestId("second")).toHaveTextContent("socket-1:true");
  act(() => vi.advanceTimersByTime(30_000));
  expect(sockets[0].acknowledgements).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("exhausts one timeout retry per transport and only resets after a real disconnect", () => {
  const { rerender } = render(<Consumer key="first" name="first" />);
  act(() => sockets[0].connect());
  act(() => vi.advanceTimersByTime(60_000));
  expect(sockets[0].acknowledgements).toHaveLength(2);
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:false");
  expect(vi.getTimerCount()).toBe(0);
  rerender(<><Consumer key="first" name="first" /><Consumer key="second" name="second" /></>);
  act(() => sockets[0].receive("connect"));
  expect(sockets[0].acknowledgements).toHaveLength(2);
  act(() => { sockets[0].disconnect(); sockets[0].connect(); });
  expect(sockets[0].acknowledgements).toHaveLength(3);
  act(() => sockets[0].acknowledgements[1]({ ok: true }));
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:false");
  act(() => sockets[0].acknowledgements[2]({ ok: true }));
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:true");
});

it.each([{ ok: false, error: "AccessDenied" }, { ok: false, error: "Unauthorized" }, null])(
  "does not retry an explicit denial or malformed acknowledgement, even for another subscriber (%j)", response => {
    const { rerender } = render(<Consumer key="first" name="first" />);
    act(() => sockets[0].connect());
    act(() => sockets[0].acknowledgements[0](response));
    act(() => vi.advanceTimersByTime(60_000));
    rerender(<><Consumer key="first" name="first" /><Consumer key="second" name="second" /></>);
    expect(sockets[0].acknowledgements).toHaveLength(1);
    expect(screen.getByTestId("first")).toHaveTextContent("socket-1:false");
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps a pending shared deadline for the remaining subscriber and clears it on last unmount", () => {
  const { rerender, unmount } = render(<><Consumer key="first" name="first" /><Consumer key="second" name="second" /></>);
  act(() => sockets[0].connect());
  expect(vi.getTimerCount()).toBe(1);
  rerender(<Consumer key="second" name="second" />);
  expect(sockets[0].disconnect).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(5000));
  expect(sockets[0].acknowledgements).toHaveLength(2);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(30_000));
  expect(sockets[0].acknowledgements).toHaveLength(2);
  expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
});

it("cancels join deadlines on actor change and logout and rejects both actors' delayed acknowledgements", () => {
  const { rerender } = render(<Consumer name="consumer" />);
  act(() => sockets[0].connect());
  const stale = sockets[0].acknowledgements[0];
  controls.session = { data: { user: { id: "actor-b" } }, status: "authenticated" };
  rerender(<Consumer name="consumer" />);
  expect(vi.getTimerCount()).toBe(0);
  act(() => sockets[1].connect());
  const latest = sockets[1].acknowledgements[0];
  controls.session = { data: null, status: "unauthenticated" };
  rerender(<Consumer name="consumer" />);
  expect(vi.getTimerCount()).toBe(0);
  act(() => { vi.advanceTimersByTime(30_000); stale({ ok: true }); latest({ ok: true }); });
  expect(screen.getByTestId("consumer")).toHaveTextContent("none:false");
  expect(sockets[0].acknowledgements).toHaveLength(1);
  expect(sockets[1].acknowledgements).toHaveLength(1);
});

it("cancels pending admission immediately on auth revocation without logging payloads", () => {
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  render(<Consumer name="consumer" />);
  act(() => sockets[0].connect());
  const stale = sockets[0].acknowledgements[0];
  act(() => sockets[0].receive("auth.revoked", { userId: "actor-a", reason: "synthetic-revocation" }));
  expect(controls.queryClient.clear).toHaveBeenCalledTimes(1);
  expect(controls.navigate).toHaveBeenCalledWith("/sign-in");
  expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  act(() => { vi.advanceTimersByTime(30_000); stale({ ok: true }); });
  expect(screen.getByTestId("consumer")).toHaveTextContent("none:false");
  expect(sockets[0].acknowledgements).toHaveLength(1);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("clears a pending deadline on transport disconnect and rejects its ACK after reconnect", () => {
  render(<Consumer name="consumer" />);
  act(() => sockets[0].connect());
  const stale = sockets[0].acknowledgements[0];
  act(() => { vi.advanceTimersByTime(2000); sockets[0].disconnect(); });
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(10_000));
  expect(sockets[0].acknowledgements).toHaveLength(1);
  act(() => { sockets[0].connect(); stale({ ok: true }); });
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:false");
  act(() => sockets[0].acknowledgements[1]({ ok: true }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:true");
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the deadline for an acknowledgement just before five seconds without a retry", () => {
  render(<Consumer name="consumer" />);
  act(() => sockets[0].connect());
  act(() => vi.advanceTimersByTime(4999));
  expect(sockets[0].acknowledgements).toHaveLength(1);
  act(() => sockets[0].acknowledgements[0]({ ok: true }));
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(30_000));
  expect(sockets[0].acknowledgements).toHaveLength(1);
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:true");
});

it("disposes one pending shared socket for both revoked subscribers without retry or late ACK", () => {
  render(<><Consumer name="first" /><Consumer name="second" /></>);
  act(() => sockets[0].connect());
  const stale = sockets[0].acknowledgements[0];
  act(() => sockets[0].receive("auth.revoked", { userId: "actor-a", reason: "synthetic-revocation" }));
  expect(screen.getByTestId("first")).toHaveTextContent("none:false");
  expect(screen.getByTestId("second")).toHaveTextContent("none:false");
  expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
  expect(controls.queryClient.clear).toHaveBeenCalled();
  expect(controls.navigate).toHaveBeenCalledWith("/sign-in");
  expect(vi.getTimerCount()).toBe(0);
  act(() => { vi.advanceTimersByTime(30_000); stale({ ok: true }); });
  expect(sockets[0].acknowledgements).toHaveLength(1);
  expect(screen.getByTestId("first")).toHaveTextContent("none:false");
  expect(screen.getByTestId("second")).toHaveTextContent("none:false");
});

it.each([null, {}, { userId: "" }, []])("does not turn malformed revocation into a disconnected session (%j)", payload => {
  render(<Consumer name="consumer" />);
  act(() => sockets[0].connect());
  act(() => sockets[0].receive("auth.revoked", payload));
  expect(controls.queryClient.clear).not.toHaveBeenCalled();
  expect(controls.navigate).not.toHaveBeenCalled();
  expect(sockets[0].disconnect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  act(() => sockets[0].acknowledgements[0]({ ok: true }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:true");
});

it("shares one actor connection, publishes its socket, and keeps remaining subscribers joined", () => {
  const { rerender, unmount } = render(<><Consumer key="first" name="first" /><Consumer key="second" name="second" /></>);
  expect(controls.createConnection).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:false:0");
  act(() => { sockets[0].connect(); sockets[0].receive("connect"); });
  expect(sockets[0].acknowledgements).toHaveLength(1);
  act(() => sockets[0].acknowledgements[0]({ ok: true }));
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:true:0");
  expect(screen.getByTestId("second")).toHaveTextContent("socket-1:true:0");
  rerender(<><Consumer key="first" name="first" /></>);
  expect(sockets[0].disconnect).not.toHaveBeenCalled();
  expect(sockets[0].emit.mock.calls.filter(([event]) => event === "notification:leave")).toHaveLength(0);
  act(() => sockets[0].receive("notification:new", { content: "synthetic-private-value" }));
  expect(screen.getByTestId("first")).toHaveTextContent("socket-1:true:1");
  unmount();
  expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
  expect(sockets[0].emit.mock.calls.filter(([event]) => event === "notification:leave")).toHaveLength(1);
  expect([...sockets[0].listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
});

it("joins a transport that was already connected and waits for a successful acknowledgement", () => {
  controls.createConnection.mockImplementationOnce(() => {
    const socket = new TestSocket("ready-socket");
    socket.connected = true;
    sockets.push(socket);
    return socket;
  });
  render(<Consumer name="consumer" />);
  expect(sockets[0].acknowledgements).toHaveLength(1);
  act(() => sockets[0].acknowledgements[0]({ ok: false }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("ready-socket:false");
  act(() => { sockets[0].disconnect(); sockets[0].connect(); });
  act(() => sockets[0].acknowledgements[1]({ ok: true }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("ready-socket:true");
});

it("ignores out-of-order acknowledgements across reconnects and never logs transport data", () => {
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  render(<Consumer name="consumer" />);
  act(() => sockets[0].connect());
  const stale = sockets[0].acknowledgements[0];
  act(() => { sockets[0].disconnect(); sockets[0].connect(); });
  const current = sockets[0].acknowledgements[1];
  act(() => stale({ ok: true, secret: "synthetic-ack-secret" }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:false");
  act(() => current({ ok: true }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:true");
  act(() => current({ ok: false }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:true");
  act(() => stale({ ok: false }));
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:true");
  act(() => sockets[0].receive("connect_error", new Error("synthetic-error-secret")));
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-1:false");
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("disconnects and resets on logout and actor changes, rejecting old acknowledgement callbacks", () => {
  const { rerender } = render(<><Consumer name="first" /><Consumer name="second" /></>);
  act(() => sockets[0].connect());
  const oldAck = sockets[0].acknowledgements[0];
  controls.session = { data: { user: { id: "actor-b" } }, status: "authenticated" };
  rerender(<><Consumer name="first" /><Consumer name="second" /></>);
  expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
  expect(controls.createConnection).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("first")).toHaveTextContent("socket-2:false");
  act(() => { oldAck({ ok: true }); sockets[1].connect(); sockets[1].acknowledgements[0]({ ok: true }); });
  expect(screen.getByTestId("second")).toHaveTextContent("socket-2:true");
  controls.session = { data: null, status: "unauthenticated" };
  rerender(<><Consumer name="first" /><Consumer name="second" /></>);
  expect(sockets[1].disconnect).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("first")).toHaveTextContent("none:false");
  expect(screen.getByTestId("second")).toHaveTextContent("none:false");
  act(() => sockets[1].acknowledgements[0]({ ok: true }));
  expect(screen.getByTestId("first")).toHaveTextContent("none:false");
});

it("clears client caches and leaves protected pages when auth.revoked arrives", () => {
  render(<Consumer name="consumer" />);
  act(() => sockets[0].connect());
  act(() => sockets[0].acknowledgements[0]({ ok: true }));
  act(() => sockets[0].receive("auth.revoked", { userId: "actor-a", reason: "role-demoted" }));
  expect(controls.queryClient.clear).toHaveBeenCalledTimes(1);
  expect(controls.navigate).toHaveBeenCalledWith("/sign-in");
});

it("releases StrictMode's discarded connection and attaches only the current one", () => {
  const { unmount } = render(<StrictMode><Consumer name="consumer" /></StrictMode>);
  expect(sockets).toHaveLength(2);
  expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-2:false");
  act(() => { sockets[1].connect(); sockets[1].acknowledgements[0]({ ok: true }); });
  expect(screen.getByTestId("consumer")).toHaveTextContent("socket-2:true");
  unmount();
  expect(sockets[1].disconnect).toHaveBeenCalledTimes(1);
});
