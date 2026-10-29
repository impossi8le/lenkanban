"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readRequestDetails, requestDetailKey } from "@/lib/request-detail-query";
import type { TaskType } from "@/components/kanban/Card";
import { TaskCommandPanel } from "@/components/task/TaskCommandPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export interface MyTaskSelection {
  actorId: string;
  projectId: string;
  taskId: string;
  openId: number;
}
export function isMyTaskReadDenied(error: unknown): boolean {
  try {
    return !!error && typeof error === "object" && "status" in error
      && (error.status === 401 || error.status === 403 || error.status === 404);
  } catch { return false; }
}

/** A list row is never used as an editable Task. Each opening authorizes anew. */
export function MyTaskCommandLoader({ selection, onClose, onDeleted, onAuthoritativeRead }: {
  selection: MyTaskSelection;
  onClose: () => void;
  onDeleted: () => void;
  onAuthoritativeRead: (task: TaskType) => void;
}) {
  const { actorId, projectId, taskId, openId } = selection;
  const client = useQueryClient();
  const active = useRef(true);
  const handingOff = useRef(false);
  const [authorizedTask, setAuthorizedTask] = useState<TaskType | null>(null);
  const query = useQuery({
    queryKey: requestDetailKey(selection),
    enabled: Boolean(actorId && projectId && taskId) && authorizedTask === null,
    retry: false,
    // A click-prefetch may fail before this lazy component mounts. Show that
    // result immediately; only the explicit read-retry button should repeat it.
    retryOnMount: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => readRequestDetails(selection, signal),
  });
  useEffect(() => {
    if (query.data && authorizedTask === null) setAuthorizedTask(query.data);
  }, [query.data, authorizedTask]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const queryKey = ["my-task-details", actorId, projectId, taskId, openId];
      void client.cancelQueries({ queryKey, exact: true });
      client.removeQueries({ queryKey, exact: true });
    };
  }, [actorId, projectId, taskId, openId, client]);

  const close = () => { if (active.current) onClose(); };
  const task = authorizedTask ?? query.data;
  handingOff.current = Boolean(task);
  if (task) {
    return <TaskCommandPanel task={task} projectId={projectId} taskId={taskId} initialActorId={actorId}
      onClose={close}
      onDeleted={() => { if (active.current) onDeleted(); }}
      onAuthoritativeRead={task => {
        if (active.current && task.id === taskId && task.projectId === projectId) onAuthoritativeRead(task);
      }}
    />;
  }
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="max-w-md" onCloseAutoFocus={event => {
      if (handingOff.current) event.preventDefault();
    }}>
      <DialogTitle>Загрузка карточки задачи</DialogTitle>
      <DialogDescription>Редактор откроется после проверки актуальных данных и доступа.</DialogDescription>
      {query.isError ? <p role="alert">{isMyTaskReadDenied(query.error)
        ? "Карточка недоступна или права изменились."
        : "Не удалось загрузить актуальную карточку задачи."}</p>
        : <p role="status">Загрузка актуальной карточки…</p>}
      {query.isError && <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Повторить чтение карточки</Button>}
      <Button variant="outline" onClick={close}>Закрыть загрузку карточки</Button>
    </DialogContent>
  </Dialog>;
}
