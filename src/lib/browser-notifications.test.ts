import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestBrowserPermission,
  resolveBrowserPermission,
  showBrowserNotification,
  safeNotificationActionUrl,
  showBrowserNotificationOnce,
} from "./browser-notifications";

class FakeNotification {
  static permission: NotificationPermission = "default";
  static instances: FakeNotification[] = [];
  static throwOnConstruct = false;
  static requestPermission = vi.fn(async () => FakeNotification.permission);

  onclick: (() => void) | null = null;
  closed = false;

  constructor(readonly title: string, readonly options?: NotificationOptions) {
    if (FakeNotification.throwOnConstruct) throw new Error("Native constructor failed");
    FakeNotification.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

function scopeWith(permission: NotificationPermission) {
  FakeNotification.permission = permission;
  return { Notification: FakeNotification, focus: vi.fn() };
}

describe("browser notifications", () => {
  beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.throwOnConstruct = false;
    FakeNotification.requestPermission.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports unsupported when the browser API is absent", () => {
    expect(resolveBrowserPermission({})).toBe("unsupported");
    expect(showBrowserNotification({ id: "n1", title: "T", message: "M" }, { scope: {} })).toBe(false);
  });

  it("never shows a notification without granted permission", () => {
    for (const permission of ["default", "denied"] as const) {
      const scope = scopeWith(permission);
      expect(resolveBrowserPermission(scope)).toBe(permission);
      expect(showBrowserNotification({ id: "n1", title: "T", message: "M" }, { scope })).toBe(false);
    }
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("shows title, body and dedupe tag when permission is granted", () => {
    const scope = scopeWith("granted");
    expect(
      showBrowserNotification(
        { id: "notif-1", title: "Новая заявка", message: "Принтер не печатает" },
        { scope },
      ),
    ).toBe(true);
    const [created] = FakeNotification.instances;
    expect(created.title).toBe("Новая заявка");
    expect(created.options?.body).toBe("Принтер не печатает");
    expect(created.options?.tag).toBe("notif-1");
  });

  it("opens the action url and focuses the window on click", () => {
    const scope = scopeWith("granted");
    const onOpen = vi.fn();
    showBrowserNotification(
      {
        id: "notif-2",
        title: "Комментарий",
        message: "Уточните, что сломалось",
        actionUrl: "/projects/p1/board?task=t1",
      },
      { scope, onOpen },
    );
    const [created] = FakeNotification.instances;
    created.onclick?.();
    expect(onOpen).toHaveBeenCalledWith("/projects/p1/board?task=t1");
    expect(created.closed).toBe(true);
    expect(scope.focus).toHaveBeenCalled();
  });

  it("rejects an empty title", () => {
    const scope = scopeWith("granted");
    expect(showBrowserNotification({ id: "notif-3", title: "", message: "M" }, { scope })).toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it.each(["javascript:alert(1)", "https://evil.test/path", "//evil.test/path", "/\\evil.test/path", "/\n/evil.test", " /projects/p1"])("rejects unsafe action URL %s", value => {
    expect(safeNotificationActionUrl(value)).toBeNull();
  });

  it("does not focus or navigate after the actor becomes stale", () => {
    const scope = scopeWith("granted");
    const onOpen = vi.fn();
    showBrowserNotification({ id: "stale", title: "Title", message: "", actionUrl: "/projects/p1" }, {
      scope, onOpen, isCurrent: () => false,
    });
    FakeNotification.instances[0].onclick?.();
    expect(onOpen).not.toHaveBeenCalled();
    expect(scope.focus).not.toHaveBeenCalled();
    expect(FakeNotification.instances[0].closed).toBe(true);
  });

  it("never passes executable notification URLs to navigation", () => {
    const onOpen = vi.fn();
    showBrowserNotification({ id: "unsafe", title: "Title", message: "", actionUrl: "javascript:alert(1)" }, {
      scope: scopeWith("granted"), onOpen,
    });
    FakeNotification.instances[0].onclick?.();
    expect(onOpen).toHaveBeenCalledWith(null);
  });

  it("returns the permission resolved by the browser prompt", async () => {
    const scope = scopeWith("default");
    FakeNotification.permission = "granted";
    await expect(requestBrowserPermission(scope)).resolves.toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("keeps the current permission when the prompt throws", async () => {
    const scope = scopeWith("denied");
    FakeNotification.requestPermission.mockRejectedValueOnce(new Error("blocked"));
    await expect(requestBrowserPermission(scope)).resolves.toBe("denied");
  });
});

function sharedEnvironment() {
  const data = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
  };
  const queues = new Map<string, Promise<unknown>>();
  const locks = {
    request: vi.fn((name: string, callback: () => unknown) => {
      const next = (queues.get(name) ?? Promise.resolve()).then(callback);
      queues.set(name, next.catch(() => {}));
      return next;
    }),
  };
  const tab = () => ({ ...scopeWith("granted"), localStorage: storage, navigator: { locks } });
  return { data, storage, locks, tab };
}

async function freshTabNotifier() {
  // Each import has independent module memory, like separate tabs or a reload.
  vi.resetModules();
  return (await import("./browser-notifications")).showBrowserNotificationOnce;
}
const delivered = { id: "shared-notice", title: "PRIVATE_TITLE", message: "PRIVATE_BODY", actionUrl: "/private-action" };

describe("cross-tab browser notification delivery", () => {
  beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.throwOnConstruct = false;
    FakeNotification.permission = "granted";
  });
  afterEach(() => vi.restoreAllMocks());

  it("serializes two independent tabs, persists only IDs/time and deduplicates after reload", async () => {
    const environment = sharedEnvironment();
    const first = await freshTabNotifier(), second = await freshTabNotifier();
    const results = await Promise.all([
      first("cross-tab-actor", delivered, { scope: environment.tab() }),
      second("cross-tab-actor", delivered, { scope: environment.tab() }),
    ]);
    expect(results).toEqual([true, false]);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(environment.locks.request).toHaveBeenCalledTimes(2);
    const [key, raw] = Array.from(environment.data)[0];
    expect(key).toContain("cross-tab-actor");
    expect(JSON.parse(raw)).toEqual([[delivered.id, expect.any(Number)]]);
    expect(raw).not.toContain(delivered.title);
    expect(raw).not.toContain(delivered.message);
    expect(raw).not.toContain(delivered.actionUrl);
    const reloaded = await freshTabNotifier();
    await expect(reloaded("cross-tab-actor", delivered, { scope: environment.tab() })).resolves.toBe(false);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("keeps equal notification IDs separate for different actors", async () => {
    const environment = sharedEnvironment();
    const first = await freshTabNotifier(), second = await freshTabNotifier();
    expect(await first("separate-actor-a", delivered, { scope: environment.tab() })).toBe(true);
    expect(await second("separate-actor-b", delivered, { scope: environment.tab() })).toBe(true);
    expect(FakeNotification.instances).toHaveLength(2);
    expect(environment.data.size).toBe(2);
  });

  it("rechecks the actor inside the acquired lock without consuming the ID", async () => {
    const environment = sharedEnvironment();
    let release!: () => void;
    const key = "lenkanban:browser-notifications:v1:waiting-actor";
    const blocker = environment.locks.request(key, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    let current = true;
    const notifier = await freshTabNotifier();
    const pending = notifier("waiting-actor", delivered, { scope: environment.tab(), isCurrent: () => current });
    current = false;
    release();
    await blocker;
    await expect(pending).resolves.toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
    expect(environment.storage.setItem).not.toHaveBeenCalled();
    current = true;
    await expect(notifier("waiting-actor", delivered, { scope: environment.tab(), isCurrent: () => current })).resolves.toBe(true);
  });

  it("does not consume failed permission or constructor deliveries", async () => {
    const environment = sharedEnvironment();
    const notifier = await freshTabNotifier();
    const scope = environment.tab();
    FakeNotification.permission = "denied";
    expect(await notifier("retry-delivery-actor", delivered, { scope })).toBe(false);
    expect(environment.storage.setItem).not.toHaveBeenCalled();
    FakeNotification.permission = "granted";
    FakeNotification.throwOnConstruct = true;
    expect(await notifier("retry-delivery-actor", delivered, { scope })).toBe(false);
    expect(environment.storage.setItem).not.toHaveBeenCalled();
    FakeNotification.throwOnConstruct = false;
    expect(await notifier("retry-delivery-actor", delivered, { scope })).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("bounds the ledger to512 entries and expires entries older than seven days", async () => {
    const environment = sharedEnvironment();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const key = "lenkanban:browser-notifications:v1:bounded-actor";
    environment.data.set(key, JSON.stringify(Array.from({ length: 512 }, (_, index) => [`old-${index}`, now - 512 + index])));
    const notifier = await freshTabNotifier();
    expect(await notifier("bounded-actor", delivered, { scope: environment.tab() })).toBe(true);
    const entries = JSON.parse(environment.data.get(key)!);
    expect(entries).toHaveLength(512);
    expect(entries.some(([id]: [string, number]) => id === "old-0")).toBe(false);
    expect(entries.at(-1)).toEqual([delivered.id, now]);
    vi.mocked(Date.now).mockReturnValue(now + 7 * 24 * 60 * 60 * 1000 + 1);
    expect(await notifier("bounded-actor", delivered, { scope: environment.tab() })).toBe(true);
    expect(JSON.parse(environment.data.get(key)!)).toEqual([[delivered.id, Date.now()]]);
  });

  it("falls back to per-page memory when locks or storage are unavailable", async () => {
    const first = await freshTabNotifier(), second = await freshTabNotifier();
    const firstScope = scopeWith("granted"), secondScope = scopeWith("granted");
    expect(await first("fallback-page-actor", delivered, { scope: firstScope })).toBe(true);
    expect(await first("fallback-page-actor", delivered, { scope: firstScope })).toBe(false);
    // Legacy fallback intentionally cannot promise coordination across tabs.
    expect(await second("fallback-page-actor", delivered, { scope: secondScope })).toBe(true);
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("uses memory after a lock or storage failure and never rejects delivery", async () => {
    const environment = sharedEnvironment();
    const notifier = await freshTabNotifier();
    environment.locks.request.mockRejectedValueOnce(new Error("Locks unavailable"));
    expect(await notifier("lock-error-actor", delivered, { scope: environment.tab() })).toBe(true);
    expect(await notifier("lock-error-actor", delivered, { scope: environment.tab() })).toBe(false);
    environment.storage.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    expect(await notifier("storage-error-actor", delivered, { scope: environment.tab() })).toBe(true);
    expect(await notifier("storage-error-actor", delivered, { scope: environment.tab() })).toBe(false);
  });

  it("does not navigate for an actor revoked after showing", async () => {
    const environment = sharedEnvironment();
    let current = true;
    const onOpen = vi.fn();
    expect(await showBrowserNotificationOnce("stale-click-actor", delivered, {
      scope: environment.tab(), isCurrent: () => current, onOpen,
    })).toBe(true);
    current = false;
    FakeNotification.instances[0].onclick?.();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
