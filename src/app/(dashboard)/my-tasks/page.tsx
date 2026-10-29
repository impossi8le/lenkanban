"use client";
import { isUrgentRequest } from "@/lib/request-presentation";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { RequestBoardPresentation } from "@/components/kanban/RequestBoardPresentation";
import type { TaskType } from "@/components/kanban/Card";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { isPast, isToday } from "date-fns";
import { MyTaskCommandLoader, isMyTaskReadDenied, type MyTaskSelection } from "./MyTaskCommandLoader";
import type { Attachment } from "@/types/attachment";
import { compareRequestsForDisplay } from "@/lib/request-display-order";
import { TASK_LIST_MAX_LIMIT } from "@/lib/task-list-limits";

interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  deadline: string | null;
  createdAt: string;
  attachments: Attachment[];
  project: {
    id: string;
    name: string;
  };
  column?: {
    id: string;
    name: string;
    color: string;
  } | null;
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
  checklist?: {
    total: number;
    completed: number;
  } | null;
  _count?: {
    messages?: number;
  };
  unreadCount?: number;
  createdBy?: TaskType["createdBy"];
  request?: TaskType["request"];
  queueArrival?: TaskType["queueArrival"];
  createdById?: string;
  version?: number;
}

export default function MyTasksPage() {
  const { data: session, status } = useSession();
  const params = useSearchParams();
  const scope = params?.get("scope") === "mine" ? "mine" : params?.get("scope") === "reply" ? "reply" : "assigned";
  if (status === "loading") return <p role="status" className="p-6">Проверка учётной записи…</p>;
  if (status !== "authenticated" || !session?.user?.id) {
    return <p role="alert" className="p-6">Войдите заново, чтобы открыть свои задачи.</p>;
  }
  return <MyTasksContent key={`${session.user.id}:${scope}`} actorId={session.user.id} scope={scope} />;
}

