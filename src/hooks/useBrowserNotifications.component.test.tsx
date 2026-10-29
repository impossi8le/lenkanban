import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserNotifications } from "./useBrowserNotifications";

const mocks = vi.hoisted(() => ({
  session: { data: { user: { id: "actor-a" } }, status: "authenticated" },
  socket: { on: vi.fn(), off: vi.fn() },
  connected: true,
  push: vi.fn(),
}));
const router = { push: mocks.push };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-auth/react", () => ({ useSession: () => mocks.session }));
vi.mock("@/hooks/useNotificationSocket", () => ({
  useNotificationSocket: () => ({ socket: mocks.socket, connected: mocks.connected }),
}));

class FakeNotification {
  static permission = "granted";
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(readonly title: string, readonly options?: NotificationOptions) {
    FakeNotification.instances.push(this);
  }
  close() { this.closed = true; this.onclose?.(); }
}

function handler() {
  const calls = mocks.socket.on.mock.calls.filter(([name]) => name === "notification:new");
  return calls.at(-1)![1] as (value: unknown) => Promise<void>;
}
const notification = { id: "n1", title: "New task", message: "Message", actionUrl: "/projects/p1?task=t1" };
const requestLock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
let actorSerial = 0;

function immediateLock() {
  requestLock.mockImplementation(async (...args) => {
    const callback = args.at(-1) as () => unknown;
    return callback();
  });
}

function delayNextLock() {
  let finish!: () => Promise<void>;
  requestLock.mockImplementationOnce((...args) => new Promise((resolve, reject) => {
    const callback = args.at(-1) as () => unknown;
    finish = async () => {
      try { resolve(await callback()); } catch (error) { reject(error); }
    };
  }));
  return () => finish();
}

