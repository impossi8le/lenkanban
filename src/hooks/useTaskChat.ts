"use client";

import { useEffect, useState } from "react";
import { getSocketInstance } from "@/lib/socket-client";

import type { ChatMessageDTO, ChatTypingDTO } from "@/lib/chat-types";

type UseTaskChatOptions = {
  taskId: string | null | undefined;
};

type ChatServerToClientEvents = {
  "message:new": (msg: ChatMessageDTO) => void;
  "message:updated": (msg: ChatMessageDTO) => void;
  "message:deleted": (payload: { taskId: string; messageId: string }) => void;
  typing: (payload: ChatTypingDTO) => void;
};

type ChatClientToServerEvents = {
  "task:join": (payload: { taskId: string }, ack?: (res: unknown) => void) => void;
  "task:leave": (payload: { taskId: string }) => void;
  typing: (payload: { taskId: string; isTyping: boolean }) => void;
  "message:send": (
    payload: { taskId: string; clientId: string; contentText?: string; attachments?: unknown[]; mentionUserIds?: string[] },
    ack?: (res: unknown) => void
  ) => void;
  "message:edit": (
    payload: { taskId: string; messageId: string; contentText?: string; attachments?: unknown[] },
    ack?: (res: unknown) => void
  ) => void;
  "message:delete": (
    payload: { taskId: string; messageId: string },
    ack?: (res: unknown) => void
  ) => void;
  "message:react": (
    payload: { taskId: string; messageId: string; emoji: string; action: 'add' | 'remove' },
    ack?: (res: unknown) => void
  ) => void;
};

export function useTaskChat({ taskId }: UseTaskChatOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    setIsConnected(false);
    setIsJoined(false);
    setLastError(null);
    if (!taskId) return;

    const socket = getSocketInstance();
    let cancelled = false;
    let attempt = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const invalidateJoin = () => {
      attempt += 1;
      clearTimeout(timeout);
      timeout = undefined;
    };

    const onConnect = () => {
      if (cancelled || !socket.connected) return;
      invalidateJoin();
      const currentAttempt = attempt;
      setIsConnected(true);
      setIsJoined(false);
      setLastError(null);

      timeout = setTimeout(() => {
        if (cancelled || currentAttempt !== attempt) return;
        invalidateJoin();
        setLastError("TaskJoinTimeout");
      }, 5000);

      // The server acknowledges only after access validation and room join.
      socket.emit("task:join", { taskId }, (ack: unknown) => {
        if (cancelled || currentAttempt !== attempt || !socket.connected) return;
        invalidateJoin();
        const response = ack as { ok?: unknown; error?: unknown } | null | undefined;
        if (response?.ok === true) {
          setIsJoined(true);
        } else {
          setLastError(
            typeof response?.error === "string" && response.error
              ? response.error
              : "FailedToJoin",
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

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    if (socket.connected) void onConnect();

    return () => {
      cancelled = true;
      invalidateJoin();
      socket.emit("task:leave", { taskId });
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
    };
  }, [taskId]);

  return {
    socket: taskId ? getSocketInstance() : null,
    isConnected,
    isJoined,
    lastError,
  };
}