function MyTasksContent({ actorId, scope }: { actorId: string; scope: "mine" | "reply" | "assigned" }) {
  const queryClient = useQueryClient();
  const [unseenOnly, setUnseenOnly] = useState(false);

  const priorityFilter = "all" as string;
  const deadlineFilter = "all" as string;
  const columnFilter = "all" as string;
  const [accessDenied, setAccessDenied] = useState(false);
  const [selectedTask, setSelectedTask] = useState<MyTaskSelection | null>(null);
  const selectedRef = useRef(selectedTask);
  const selectionSequence = useRef(0);
  const active = useRef(true), authorizedReads = useRef(0), retryingAccess = useRef(false);
  const titleButtons = useRef(new Map<string, HTMLButtonElement>());
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusOrigin = useRef<{
    opener: HTMLButtonElement | null;
    taskId: string;
    nextTaskId: string | null;
  } | null>(null);
  const pendingFocusReturn = useRef<{
    origin: NonNullable<typeof focusOrigin.current>;
    deleted: boolean;
  } | null>(null);
  selectedRef.current = selectedTask;

  // The temporary loader hands focus to the task panel. Keep the list's own
  // return target until the whole opening closes, including loading failures.
  useEffect(() => {
    if (selectedTask !== null || !pendingFocusReturn.current) return;
    const pending = pendingFocusReturn.current;
    pendingFocusReturn.current = null;
    const frame = requestAnimationFrame(() => {
      if (!active.current || selectedRef.current !== null) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-state="closed"]):not([aria-hidden="true"])')) return;
      const focused = document.activeElement;
      const opener = pending.origin.opener;
      // Respect a deliberate click/tab to another still-connected control.
      if (focused && focused !== document.body && focused !== opener && focused.isConnected) return;
      const original = !pending.deleted && titleButtons.current.get(pending.origin.taskId);
      const next = pending.origin.nextTaskId && titleButtons.current.get(pending.origin.nextTaskId);
      const remaining = [...titleButtons.current.entries()]
        .find(([id, button]) => id !== pending.origin.taskId && button.isConnected)?.[1];
      const target = original || next || remaining || listHeading.current;
      if (target?.isConnected) target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedTask]);

  // Old-account rows and pending detail reads must not survive account changes.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void queryClient.cancelQueries({ queryKey: ["my-tasks", actorId] });
      queryClient.removeQueries({ queryKey: ["my-tasks", actorId] });
      void queryClient.cancelQueries({ queryKey: ["my-task-details", actorId] });
      queryClient.removeQueries({ queryKey: ["my-task-details", actorId] });
    };
  }, [actorId, queryClient]);

  const { data: tasks = [], isLoading, isError, error, isFetching, refetch } = useQuery<Task[]>({
    queryKey: ["my-tasks", actorId, scope, unseenOnly],
    // This content is keyed by actor and scope; preserve view/search while only
    // the queue filter changes, without ever carrying rows across accounts.
    placeholderData: previous => previous,
    enabled: Boolean(actorId) && !accessDenied,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiFetch<Task[]>(
        `/api/tasks?${scope === "assigned" ? "assignedToMe=true" : `requestScope=${scope}`}&limit=${TASK_LIST_MAX_LIMIT}${unseenOnly ? "&unseen=1" : ""}`,
        { signal },
      );
      if (!Array.isArray(result)) throw new Error("INVALID_TASK_LIST");
      if (!signal.aborted) authorizedReads.current++;
      return result;
    },
  });

  const denied = isError && isMyTaskReadDenied(error);
  useEffect(() => {
    if (!denied) return;
    setAccessDenied(true);
    selectedRef.current = null;
    setSelectedTask(null);
    void queryClient.cancelQueries({ queryKey: ["my-tasks", actorId] });
    // Empty the sensitive data without treating this local clear as an authorized read.
    queryClient.setQueriesData<Task[]>({ queryKey: ["my-tasks", actorId] }, []);
    void queryClient.cancelQueries({ queryKey: ["my-task-details", actorId] });
    queryClient.removeQueries({ queryKey: ["my-task-details", actorId] });
  }, [actorId, denied, queryClient]);

  const retryAuthorizedList = useCallback(async () => {
    if (retryingAccess.current) return;
    retryingAccess.current = true;
    const before = authorizedReads.current;
    try {
      const result = await refetch();
      if (active.current && result.isSuccess && authorizedReads.current > before) setAccessDenied(false);
    } finally { retryingAccess.current = false; }
  }, [refetch]);

  // Apply filters and sorting
  const filteredAndSortedTasks = useMemo(() => {
    let filtered = [...tasks];

    // Priority filter
    if (priorityFilter !== "all") {
      filtered = filtered.filter((task) => priorityFilter === "URGENT" ? isUrgentRequest(task.priority) : priorityFilter === "LOW" ? ["LOW", "MEDIUM"].includes(task.priority) : task.priority === priorityFilter);
    }

    // Deadline filter
    if (deadlineFilter !== "all") {
      const now = new Date();
      filtered = filtered.filter((task) => {
        if (!task.deadline) return deadlineFilter === "none";
        const deadline = new Date(task.deadline);

        if (deadlineFilter === "overdue") return isPast(deadline) && !isToday(deadline);
        if (deadlineFilter === "today") return isToday(deadline);
        if (deadlineFilter === "week") {
          const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          return deadline <= weekFromNow && deadline >= now;
        }
        return true;
      });
    }

    // Column filter
    if (columnFilter !== "all") {
      filtered = filtered.filter((task) => task.column?.id === columnFilter);
    }

    return filtered.sort(compareRequestsForDisplay);
  }, [tasks, priorityFilter, deadlineFilter, columnFilter]);

  const handleTaskClick = (task: Task, opener = titleButtons.current.get(task.id) ?? null) => {
    if (selectedRef.current !== null) return;
    const index = filteredAndSortedTasks.findIndex(item => item.id === task.id);
    const neighbor = filteredAndSortedTasks[index + 1] ?? filteredAndSortedTasks[index - 1];
    opener?.focus();
    focusOrigin.current = { opener, taskId: task.id, nextTaskId: neighbor?.id ?? null };
    pendingFocusReturn.current = null;
    const selection = { actorId, projectId: task.project.id, taskId: task.id, openId: ++selectionSequence.current };
    selectedRef.current = selection;
    setSelectedTask(selection);
  };

  const handleClosePanel = useCallback((selection: MyTaskSelection, deleted = false) => {
    const current = selectedRef.current;
    if (current?.actorId !== selection.actorId || current.projectId !== selection.projectId
      || current.taskId !== selection.taskId || current.openId !== selection.openId) return;
    const origin = focusOrigin.current;
    if (origin?.taskId === selection.taskId) pendingFocusReturn.current = { origin, deleted };
    focusOrigin.current = null;
    selectedRef.current = null;
    setSelectedTask(null);
  }, []);

  const invalidateActorList = useCallback((selection: MyTaskSelection) => {
    const current = selectedRef.current;
    if (selection.actorId !== actorId || current?.actorId !== actorId
      || current.projectId !== selection.projectId || current.taskId !== selection.taskId || current.openId !== selection.openId) return;
    void queryClient.invalidateQueries({ queryKey: ["my-tasks", actorId] }).catch(() => undefined);
  }, [actorId, queryClient]);

  if (accessDenied || denied) {
    return <div role="alert" className="space-y-3 p-6">
      <p>Список задач недоступен. Проверьте вход и права доступа.</p>
      <Button variant="outline" disabled={isFetching} onClick={() => void retryAuthorizedList()}>Повторить загрузку задач</Button>
    </div>;
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <p role="status" aria-live="polite" className="text-muted-foreground">Загрузка...</p>
        </div>
      </div>
    );
  }

  const heading = scope === "mine" ? "Мои отправленные обращения" : scope === "reply" ? "Мне нужно ответить" : "Я исполнитель";
  const rows: TaskType[] = filteredAndSortedTasks.map(task => ({ ...task, projectId: task.project.id, position: 0, deadline: task.deadline ? new Date(task.deadline) : null }));
  return (
    <div className="request-department-page">
      {isError && <div role="alert"><p>Не удалось обновить список обращений. Ранее загруженные данные сохранены.</p><Button variant="outline" onClick={() => void refetch()}>Повторить загрузку задач</Button></div>}
      <div className="mb-6"><p className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Мои обращения</p><h1 ref={listHeading} tabIndex={-1} className="text-[28px] font-bold">{heading}</h1><p className="mt-2 text-muted-foreground">{scope === "reply" ? "Коллеге нужны подробности, чтобы продолжить работу. Откройте обращение и ответьте." : "Ваши обращения: видно, кто помогает и кого ждать."}</p></div>
      <RequestBoardPresentation tasks={rows} unseenOnly={unseenOnly} onUnseenOnlyChange={setUnseenOnly} defaultView={scope === "assigned" ? "board" : "list"} onOpen={(task, opener) => {
        const source = tasks.find(row => row.id === task.id);
        if (source) handleTaskClick(source, opener ?? null);
      }} titleButtonRef={(id, button) => { if (button) titleButtons.current.set(id, button); else titleButtons.current.delete(id); }} />
      {selectedTask?.actorId === actorId && <MyTaskCommandLoader
        key={JSON.stringify(selectedTask)} selection={selectedTask}
        onClose={() => handleClosePanel(selectedTask)}
        onDeleted={() => { invalidateActorList(selectedTask); handleClosePanel(selectedTask, true); }}
        onAuthoritativeRead={() => invalidateActorList(selectedTask)}
      />}
    </div>
  );
}
