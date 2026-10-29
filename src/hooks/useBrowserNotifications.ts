"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useNotificationSocket } from "@/hooks/useNotificationSocket";
import {
  resolveBrowserPermission,
  requestBrowserPermission,
  showBrowserNotificationOnce,
  type BrowserNotificationPermission,
} from "@/lib/browser-notifications";

/**
 * Bridges committed in-app notifications to the browser Notification API.
 * The switch is the browser permission itself; no per-user preference row is introduced.
 */
export function useBrowserNotifications() {
  const router = useRouter();
  const { socket, connected } = useNotificationSocket();
  const [permission, setPermission] = React.useState<BrowserNotificationPermission>("unsupported");
  const [ready, setReady] = React.useState(false);
  const [permissionRequestState, setPermissionRequestState] = React.useState<"idle" | "pending" | BrowserNotificationPermission>("idle");
  const permissionRequestRef = React.useRef<Promise<BrowserNotificationPermission> | null>(null);

  const { data: session, status } = useSession();
  const actorId = status === "authenticated" && typeof session?.user?.id === "string" && session.user.id.length > 0
    ? session.user.id
    : null;
  const actorRef = React.useRef<string | null>(null);
  actorRef.current = actorId;
  const permissionRef = React.useRef(permission);
  permissionRef.current = permission;
  const ownershipRef = React.useRef<{ active: boolean; shown: Set<Notification> } | null>(null);
  const seenRef = React.useRef<{ actorId: string | null; ids: Set<string> }>({ actorId, ids: new Set() });
  if (seenRef.current.actorId !== actorId) seenRef.current = { actorId, ids: new Set() };

  React.useEffect(() => {
    const sync = () => setPermission(resolveBrowserPermission());
    sync();
    setReady(true);
    // The permission can change in site settings while the tab stays open.
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  const requestPermission = React.useCallback(() => {
    if (permissionRequestRef.current) return permissionRequestRef.current;
    setPermissionRequestState("pending");
    // Start in the click's user-activation scope. An unresolved native prompt
    // stays pending; a timer must never claim that the user denied permission.
    const request = requestBrowserPermission().then(next => {
      setPermission(next);
      setPermissionRequestState(next);
      return next;
    }).finally(() => { permissionRequestRef.current = null; });
    permissionRequestRef.current = request;
    return request;
  }, []);

  // A socket reconnect must not dismiss a notification which is already visible.
  // Its lifetime belongs to the actor and permission, not to the transport.
  React.useEffect(() => {
    const ownership = { active: true, shown: new Set<Notification>() };
    ownershipRef.current = ownership;
    return () => {
      ownership.active = false;
      for (const notification of ownership.shown) {
        try { notification.close(); } catch { /* Already dismissed by the browser. */ }
      }
      ownership.shown.clear();
    };
  }, [actorId, permission]);

  React.useEffect(() => {
    if (!socket || !connected || !actorId || permission !== "granted") return;
    const ownership = ownershipRef.current;
    if (!ownership) return;
    let active = true;
    const pending = new Set<string>();
    const isCurrentActor = () => ownership.active && actorRef.current === actorId
      && permissionRef.current === "granted";

    const handleNotification = async (incoming: unknown) => {
      if (!active || !isCurrentActor()) return;
      if (typeof incoming !== "object" || incoming === null) return;
      const record = incoming as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const title = typeof record.title === "string" ? record.title : "";
      if (!id || !title || seenRef.current.ids.has(id) || pending.has(id)) return;
      pending.add(id);
      let displayed = false;
      // A notification left on screen after a session change must not navigate for the next user.
      try {
        const delivered = await showBrowserNotificationOnce(actorId,
          {
            id,
            title,
            message: typeof record.message === "string" ? record.message : "",
            actionUrl: typeof record.actionUrl === "string" ? record.actionUrl : null,
          },
          {
            // Cancel delivery while waiting for another tab's lock, but keep a
            // displayed notification usable across a transient disconnect.
            isCurrent: () => isCurrentActor() && (displayed || active),
            onShown: notification => {
              if (!active || !isCurrentActor()) {
                try { notification.close(); } catch { /* Already dismissed. */ }
                return;
              }
              displayed = true;
              ownership.shown.add(notification);
              notification.onclose = () => ownership.shown.delete(notification);
            },
            onOpen: url => {
              if (!isCurrentActor()) return;
              if (url) router.push(url);
            },
          },
        );
        if (delivered && isCurrentActor()) {
          seenRef.current.ids.add(id);
          // Bound memory while still suppressing recent socket replays.
          if (seenRef.current.ids.size > 512) {
            const oldest = seenRef.current.ids.values().next().value;
            if (oldest) seenRef.current.ids.delete(oldest);
          }
        }
      } catch {
        // Native delivery remains best effort; the in-app bell is authoritative.
      } finally {
        pending.delete(id);
      }
    };

    socket.on("notification:new", handleNotification);
    return () => {
      active = false;
      socket.off("notification:new", handleNotification);
    };
  }, [socket, connected, actorId, permission, router]);

  return { permission, ready, requestPermission, permissionRequestState };
}
