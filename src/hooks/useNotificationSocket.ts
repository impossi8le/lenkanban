"use client";

import * as React from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import { createSocketConnection } from "@/lib/socket-client";
import { createRevocationHandlers, subscribeAuthRevoked } from "@/lib/socket-revocation";
import { REQUEST_QUEUE_INVALIDATED, isRequestQueueInvalidation, type RequestQueueServerToClientEvents } from "@/socket/request-queue-contract";
import { NOTIFICATION_CHANGED, isNotificationChanged } from "@/socket/notification-change-contract";

type NotificationConnection = {
  actorId: string | null;
  socket: Socket | null;
  connected: boolean;
};

type Subscriber = (connection: NotificationConnection) => void;
type ActorConnection = {
  actorId: string;
  socket: Socket;
  subscribers: Set<Subscriber>;
  joined: boolean;
  joining: boolean;
  attempt: number;
  joinAttempts: number;
  joinTimeout: ReturnType<typeof setTimeout> | undefined;
  disposed: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
};

let activeConnection: ActorConnection | null = null;
const JOIN_TIMEOUT_MS = 5000;
const MAX_JOIN_ATTEMPTS = 2;
// Bell and browser-notification consumers share a personal connection. Coalesce
// their identical cache refreshes without suppressing the next transport turn.
const queueInvalidationTurns = new WeakMap<object, WeakSet<object>>();
const notificationInvalidationTurns = new WeakMap<object, WeakSet<object>>();

function clearJoinTimeout(connection: ActorConnection) {
  clearTimeout(connection.joinTimeout);
  connection.joinTimeout = undefined;
}

function publish(connection: ActorConnection) {
  const snapshot: NotificationConnection = {
    actorId: connection.actorId,
    socket: connection.disposed ? null : connection.socket,
    connected: !connection.disposed && connection.joined,
  };
  for (const subscriber of connection.subscribers) subscriber(snapshot);
}

function dispose(connection: ActorConnection) {
  if (connection.disposed) return;
  connection.disposed = true;
  connection.attempt += 1;
  clearJoinTimeout(connection);
  connection.joined = false;
  connection.joining = false;
  connection.socket.off("connect", connection.onConnect);
  connection.socket.off("disconnect", connection.onDisconnect);
  connection.socket.off("connect_error", connection.onDisconnect);
  if (connection.socket.connected) connection.socket.emit("notification:leave");
  connection.socket.disconnect();
  if (activeConnection === connection) activeConnection = null;
  publish(connection);
  connection.subscribers.clear();
}

function acquire(actorId: string, subscriber: Subscriber): () => void {
  if (activeConnection && activeConnection.actorId !== actorId) dispose(activeConnection);
  if (!activeConnection) {
    const socket = createSocketConnection();
    const connection: ActorConnection = {
      actorId, socket, subscribers: new Set(), joined: false, joining: false,
      attempt: 0, joinAttempts: 0, joinTimeout: undefined, disposed: false,
      onConnect: () => {}, onDisconnect: () => {},
    };
    connection.onDisconnect = () => {
      if (connection.disposed) return;
      connection.attempt += 1;
      clearJoinTimeout(connection);
      connection.joinAttempts = 0;
      connection.joined = false;
      connection.joining = false;
      publish(connection);
    };
    connection.onConnect = () => {
      if (connection.disposed || !socket.connected || connection.joined || connection.joining
        || connection.joinAttempts >= MAX_JOIN_ATTEMPTS) return;
      const attempt = ++connection.attempt;
      connection.joinAttempts += 1;
      connection.joining = true;
      publish(connection);
      connection.joinTimeout = setTimeout(() => {
        if (connection.disposed || connection.attempt !== attempt || !connection.joining || !socket.connected) return;
        connection.joinTimeout = undefined;
        connection.attempt += 1;
        connection.joining = false;
        publish(connection);
        // One re-admission only, through the same current server ACL. Once both
        // deadlines expire the existing polling fallback remains disconnected.
        connection.onConnect();
      }, JOIN_TIMEOUT_MS);
      socket.emit("notification:join", (response: unknown) => {
        if (connection.disposed || !connection.joining || connection.attempt !== attempt || !socket.connected) return;
        clearJoinTimeout(connection);
        connection.joining = false;
        connection.joined = typeof response === "object" && response !== null &&
          "ok" in response && response.ok === true;
        // A denial (or malformed reply) is not permission to retry admission.
        if (!connection.joined) connection.joinAttempts = MAX_JOIN_ATTEMPTS;
        publish(connection);
      });
    };
    activeConnection = connection;
    socket.on("connect", connection.onConnect);
    socket.on("disconnect", connection.onDisconnect);
    socket.on("connect_error", connection.onDisconnect);
  }
  const connection = activeConnection;
  connection.subscribers.add(subscriber);
  publish(connection);
  // A connected transport may have completed its handshake before subscription.
  if (connection.socket.connected) connection.onConnect();

  return () => {
    connection.subscribers.delete(subscriber);
    if (connection.subscribers.size === 0) dispose(connection);
  };
}

