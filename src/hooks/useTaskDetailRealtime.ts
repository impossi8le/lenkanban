"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectBoard } from "./useProjectBoard";

type BackgroundRead = () => void | Promise<void>;
type ReadScheduler = {
  projectId: string;
  taskId: string;
  read: BackgroundRead;
  running: boolean;
  queued: boolean;
  kick?: () => void;
};

/** Re-read canonical task data without replacing intercepted route/cache state. */
export function useTaskDetailRealtime(projectId: string, taskId: string, readInBackground: BackgroundRead) {
  const client = useQueryClient();
  const { socket, isJoined } = useProjectBoard({ projectId });
  const schedulerRef = useRef<ReadScheduler | null>(null);
  if (schedulerRef.current?.projectId !== projectId || schedulerRef.current.taskId !== taskId) {
    schedulerRef.current = { projectId, taskId, read: readInBackground, running: false, queued: false };
  }
  const scheduler = schedulerRef.current;
  scheduler.read = readInBackground;

  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const refresh = () => {
      if (!active || schedulerRef.current !== scheduler) return;
      if (scheduler.running) { scheduler.queued = true; return; }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!active || schedulerRef.current !== scheduler || scheduler.kick !== refresh) return;
        if (scheduler.running) { scheduler.queued = true; return; }
        scheduler.running = true;
        scheduler.queued = false;
        // History can refresh while the independent detail request is pending.
        void client.invalidateQueries({ queryKey: ["activities", taskId] });
        void client.invalidateQueries({ predicate: query => query.queryKey[0] === "task-related" && query.queryKey[2] === taskId });
        let result: void | Promise<void>;
        try { result = scheduler.read(); } catch { result = undefined; }
        // The canonical reader owns its error state. Always release this queue.
        void Promise.resolve(result).catch(() => undefined).finally(() => {
          scheduler.running = false;
          if (scheduler.queued) scheduler.kick?.();
        });
      }, 100);
    };
    scheduler.kick = refresh;
    const onUpdated = (task: { id?: string; projectId?: string }) => {
      if (task?.id === taskId && task.projectId === projectId) refresh();
    };
    const onMoved = (move: { task?: { id?: string } }) => {
      if (move?.task?.id === taskId) refresh();
    };
    const onDeleted = (task: { taskId?: string; projectId?: string }) => {
      if (task?.taskId === taskId && task.projectId === projectId) refresh();
    };
    socket.on("task:updated", onUpdated);
    socket.on("task:moved", onMoved);
    socket.on("task:deleted", onDeleted);
    // Covers changes between the initial server render and room join, plus reconnects.
    if (isJoined || scheduler.queued) refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      if (scheduler.kick === refresh) scheduler.kick = undefined;
      socket.off("task:updated", onUpdated);
      socket.off("task:moved", onMoved);
      socket.off("task:deleted", onDeleted);
    };
  }, [socket, isJoined, projectId, taskId, client, scheduler]);
}
