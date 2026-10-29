export type BrowserNotificationPermission = "unsupported" | "granted" | "denied" | "default";

export interface BrowserNotificationPayload {
  id: string;
  title: string;
  message: string;
  actionUrl?: string | null;
}

interface NotificationCtor {
  new (title: string, options?: NotificationOptions): Notification;
  permission: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
}

function getCtor(scope: unknown): NotificationCtor | null {
  const candidate = (scope as { Notification?: unknown } | null | undefined)?.Notification;
  return typeof candidate === "function" ? (candidate as unknown as NotificationCtor) : null;
}

export function resolveBrowserPermission(scope: unknown = globalThis): BrowserNotificationPermission {
  const ctor = getCtor(scope);
  if (!ctor) return "unsupported";
  const permission = ctor.permission;
  if (permission === "granted" || permission === "denied") return permission;
  return "default";
}

export async function requestBrowserPermission(
  scope: unknown = globalThis,
): Promise<BrowserNotificationPermission> {
  const ctor = getCtor(scope);
  if (!ctor || typeof ctor.requestPermission !== "function") return "unsupported";
  try {
    const result = await ctor.requestPermission();
    if (result === "granted" || result === "denied") return result;
    return "default";
  } catch {
    return resolveBrowserPermission(scope);
  }
}

export interface ShowBrowserNotificationOptions {
  scope?: unknown;
  onOpen?: (actionUrl: string | null) => void;
  isCurrent?: () => boolean;
  onShown?: (notification: Notification) => void;
}

/** Notifications only navigate to app-local paths, never executable or external URLs. */
export function safeNotificationActionUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const base = "https://notification.invalid";
    const parsed = new URL(value, base);
    return parsed.origin === base ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
  } catch {
    return null;
  }
}

/**
 * Shows a system notification for one delivered in-app notification.
 * Returns false when the browser cannot show it, so the in-app path stays authoritative.
 */
export function showBrowserNotification(
  payload: BrowserNotificationPayload,
  options: ShowBrowserNotificationOptions = {},
): boolean {
  const scope = options.scope ?? globalThis;
  const ctor = getCtor(scope);
  if (!ctor || ctor.permission !== "granted") return false;
  if (typeof payload.title !== "string" || payload.title.length === 0) return false;
  try {
    const notification = new ctor(payload.title, {
      body: payload.message || undefined,
      tag: payload.id,
      icon: "/favicon.svg",
    });
    notification.onclick = () => {
      try { notification.close(); } catch { /* Closing a dismissed notification is not an error. */ }
      if (options.isCurrent && !options.isCurrent()) return;
      try { (scope as { focus?: () => void }).focus?.(); } catch { /* Focus is best effort. */ }
      options.onOpen?.(safeNotificationActionUrl(payload.actionUrl));
    };
    options.onShown?.(notification);
    return true;
  } catch {
    return false;
  }
}

type SeenNotification = [id: string, shownAt: number];
type NotificationStorage = Pick<Storage, "getItem" | "setItem">;
type NotificationLocks = {
  request: (name: string, callback: () => boolean) => Promise<boolean>;
};
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_LIMIT = 512;
const MEMORY_ACTOR_LIMIT = 16;
const memorySeen = new Map<string, SeenNotification[]>();

function recentNotifications(value: unknown, now: number): SeenNotification[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, number>();
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(entry[0])
      && typeof entry[1] === "number" && Number.isFinite(entry[1])
      && entry[1] > now - SEEN_TTL_MS && entry[1] <= now) {
      entries.set(entry[0], Math.max(entries.get(entry[0]) ?? 0, entry[1]));
    }
  }
  return Array.from(entries).sort((a, b) => a[1] - b[1]).slice(-SEEN_LIMIT);
}

/**
 * Coordinates tabs using Web Locks and an actor-scoped ledger containing only
 * notification IDs and timestamps. No task text or navigation URLs are stored.
 * Without both capabilities, deduplication is limited to this page's memory.
 */
export async function showBrowserNotificationOnce(
  actorId: string,
  payload: BrowserNotificationPayload,
  options: ShowBrowserNotificationOptions = {},
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(actorId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.id)) return false;
  const isCurrent = () => {
    try { return !options.isCurrent || options.isCurrent(); } catch { return false; }
  };
  if (!isCurrent()) return false;
  const scope = options.scope ?? globalThis;
  const key = `lenkanban:browser-notifications:v1:${actorId}`;
  let storage: NotificationStorage | null = null;
  let locks: NotificationLocks | null = null;
  try {
    const environment = scope as {
      localStorage?: NotificationStorage;
      navigator?: { locks?: NotificationLocks };
    };
    const candidateStorage = environment.localStorage;
    const candidateLocks = environment.navigator?.locks;
    if (candidateStorage && typeof candidateStorage.getItem === "function"
      && typeof candidateStorage.setItem === "function"
      && candidateLocks && typeof candidateLocks.request === "function") {
      storage = candidateStorage;
      locks = candidateLocks;
    }
  } catch { /* Restricted storage uses the bounded in-page fallback. */ }

  const deliver = (sharedStorage: NotificationStorage | null): boolean => {
    // The actor may have changed while another tab held the lock.
    if (!isCurrent()) return false;
    const now = Date.now();
    let stored: SeenNotification[] = [];
    if (sharedStorage) {
      try {
        const raw = sharedStorage.getItem(key);
        if (raw && raw.length <= 128_000) stored = recentNotifications(JSON.parse(raw), now);
      } catch { sharedStorage = null; }
    }
    const seen = recentNotifications([...stored, ...(memorySeen.get(actorId) ?? [])], now);
    if (seen.some(([id]) => id === payload.id) || !isCurrent()) return false;
    if (!showBrowserNotification(payload, options)) return false;
    const next = [...seen, [payload.id, now] as SeenNotification].slice(-SEEN_LIMIT);
    memorySeen.delete(actorId);
    memorySeen.set(actorId, next);
    if (memorySeen.size > MEMORY_ACTOR_LIMIT) memorySeen.delete(memorySeen.keys().next().value!);
    try { sharedStorage?.setItem(key, JSON.stringify(next)); } catch { /* Memory still records this delivery. */ }
    return true;
  };

  if (!locks || !storage) return deliver(null);
  let acquired = false;
  try {
    return await locks.request(key, () => {
      acquired = true;
      return deliver(storage);
    });
  } catch {
    // Do not show twice if a lock implementation rejects after invoking us.
    return acquired ? false : deliver(null);
  }
}