describe("useBrowserNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session = { data: { user: { id: `actor-a-${++actorSerial}` } }, status: "authenticated" };
    mocks.connected = true;
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";
    FakeNotification.requestPermission.mockReset();
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("navigator", { locks: { request: requestLock } });
    localStorage.clear();
    requestLock.mockReset();
    immediateLock();
    vi.spyOn(window, "focus").mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows pending without a timeout and deduplicates native permission requests", async () => {
    FakeNotification.permission = "default";
    let finish!: (permission: NotificationPermission) => void;
    FakeNotification.requestPermission.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useBrowserNotifications());
    let first!: Promise<string>, second!: Promise<string>;
    act(() => { first = result.current.requestPermission(); second = result.current.requestPermission(); });
    expect(first).toBe(second);
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(result.current.permissionRequestState).toBe("pending");
    expect(result.current.permission).toBe("default");
    await act(async () => { finish("default"); await first; });
    expect(result.current.permissionRequestState).toBe("default");
    expect(result.current.permission).toBe("default");
  });

  it.each(["granted", "denied"] as const)("reports the native %s result", async permission => {
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockResolvedValue(permission);
    const { result } = renderHook(() => useBrowserNotifications());
    await act(async () => { await result.current.requestPermission(); });
    expect(result.current.permissionRequestState).toBe(permission);
    expect(result.current.permission).toBe(permission);
  });

  it("reports unsupported when the Notification API is unavailable", async () => {
    vi.stubGlobal("Notification", undefined);
    const { result } = renderHook(() => useBrowserNotifications());
    await act(async () => { await result.current.requestPermission(); });
    expect(result.current.permissionRequestState).toBe("unsupported");
  });

  it("shows one notification for duplicate delivery and navigates safely", async () => {
    renderHook(() => useBrowserNotifications());
    await act(async () => { await Promise.all([handler()(notification), handler()(notification)]); });
    expect(FakeNotification.instances).toHaveLength(1);
    act(() => FakeNotification.instances[0].onclick?.());
    expect(mocks.push).toHaveBeenCalledWith(notification.actionUrl);
  });

  it("suppresses replay across a reconnect", async () => {
    const { rerender } = renderHook(() => useBrowserNotifications());
    await act(async () => { await handler()(notification); });
    mocks.connected = false;
    rerender();
    mocks.connected = true;
    rerender();
    await act(async () => { await handler()(notification); });
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("coalesces the same event while its cross-tab lock is pending", async () => {
    const finish = delayNextLock();
    renderHook(() => useBrowserNotifications());
    const callback = handler();
    const first = callback(notification);
    const duplicate = callback(notification);
    expect(requestLock).toHaveBeenCalledOnce();
    expect(FakeNotification.instances).toHaveLength(0);
    await act(async () => { await finish(); await Promise.all([first, duplicate]); });
    expect(FakeNotification.instances).toHaveLength(1);
    await act(async () => { await callback(notification); });
    expect(requestLock).toHaveBeenCalledOnce();
  });

  it("rejects an old actor while waiting for the cross-tab lock", async () => {
    const finish = delayNextLock();
    const { rerender } = renderHook(() => useBrowserNotifications());
    const oldCallback = handler();
    const pending = oldCallback(notification);
    mocks.session.data.user.id += "-other";
    rerender();
    await act(async () => { await finish(); await pending; });
    expect(FakeNotification.instances).toHaveLength(0);
    expect(mocks.push).not.toHaveBeenCalled();
    await act(async () => { await handler()(notification); });
    expect(FakeNotification.instances).toHaveLength(1);
    act(() => FakeNotification.instances[0].onclick?.());
    expect(mocks.push).toHaveBeenCalledOnce();
  });

  it("cancels pending delivery on disconnect but keeps a visible toast clickable", async () => {
    const { rerender } = renderHook(() => useBrowserNotifications());
    await act(async () => { await handler()(notification); });
    const visible = FakeNotification.instances[0];
    const finish = delayNextLock();
    const pending = handler()({ ...notification, id: "pending-disconnect" });
    mocks.connected = false;
    rerender();
    expect(visible.closed).toBe(false);
    await act(async () => { await finish(); await pending; });
    expect(FakeNotification.instances).toHaveLength(1);
    act(() => visible.onclick?.());
    expect(mocks.push).toHaveBeenCalledWith(notification.actionUrl);
    mocks.connected = true;
    rerender();
    await act(async () => { await handler()({ ...notification, id: "pending-disconnect" }); });
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("closes a visible toast on logout even while the socket is disconnected", async () => {
    const { rerender } = renderHook(() => useBrowserNotifications());
    await act(async () => { await handler()(notification); });
    const visible = FakeNotification.instances[0];
    mocks.connected = false;
    rerender();
    expect(visible.closed).toBe(false);
    mocks.session.status = "unauthenticated";
    rerender();
    expect(visible.closed).toBe(true);
    act(() => visible.onclick?.());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("closes visible toasts and cancels pending delivery when permission is revoked", async () => {
    renderHook(() => useBrowserNotifications());
    await act(async () => { await handler()(notification); });
    const visible = FakeNotification.instances[0];
    const finish = delayNextLock();
    const pending = handler()({ ...notification, id: "pending-revoke" });
    FakeNotification.permission = "denied";
    act(() => window.dispatchEvent(new Event("focus")));
    expect(visible.closed).toBe(true);
    await act(async () => { await finish(); await pending; });
    expect(FakeNotification.instances).toHaveLength(1);
    act(() => visible.onclick?.());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("cancels a lock-waiting notification on unmount", async () => {
    const finish = delayNextLock();
    const { unmount } = renderHook(() => useBrowserNotifications());
    const pending = handler()(notification);
    unmount();
    await act(async () => { await finish(); await pending; });
    expect(FakeNotification.instances).toHaveLength(0);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("closes old notifications and rejects old actor callbacks after switching account", async () => {
    const { rerender } = renderHook(() => useBrowserNotifications());
    const oldHandler = handler();
    await act(async () => { await oldHandler(notification); });
    const oldNotification = FakeNotification.instances[0];
    mocks.session.data.user.id += "-other";
    rerender();
    act(() => {
      oldHandler({ ...notification, id: "old-event" });
      oldNotification.onclick?.();
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(oldNotification.closed).toBe(true);
    expect(mocks.push).not.toHaveBeenCalled();
    await act(async () => { await handler()(notification); });
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("does not subscribe while the session is loading or socket room is unconfirmed", () => {
    mocks.session.status = "loading";
    const { rerender } = renderHook(() => useBrowserNotifications());
    expect(mocks.socket.on).not.toHaveBeenCalled();
    mocks.session.status = "authenticated";
    mocks.connected = false;
    rerender();
    expect(mocks.socket.on).not.toHaveBeenCalled();
  });

  it("ignores queued callbacks after unmount", async () => {
    const { unmount } = renderHook(() => useBrowserNotifications());
    const callback = handler();
    unmount();
    await act(async () => { await callback(notification); });
    expect(FakeNotification.instances).toHaveLength(0);
  });
});
