"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { getSocketInstance } from "@/lib/socket-client";
import { createRevocationHandlers, subscribeProjectAccessRevoked } from "@/lib/socket-revocation";

type UseProjectBoardOptions = {
  projectId: string | null | undefined;
};

// A board and its intercepted task panel share one socket room.
const projectSubscribers = new WeakMap<object, Map<string, number>>();

type TaskEventPayload = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  position: number;
  projectId: string;
  columnId?: string | null;
  version?: number;
  deadline?: Date | null;
  assignees?: Array<{
    id: string;
    user: {
      id: string;
      name: string | null;
      email: string;
      avatarUrl?: string | null;
    };
  }>;
  tags?: Array<{
    id: string;
    tag: {
      id: string;
      name: string;
      color: string;
    };
  }>;
  _count?: {
    messages?: number;
  };
};

export type TaskMovedEventPayload = {
  operationId: string;
  boardRevision: number;
  task: {
    id: string;
    columnId: string;
    version: number;
    status: string;
  };
};

export type BoardServerToClientEvents = {
  "task:created": (task: TaskEventPayload) => void;
  "task:updated": (task: TaskEventPayload) => void;
  "task:moved": (move: TaskMovedEventPayload) => void;
  "task:deleted": (payload: { projectId: string; taskId: string }) => void;
};

export type BoardClientToServerEvents = {
  "project:join": (payload: { projectId: string }, ack?: (res: unknown) => void) => void;
  "project:leave": (payload: { projectId: string }) => void;
};

export function shouldApplyTaskVersionSnapshot(input: {
  currentTaskVersion: number | undefined;
  incomingTaskVersion: number | undefined;
}): boolean {
  if (input.currentTaskVersion === undefined) {
    return true;
  }

  return (
    input.incomingTaskVersion !== undefined &&
    input.incomingTaskVersion >= input.currentTaskVersion
  );
}

export function shouldApplyTaskMovedSnapshot(input: {
  currentTaskVersion: number;
  currentBoardRevision: number;
  incomingTaskVersion: number;
  incomingBoardRevision: number;
}): boolean {
  return (
    input.incomingTaskVersion >= input.currentTaskVersion &&
    input.incomingBoardRevision >= input.currentBoardRevision
  );
}

export function requestCanonicalTaskMovedRefresh(input: {
  currentTaskVersion: number;
  currentBoardRevision: number;
  move: TaskMovedEventPayload;
  onRefresh: (boardRevision: number) => void;
}): boolean {
  if (
    !shouldApplyTaskMovedSnapshot({
      currentTaskVersion: input.currentTaskVersion,
      currentBoardRevision: input.currentBoardRevision,
      incomingTaskVersion: input.move.task.version,
      incomingBoardRevision: input.move.boardRevision,
    })
  ) {
    return false;
  }

  input.onRefresh(input.move.boardRevision);
  return true;
}

export function useProjectBoard({ projectId }: UseProjectBoardOptions) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const navigateRef = useRef(router.replace);
  navigateRef.current = router.replace;
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    setIsConnected(false);
    setIsJoined(false);
    setLastError(null);
    if (!projectId) return;

    const socket = getSocketInstance();
    const subscribers = projectSubscribers.get(socket) ?? new Map<string, number>();
    projectSubscribers.set(socket, subscribers);
    subscribers.set(projectId, (subscribers.get(projectId) ?? 0) + 1);
    let cancelled = false;
    let attempt = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const invalidateJoin = () => {
      attempt += 1;
      clearTimeout(timeout);
      timeout = undefined;
    };

    const joinProject = () => {
      if (cancelled || !socket.connected) return;
      invalidateJoin();
      const currentAttempt = attempt;
      setIsConnected(true);
      setIsJoined(false);
      setLastError(null);

      timeout = setTimeout(() => {
        if (cancelled || currentAttempt !== attempt) return;
        invalidateJoin();
        setLastError("ProjectJoinTimeout");
      }, 5000);

      // The server acknowledges only after access validation and room join.
      socket.emit("project:join", { projectId }, (ack: unknown) => {
        if (cancelled || currentAttempt !== attempt || !socket.connected) return;
        invalidateJoin();
        const response = ack as { ok?: unknown; error?: unknown } | null | undefined;
        if (response?.ok === true) {
          setIsJoined(true);
        } else {
          setLastError(
            typeof response?.error === "string" && response.error
              ? response.error
              : "ProjectJoinFailed",
          );
        }
      });
    };

    const onDisconnect = () => {
      if (cancelled) return;
      invalidateJoin();
      setIsConnected(false);
      setIsJoined(false);
    };

    const onConnectError = (error: Error) => {
      if (cancelled) return;
      onDisconnect();
      setLastError(error.message || "SocketConnectionFailed");
    };

    const revocation = createRevocationHandlers({
      queryClient,
      navigate: path => navigateRef.current(path),
    });
    const unsubscribeRevocation = subscribeProjectAccessRevoked(socket, payload => {
      if (!payload || typeof payload !== "object") return;
      if ((payload as { projectId?: unknown }).projectId !== projectId) return;
      revocation.projectAccessRevoked(payload);
    });

    socket.on("connect", joinProject);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    if (socket.connected) {
      void joinProject();
    }

    return () => {
      cancelled = true;
      invalidateJoin();
      const remaining = (subscribers.get(projectId) ?? 1) - 1;
      if (remaining > 0) subscribers.set(projectId, remaining);
      else {
        subscribers.delete(projectId);
        socket.emit("project:leave", { projectId });
      }
      unsubscribeRevocation();
      socket.off("connect", joinProject);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
    };
  }, [projectId, queryClient]);

  return {
    socket: projectId ? getSocketInstance() : null,
    isConnected,
    isJoined,
    lastError,
  };
}