export function useNotificationSocket() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const actorId = status !== "loading" && status !== "unauthenticated" &&
    typeof session?.user?.id === "string" && session.user.id.length > 0
    ? session.user.id : null;
  const [connection, setConnection] = React.useState<NotificationConnection>({
    actorId: null, socket: null, connected: false,
  });

  React.useEffect(() => {
    if (!actorId) {
      if (activeConnection) dispose(activeConnection);
      return;
    }
    return acquire(actorId, setConnection);
  }, [actorId]);

  const socket = connection.actorId === actorId && actorId !== null ? connection.socket : null;
  const currentActor = React.useRef(actorId);
  currentActor.current = actorId;

  React.useEffect(() => {
    if (!socket || !actorId || !connection.connected) return;
    const invalidate: RequestQueueServerToClientEvents[typeof REQUEST_QUEUE_INVALIDATED] = (payload: unknown) => {
      if (currentActor.current !== actorId || !isRequestQueueInvalidation(payload)
        || activeConnection?.socket !== socket || activeConnection.disposed || !activeConnection.joined) return;
      const pending = queueInvalidationTurns.get(queryClient) ?? new WeakSet<object>();
      if (pending.has(socket)) return;
      queueInvalidationTurns.set(queryClient, pending);
      pending.add(socket);
      queueMicrotask(() => pending.delete(socket));
      // Refetch actor projections; never copy another socket payload's unseen value.
      for (const queryKey of [
        ["request-queue-unseen", actorId], ["tasks"], ["my-tasks", actorId],
        ["task"], ["task-lifecycle"], ["notifications", actorId],
      ]) void queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
    };
    socket.on(REQUEST_QUEUE_INVALIDATED, invalidate);
    return () => { socket.off(REQUEST_QUEUE_INVALIDATED, invalidate); };
  }, [socket, actorId, connection.connected, queryClient]);

  React.useEffect(() => {
    if (!socket || !actorId || !connection.connected) return;
    const changed = (payload: unknown) => {
      if (currentActor.current !== actorId || !isNotificationChanged(payload)
        || activeConnection?.socket !== socket || activeConnection.disposed || !activeConnection.joined) return;
      const pending = notificationInvalidationTurns.get(queryClient) ?? new WeakSet<object>();
      if (pending.has(socket)) return;
      notificationInvalidationTurns.set(queryClient, pending); pending.add(socket);
      queueMicrotask(() => pending.delete(socket));
      void queryClient.invalidateQueries({ queryKey: ["notifications", actorId] });
    };
    socket.on(NOTIFICATION_CHANGED, changed);
    return () => { socket.off(NOTIFICATION_CHANGED, changed); };
  }, [socket, actorId, connection.connected, queryClient]);

  // auth.revoked arrives on the personal room owned by this connection. The
  // shared handler clears cached data before leaving protected pages.
  React.useEffect(() => {
    if (!socket) return;
    const handlers = createRevocationHandlers({
      queryClient,
      navigate: path => router.replace(path),
    });
    return subscribeAuthRevoked(socket, payload => {
      handlers.authRevoked(payload);
      if (payload && typeof payload === "object" && !Array.isArray(payload) && "userId" in payload
        && typeof payload.userId === "string" && payload.userId.length > 0
        && activeConnection?.socket === socket) dispose(activeConnection);
    });
  }, [socket, queryClient, router]);

  // Hide the previous actor's connection before effects run on a session change.
  return socket
    ? { socket, connected: connection.connected }
    : { socket: null, connected: false };
}
