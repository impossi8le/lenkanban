"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api";
import { getSocketInstance } from "@/lib/socket-client";

type UnreadCounts = {
  byProject: Record<string, number>;
  byTask: Record<string, number>;
  total: number;
};

/** Polling only covers outages; connected clients get updates from Socket.IO. */
export const UNREAD_COUNTS_FALLBACK_POLL_MS = 30000;

// Desktop and mobile navigation share the query. Coalesce their listeners in
// the same event turn so one message never cancels/restarts the same read twice.
const pendingInvalidations = new WeakMap<QueryClient, Set<string>>();
function refreshUnread(queryClient: QueryClient, actorId: string) {
  let actors = pendingInvalidations.get(queryClient);
  if (!actors) { actors = new Set(); pendingInvalidations.set(queryClient, actors); }
  if (actors.has(actorId)) return;
  actors.add(actorId);
  queueMicrotask(() => {
    actors.delete(actorId);
    void queryClient.invalidateQueries({ queryKey: ["unread-counts", actorId] });
  });
}

export function useUnreadCounts() {
  const { data: session, status } = useSession();
  const actorId = status === "authenticated" ? session?.user?.id : undefined;
  const queryClient = useQueryClient();
  const [socketConnected, setSocketConnected] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["unread-counts", actorId],
    enabled: Boolean(actorId),
    queryFn: ({ signal }) => apiFetch<UnreadCounts>("/api/messages/unread", { signal }),
    refetchInterval: socketConnected ? false : UNREAD_COUNTS_FALLBACK_POLL_MS,
  });

  // Listen to Socket.IO events for real-time updates
  useEffect(() => {
    if (!actorId) return;
    const socket = getSocketInstance();
    // While the transport is down polling is the only source of truth, so the
    // first reconnect refreshes whatever was missed instead of waiting for an event.
    let missedWhileDisconnected = !socket.connected;

    const invalidateUnreadCounts = () => {
      refreshUnread(queryClient, actorId);
    };

    const onMessageNew = invalidateUnreadCounts;
    const onMessageRead = invalidateUnreadCounts;

    const onConnect = () => {
      setSocketConnected(true);
      if (missedWhileDisconnected) {
        missedWhileDisconnected = false;
        invalidateUnreadCounts();
      }
    };

    const onDisconnect = () => {
      missedWhileDisconnected = true;
      setSocketConnected(false);
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:read", onMessageRead);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onDisconnect);

    // The transport may have connected before this effect subscribed.
    setSocketConnected(socket.connected);

    return () => {
      socket.off("message:new", onMessageNew);
      socket.off("message:read", onMessageRead);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onDisconnect);
    };
  }, [queryClient, actorId]);

  return {
    byProject: (actorId ? data : undefined)?.byProject ?? {},
    byTask: (actorId ? data : undefined)?.byTask ?? {},
    total: (actorId ? data : undefined)?.total ?? 0,
    isLoading,
  };
}
