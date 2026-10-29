"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useId, useRef, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import {
  X,
  Calendar,
  Flag,
  Loader2,
  Clock,
  Check,
  Trash2,
  Users,
  Pencil,
} from "lucide-react";
import { format, isPast, isToday, startOfDay } from "date-fns";
import { ru } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ActivityTimeline } from "@/components/task/ActivityTimeline";
import { TaskWatchersPanel } from "@/components/task/TaskWatchersPanel";
import { TaskRelatedRequests } from "@/components/task/TaskRelatedRequests";
import { TaskAttachments } from "@/components/task/TaskAttachments";

const TaskChatPanel = dynamic(
  () => import("@/components/task/TaskChatPanel").then((mod) => ({ default: mod.TaskChatPanel })),
  {
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
    ssr: false,
  }
);
// The deadline picker is only needed after its popover opens. Keep it out of
// the initial request editor chunk and load it when the user needs it.
const CalendarComponent = dynamic(() => import("@/components/ui/calendar").then(mod => mod.Calendar), {
  ssr: false,
  loading: () => <div role="status" className="flex min-h-64 items-center justify-center p-4 text-sm text-muted-foreground">Загрузка календаря…</div>,
});
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AssigneeSelector } from "@/components/task/AssigneeSelector";
import { TaskRequestLifecycleControls } from "@/components/task/TaskRequestLifecycleControls";
import type { TaskType } from "@/components/kanban/Card";
import { decodeRequestDescription, encodeRequestDescription, isUrgentRequest, isBeznalProject } from "@/lib/request-presentation";
import { toast } from "sonner";
import { RequestDetailsSummary } from "./RequestDetailsSummary";
import { TaskChangeDetails } from "./TaskChangeInformation";
import { getRequestBoardPhase } from "@/lib/request-board-phase";

const RichTextEditor = dynamic(
  () => import("@/components/editor/RichTextEditor").then((mod) => ({ default: mod.RichTextEditor })),
  {
    loading: () => (
      <div className="flex h-32 items-center justify-center border rounded-md">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
    ssr: false,
  }
);


export type TaskSaveCallbacks = { onSuccess: (savedTask: Pick<TaskType, "title">) => void; onError: () => void };
export type TaskEditCapabilities = { canEditFields: boolean; canEditDescription: boolean; canSetDeadline: boolean; canUseLegacyAssignees: boolean };

type Props = {
  task: TaskType | null;
  onClose: () => void;
  onDelete?: (taskId: string) => void;
  onSave: (
    taskId: string,
    data: Pick<TaskType, "title"> & {
      description?: string | null;
      priority?: string;
      columnId?: string;
      expectedVersion?: number;
      deadline?: Date | null;
    },
    callbacks?: TaskSaveCallbacks
  ) => void;
  isSaving?: boolean;
  scalarSaveBlocked?: boolean;
  saveStatus?: ReactNode;
  headingLevel?: 1 | 2;
  onLocalEditsChange?: (dirty: boolean, inputEvent?: boolean) => void;
  onLifecycleChanged?: () => void;
  editCapabilities?: TaskEditCapabilities;
};

const priorityColors: Record<string, string> = {
  CRITICAL: "priority-critical",
  URGENT: "priority-urgent",
  HIGH: "priority-high",
  MEDIUM: "priority-medium",
  LOW: "priority-low",
};

const priorityLabels: Record<string, string> = {
  CRITICAL: "Срочно",
  URGENT: "Срочно",
  HIGH: "Срочно",
  MEDIUM: "Не срочно",
  LOW: "Не срочно",
};

export function TaskDetailPanel(props: Props) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return <TaskDetailPanelContent key={JSON.stringify([userId, props.task?.id])} {...props} userId={userId} />;
}

function TaskDetailPanelContent({ task, onClose, onSave, onDelete, scalarSaveBlocked = false, saveStatus, headingLevel = 2, userId, onLocalEditsChange, onLifecycleChanged, editCapabilities }: Props & { userId?: string }) {
  const reducedMotion = useReducedMotion();
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const draft = useTaskDraft(userId, task?.id);
  const [manualTitleSave, setManualTitleSave] = useState(false);
  const [descriptionSaveFailed, setDescriptionSaveFailed] = useState(false);
  const descriptionAttemptRef = useRef(0);
  const restoredDescriptionRef = useRef(false);
  const descriptionStateRef = useRef("");

  const titleInputId = useId();
  const [title, setTitle] = useState("");
  const titleFieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = titleFieldRef.current;
    if (!field) return;
    const resize = () => { field.style.height = "auto"; field.style.height = `${field.scrollHeight}px`; };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(field);
    return () => observer?.disconnect();
  }, [title]);
  const [description, setDescription] = useState<string>("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [addingAttachments, setAddingAttachments] = useState(false);
  const [chatReady, setChatReady] = useState(false);
  const [lifecycleReady, setLifecycleReady] = useState(false);
  descriptionStateRef.current = description;
  const [priority, setPriority] = useState<string>("MEDIUM");
  const [deadline, setDeadline] = useState<Date | null>(null);
  const [selectedAssignees, setSelectedAssignees] = useState<Array<{ id: string; user: { id: string; name: string | null; email: string; avatarUrl?: string | null } }>>([]);
  const [attachments, setAttachments] = useState<Array<{ url: string; name: string; size: number; mime: string; width?: number; height?: number }>>([]);

  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  const [titleSaved, setTitleSaved] = useState(false);
  const [titleSaveFailed, setTitleSaveFailed] = useState(false);
  const titleAttemptRef = useRef(0);
  const confirmedTitleRef = useRef<string | null>(null);
  const titleStateRef = useRef({ taskId: task?.id, title, canonicalTitle: task?.title });
  titleStateRef.current = { taskId: task?.id, title, canonicalTitle: task?.title };
  const [descriptionSaved, setDescriptionSaved] = useState(false);
  const [hasUnsavedDescription, setHasUnsavedDescription] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const sectionId = useId();

  const titleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [initializedTaskId, setInitializedTaskId] = useState<string | null>(null);
  const isInitialized = Boolean(task && initializedTaskId === task.id);
  const lastSavedTitleRef = useRef<string>("");
  const localPriorityRef = useRef<string | null>(null);
  const localDeadlineRef = useRef<Date | null | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const deadlineTriggerRef = useRef<HTMLButtonElement>(null);
  const deadlinePopoverRef = useRef<HTMLDivElement>(null);
  const deadlineEscapeOriginRef = useRef<{
    panel: HTMLDivElement | null;
    content: HTMLDivElement | null;
  } | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousSyncedTaskRef = useRef<TaskType | null>(null);
  const latestOnCloseRef = useRef(onClose);
  const taskId = task?.id;
  const requestKind = decodeRequestDescription(task?.description).details?.kind;
  const beznal = isBeznalProject(task?.project?.name) || requestKind === "beznal";
  useEffect(() => {
    if (!beznal || !taskId) return;
    const committed = (event: Event) => {
      if ((event as CustomEvent<{ taskId?: string }>).detail?.taskId !== taskId) return;
      toast.success("Файл прикреплён", { description: "Файл доступен во вложениях." });
    };
    window.addEventListener("beznal:attachment-committed", committed);
    return () => window.removeEventListener("beznal:attachment-committed", committed);
  }, [beznal, taskId]);
  const directionName = task?.project?.name || (requestKind === "beznal" ? "Безнал ОП" : requestKind === "claim" ? "🔥 Претензии клиентов" : requestKind === "it" ? "🛠 Техподдержка и ИТ" : "Обращение");
  // Production entry points always supply the actor-scoped server projection.
  // Isolated legacy embedders keep their former behavior; marked snapshots
  // never infer a write capability from visibility or a local assignee list.
  const canEditFields = editCapabilities?.canEditFields ?? !task?.request;
  const canEditDescription = editCapabilities?.canEditDescription ?? !task?.request;
  const canUseLegacyAssignees = editCapabilities?.canUseLegacyAssignees ?? !task?.request;
  const canSetDeadline = editCapabilities?.canSetDeadline ?? Boolean(!task?.request && userId && task?.assignees?.length === 1 && task.assignees[0].user.id === userId);
  useLayoutEffect(() => {
    const dirty = !task || !draft.ready || Boolean(draft.recovery) || draft.error ||
      title.trim() !== task.title.trim() || description.trim() !== (task.description ?? "").trim() ||
      priority !== (task.priority ?? "MEDIUM") ||
      (deadline?.getTime() ?? null) !== (task.deadline ? new Date(task.deadline).getTime() : null);
    onLocalEditsChange?.(dirty);
  }, [task, draft.ready, draft.recovery, draft.error, title, description, priority, deadline, onLocalEditsChange]);

  useEffect(() => {
    if (!taskId) return;
    // Readiness must render: an edit made while the initial server fields are
    // settling still needs its autosave scheduled. Scope/cancel the timer by
    // task identity, not server object updates, and never enable another task.
    const timer = setTimeout(() => setInitializedTaskId(taskId), 100);
    return () => clearTimeout(timer);
  }, [taskId]);

  // Wrapper functions to set values and update refs
  const handlePriorityChange = (newPriority: string) => {
    if (scalarSaveBlocked || !canEditFields) return;
    onLocalEditsChange?.(true, true);
    localPriorityRef.current = newPriority;
    setPriority(newPriority);
  };

  const handleDeadlineChange = (newDeadline: Date | null) => {
    if (scalarSaveBlocked || !canSetDeadline) return;
    onLocalEditsChange?.(true, true);
    localDeadlineRef.current = newDeadline;
    setDeadline(newDeadline);
  };

  const handleDeleteClick = useCallback(() => {
    if (task && onDelete) {
      onDelete(task.id);
    }
  }, [task, onDelete]);


  // Sync task data to state on initial load or when task changes (from Socket.IO)
  useEffect(() => {
    if (!task) return;
    const isNewTask = previousSyncedTaskRef.current?.id !== task.id;
    const taskTitle = task.title ?? "";
    if (isNewTask || previousSyncedTaskRef.current?.title !== task.title) {
      if (isNewTask || (!manualTitleSave && title.trim() === lastSavedTitleRef.current)) setTitle(taskTitle);
      // Advance the baseline even when retaining a local draft: undoing to an
      // older title is still a real edit relative to the colleague's new title.
      lastSavedTitleRef.current = taskTitle;
    }
    if (isNewTask || (previousSyncedTaskRef.current?.description !== task.description &&
        !hasUnsavedDescription && !restoredDescriptionRef.current)) {
      setDescription(task.description ?? "");
      setHasUnsavedDescription(false);
    }
    previousSyncedTaskRef.current = task;

    // Only update priority from server if there's no pending local change
    // This prevents overwriting user's unsaved changes when Socket.IO updates come in
    if (!localPriorityRef.current) {
      setPriority(task.priority ?? "MEDIUM");
    }

    if (localDeadlineRef.current === undefined) {
      setDeadline(task.deadline ? new Date(task.deadline) : null);
    }
    setSelectedAssignees(task.assignees ?? []);
    setAttachments(task.attachments ?? []);
  }, [task]);


  // Auto-save title with debounce
  const saveTitle = (id: string, value: string) => {
    if (scalarSaveBlocked || !canEditFields) return;
    const submitted = title;
    const attempt = ++titleAttemptRef.current;
    setIsSavingTitle(true);
    setTitleSaved(false);
    setTitleSaveFailed(false);
    lastSavedTitleRef.current = value;
    const isCurrent = () => titleStateRef.current.taskId === id && titleAttemptRef.current === attempt;
    onSave(id, { title: value }, {
      onSuccess: (savedTask) => {
        draft.acknowledge("title", submitted);
        if (!isCurrent()) return;
        setIsSavingTitle(false);
        confirmedTitleRef.current = savedTask.title;
        setTitleSaved(true);
        if (titleStateRef.current.title === submitted) setManualTitleSave(false);
      },
      onError: () => {
        if (!isCurrent()) return;
        setIsSavingTitle(false);
        setTitleSaved(false);
        setTitleSaveFailed(true);
      },
    });
  };

  useEffect(() => {
    setIsSavingTitle(false);
    setTitleSaved(false);
    setTitleSaveFailed(false);
    return () => { titleAttemptRef.current += 1; };
  }, [taskId]);

  useEffect(() => {
    if (!task || scalarSaveBlocked || !canEditFields || !isInitialized || !draft.ready || draft.recovery || manualTitleSave) return;

    const normalizedTitle = title.trim();

    // Check against last saved title to prevent infinite loops
    if (normalizedTitle === lastSavedTitleRef.current || !normalizedTitle) return;

    if (titleTimeoutRef.current) {
      clearTimeout(titleTimeoutRef.current);
    }

    titleTimeoutRef.current = setTimeout(() => {
      saveTitle(task.id, normalizedTitle);
    }, 1000);

    return () => {
      if (titleTimeoutRef.current) {
        clearTimeout(titleTimeoutRef.current);
      }
    };
  }, [title, task, onSave, draft.ready, draft.recovery, manualTitleSave, scalarSaveBlocked, canEditFields, isInitialized]);

  // Auto-save priority and deadline immediately
  useEffect(() => {
    if (!task || scalarSaveBlocked || !canEditFields || !isInitialized) return;
    // Only save if local change (not from server update)
    if (localPriorityRef.current !== priority) return;
    if (priority === task.priority) return;
    if (!priority) return;

    onSave(task.id, { title: task.title, priority }, {
      onSuccess: () => undefined,
      // A concrete rejection must not leave a draft priority looking saved.
      // Unknown outcomes retain their frozen command; this callback is only
      // invoked by the controller once the server has rejected the write.
      onError: () => { localPriorityRef.current = null; setPriority(task.priority ?? "MEDIUM"); },
    });
    localPriorityRef.current = null; // Reset after save
  }, [priority, task?.id, onSave, scalarSaveBlocked, canEditFields, isInitialized]);

  useEffect(() => {
    if (!task || scalarSaveBlocked || !canSetDeadline || !isInitialized) return;
    // Only save if local change (not from server update)
    if (localDeadlineRef.current === undefined) return;

    const taskDeadline = task.deadline ? new Date(task.deadline) : null;
    const taskDeadlineDay = taskDeadline ? startOfDay(taskDeadline).getTime() : null;
    const deadlineDay = deadline ? startOfDay(deadline).getTime() : null;

    if (taskDeadlineDay === deadlineDay) return;

    onSave(task.id, { title: task.title, deadline });
    localDeadlineRef.current = undefined; // Reset after save
  }, [deadline, task, onSave, scalarSaveBlocked, canSetDeadline, isInitialized]);

  const handleSaveDescription = useCallback(() => {
    if (!task || scalarSaveBlocked || !canEditDescription || !draft.ready || draft.recovery) return;

    const taskDescription = (task.description ?? "").trim();
    const normalizedDescription = description.trim();

    if (normalizedDescription === taskDescription && !restoredDescriptionRef.current) return;

    const attempt = ++descriptionAttemptRef.current;
    setIsSavingDescription(true);
    setDescriptionSaved(false);
    setDescriptionSaveFailed(false);
    onSave(task.id, {
      title: task.title,
      description: normalizedDescription || null,
    }, {
      onSuccess: () => {
        draft.acknowledge("description", description);
        if (descriptionAttemptRef.current !== attempt) return;
        setIsSavingDescription(false);
        if (descriptionStateRef.current === description) {
          setEditingDescription(false);
          restoredDescriptionRef.current = false;
          setHasUnsavedDescription(false);
          setDescriptionSaved(true);
        }
      },
      onError: () => {
        if (descriptionAttemptRef.current !== attempt) return;
        setIsSavingDescription(false);
        setDescriptionSaveFailed(true);
      },
    });
  }, [task, description, onSave, draft, scalarSaveBlocked, canEditDescription]);

  // Track unsaved description changes
  useEffect(() => {
    if (!task || !isInitialized) return;

    const taskDescription = (task.description ?? "").trim();
    const normalizedDescription = description.trim();

    setHasUnsavedDescription(restoredDescriptionRef.current || normalizedDescription !== taskDescription);
  }, [description, task, isInitialized]);

  useEffect(() => {
    latestOnCloseRef.current = onClose;
  }, [onClose]);

  // The on-screen keyboard shrinks visualViewport without changing dvh on some
  // mobile browsers. Track it so the panel (and its message composer) stays in
  // the actually visible area; dvh remains the fallback when it is unavailable.
  // A pinch zoom also shrinks this viewport, so leave the layout height alone
  // while the user is zoomed in to read the card.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const syncHeight = () => setViewportHeight(
      viewport.scale === undefined || viewport.scale <= 1 ? Math.round(viewport.height) : null
    );
    syncHeight();
    viewport.addEventListener("resize", syncHeight);
    viewport.addEventListener("scroll", syncHeight);
    return () => {
      viewport.removeEventListener("resize", syncHeight);
      viewport.removeEventListener("scroll", syncHeight);
    };
  }, []);

  // Focus belongs to the opened task, not each refreshed task snapshot.
  useEffect(() => {
    if (!taskId || !panelRef.current) return;

    // Store the element that had focus before the panel opened
    previousFocusRef.current = document.activeElement as HTMLElement;
    const openedPanel = panelRef.current;
    const opener = previousFocusRef.current;

    // Focus the first focusable element in the panel
    const firstFocusable = panelRef.current.querySelector<HTMLElement>(
      'button, summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!panelRef.current) return;

      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        // Portalled menus/dialogs own their Escape before the task panel does.
        if (e.target instanceof Node && !panelRef.current.contains(e.target)) return;
        e.preventDefault();
        latestOnCloseRef.current();
        return;
      }

      // Focus trap: Tab cycling
      if (e.key === "Tab") {
        const focusableElements = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
          'button, summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )).filter(element => !element.matches(":disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0);
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          // Shift+Tab: If on first element, go to last
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement?.focus();
          }
        } else {
          // Tab: If on last element, go to first
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement?.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const activeElement = document.activeElement;
      if (opener.isConnected && opener !== document.body &&
          (activeElement === document.body || openedPanel.contains(activeElement))) {
        opener.focus();
      }
      previousFocusRef.current = null;
    };
  }, [taskId]);

  return (
    <AnimatePresence>
      {task ? (
        <>
          <motion.div
            key="backdrop"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: reducedMotion ? 1 : 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.15 }}
            className="fixed inset-0 z-40 bg-black/30"
            onClick={onClose}
          />

            <motion.aside
              key="panel"
              ref={panelRef}
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: reducedMotion ? 1 : 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.15 }}
              style={viewportHeight ? { maxHeight: `${Math.max(160, viewportHeight - 32)}px` } : undefined}
              className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] max-w-[740px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-clip rounded-2xl border bg-card shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-label="Детали обращения"
            >
            <Heading className="sr-only">{task.title || "Без названия"}</Heading>

            <div role="group" aria-label="Шапка карточки" className="flex min-h-14 min-w-0 shrink-0 items-center justify-between gap-2 border-b px-3 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-4 max-md:[@media(max-height:420px)]:min-h-11">
              <div className="flex min-w-0 flex-1 flex-col">
                <p
                  className="min-w-0 truncate text-sm text-muted-foreground"
                  title={directionName}
                  data-testid="task-header-title"
                >
                  {directionName}
                </p>
              </div>
              <div role="group" aria-label="Действия с задачей" className="flex shrink-0 items-center gap-1 sm:gap-2">
                {onDelete && <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleDeleteClick}
                  className="w-9 gap-2 px-0 text-destructive hover:text-destructive sm:w-auto sm:px-3"
                  aria-label="Удалить"
                  title="Удалить"
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Удалить</span>
                </Button>}
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md px-2 hover:bg-accent cursor-pointer"
                  aria-label="Закрыть окно"
                >
                  <X className="h-4 w-4" />
                  <span className="text-sm">Закрыть окно</span>
                </button>
              </div>
            </div>

            {/* Clip the fixed shell instead of creating another scroll container:
                focus/scrollIntoView must scroll only this body, never the header. */}
            <div data-testid="task-detail-scroll" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="min-w-0 p-4 sm:p-6 space-y-6">
                <div id={`${sectionId}-details`} role="region" aria-label="Описание и свойства задачи" className="min-w-0 space-y-6">
                      {saveStatus}
                      {draft.recovery && <section className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3" aria-label="Локальный черновик">
                        <p className="font-medium">Найден черновик</p>
                        <p className="text-sm text-muted-foreground">Текст сохранён только в этом браузере. После восстановления проверьте его и нажмите «Сохранить»: изменения не отправятся автоматически.</p>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => {
                            onLocalEditsChange?.(true, true);
                            if (draft.recovery?.title !== undefined) { setTitle(draft.recovery.title); setManualTitleSave(true); }
                            if (draft.recovery?.description !== undefined) { restoredDescriptionRef.current = true; setEditingDescription(true); setDescription(draft.recovery.description); setHasUnsavedDescription(true); }
                            draft.dismiss(false);
                          }}>Восстановить черновик</Button>
                          <Button size="sm" variant="outline" onClick={() => draft.dismiss(true)}>Удалить несохранённый текст</Button>
                        </div>
                      </section>}
                      {draft.error && <p role="alert" className="text-sm text-destructive">Не удалось сохранить черновик в браузере. Не закрывайте карточку до сохранения на сервере.</p>}
                      <TaskChangeDetails task={task} ready={chatReady && lifecycleReady}/>
                      <TaskRequestLifecycleControls taskId={task.id} projectId={task.projectId} actorId={userId} disabled={scalarSaveBlocked} onChanged={onLifecycleChanged} compact boardPhase={beznal ? getRequestBoardPhase(task, true) : undefined} onReadinessChange={setLifecycleReady}/>
                      {/* Readable text never switches modes on click or selection. */}
                      <section aria-label="Тема обращения" className="min-w-0 space-y-3 rounded-xl border bg-muted/10 p-4">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <label htmlFor={titleInputId} className="text-sm font-semibold text-muted-foreground">Тема обращения</label>
                          {canEditFields && !manualTitleSave && <Button type="button" variant="ghost" size="sm" className="shrink-0 gap-2"
                            aria-label="Изменить тему обращения" data-telemetry-action="task.title.edit"
                            disabled={scalarSaveBlocked || !draft.ready || Boolean(draft.recovery)}
                            onClick={() => { setManualTitleSave(true); requestAnimationFrame(() => titleFieldRef.current?.focus()); }}>
                            <Pencil className="h-4 w-4" aria-hidden="true" /><span>Изменить</span>
                          </Button>}
                        </div>
                        <div className="flex min-w-0 items-start gap-3">
                          <textarea ref={titleFieldRef} rows={1} id={titleInputId} value={title}
                            readOnly={!canEditFields || !manualTitleSave || scalarSaveBlocked || !draft.ready || Boolean(draft.recovery)} maxLength={200}
                            onChange={(e) => { if (!canEditFields || scalarSaveBlocked || !manualTitleSave || !draft.ready || draft.recovery) return; onLocalEditsChange?.(true, true); draft.change("title", e.target.value); setTitle(e.target.value); setTitleSaved(false); }}
                            className={cn("min-w-0 w-full flex-1 resize-none overflow-hidden bg-transparent text-2xl font-bold leading-snug outline-none placeholder:text-muted-foreground", manualTitleSave && "rounded-md border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring")}
                            placeholder="Название задачи..." />
                          <div className="flex shrink-0 items-center gap-1">
                            {isSavingTitle && <span role="status" aria-label="Сохранение названия"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></span>}
                            {titleSaved && title.trim() === confirmedTitleRef.current?.trim() && <span role="status" aria-label="Название сохранено"><Check className="h-4 w-4 text-green-500" /></span>}
                          </div>
                        </div>
                        {canEditFields && manualTitleSave && <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" onClick={() => saveTitle(task.id, title.trim())} disabled={scalarSaveBlocked || !title.trim() || isSavingTitle}>Сохранить название</Button>
                          <Button type="button" size="sm" variant="outline" disabled={scalarSaveBlocked || isSavingTitle} onClick={() => {
                            draft.acknowledge("title", title); setTitle(task.title ?? ""); lastSavedTitleRef.current = task.title ?? "";
                            setManualTitleSave(false); setTitleSaveFailed(false); setTitleSaved(false);
                          }}>Отменить изменение темы</Button>
                        </div>}
                        {canEditFields && titleSaveFailed && <div role="alert" className="text-xs text-destructive">
                          Название не сохранено. <button type="button" className="underline" onClick={() => saveTitle(task.id, title.trim())} disabled={scalarSaveBlocked || !title.trim()}>Повторить сохранение названия</button>
                        </div>}
                      </section>

                      {isUrgentRequest(priority) && <p className="w-fit rounded-md bg-red-100 px-3 py-1 text-sm font-bold text-red-800 dark:bg-red-950 dark:text-red-200">СРОЧНО</p>}
                      {/* Description section */}
                      <section aria-label="Описание" className="min-w-0 space-y-3 rounded-xl border bg-muted/10 p-4">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <h3 className="text-sm font-semibold text-muted-foreground">Описание</h3>
                            {task.request && task.request.state !== "DRAFT" && task.descriptionEditedAt && Number.isFinite(Date.parse(task.descriptionEditedAt)) &&
                              <time dateTime={task.descriptionEditedAt} className="block text-xs text-muted-foreground" title="Описание изменено после отправки обращения">
                                Изменено {format(new Date(task.descriptionEditedAt), "d MMM yyyy, HH:mm", { locale: ru })}
                              </time>}
                          </div>
                          {canEditDescription && !editingDescription && <Button type="button" variant="ghost" size="sm" className="shrink-0 gap-2" aria-label="Изменить описание"
                            data-telemetry-action="task.description.edit" onClick={() => setEditingDescription(true)} disabled={scalarSaveBlocked || !draft.ready || Boolean(draft.recovery)}>
                            <Pencil className="h-4 w-4" aria-hidden="true" /><span>Изменить</span>
                          </Button>}
                        </div>
                        <div className="min-w-0 overflow-hidden [&_.ProseMirror]:[overflow-wrap:anywhere]">
                          {draft.ready && !draft.recovery && <RichTextEditor
                            editable={canEditDescription && editingDescription && !scalarSaveBlocked}
                            className={!editingDescription ? "border-0 bg-transparent [&_.ProseMirror]:min-h-0 [&_.ProseMirror]:px-0 [&_.ProseMirror]:py-0 [&_.ProseMirror]:text-base" : undefined}
                            content={decodeRequestDescription(description).body}
                            onChange={(value) => {
                              if (!canEditDescription || scalarSaveBlocked || !editingDescription) return;
                              onLocalEditsChange?.(true, true);
                              const details = decodeRequestDescription(description).details ?? decodeRequestDescription(task.description).details;
                              const encoded = encodeRequestDescription(value, details ?? undefined) ?? "";
                              draft.change("description", encoded);
                              setDescription(encoded);
                              // Protect a visible early edit before the deferred
                              // dirty-tracking effect can run for this task.
                              setHasUnsavedDescription(restoredDescriptionRef.current || encoded.trim() !== (task.description ?? "").trim());
                              setDescriptionSaved(false);
                            }}
                            placeholder="Добавьте описание задачи..."
                            onSave={handleSaveDescription}
                            isSaving={isSavingDescription || scalarSaveBlocked}
                            isSaved={descriptionSaved}
                            hasUnsavedChanges={canEditDescription && hasUnsavedDescription}
                          />}
                          {canEditDescription && editingDescription && <Button type="button" size="sm" variant="outline" className="mt-3" disabled={scalarSaveBlocked || isSavingDescription} onClick={() => {
                            draft.acknowledge("description", description); setDescription(task.description ?? ""); setHasUnsavedDescription(false);
                            restoredDescriptionRef.current = false; setEditingDescription(false); setDescriptionSaveFailed(false); setDescriptionSaved(false);
                          }}>Отменить изменение описания</Button>}
                          {descriptionSaveFailed && <p role="alert" className="text-sm text-destructive">Описание не сохранено. Повторите сохранение.</p>}
                        </div>
                      </section>

                      <RequestDetailsSummary task={task} description={task.description}/>
                      {!canEditFields && <section aria-label="Параметры обращения" className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
                        <div><p className="text-muted-foreground">Срочность</p><p>{priorityLabels[task.priority] ?? "Не срочно"}</p></div>
                        {!canSetDeadline && <div><p className="text-muted-foreground">Выполнить до</p><p>{task.deadline ? format(new Date(task.deadline), "d MMM yyyy", { locale: ru }) : "Дата не назначена"}</p></div>}
                      </section>}
                      {(canEditFields || canSetDeadline || canUseLegacyAssignees) && <details className="rounded-lg border p-4">
                        <summary className="cursor-pointer text-sm font-medium">Изменить параметры обращения</summary>
                        <div className="mt-4">{/* Properties section */}
                      <div className="space-y-3">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          Свойства
                        </label>
                        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-3">
                          {/* Priority */}
                          {canEditFields && <div className="min-w-0 p-3 rounded-lg border bg-card shadow-sm">
                            <div className="flex items-center gap-2 mb-2">
                              <Flag className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-medium">Приоритет</span>
                            </div>
                            <Select value={isUrgentRequest(priority) ? "URGENT" : "LOW"} onValueChange={handlePriorityChange} disabled={scalarSaveBlocked}>
                              <SelectTrigger aria-label="Приоритет задачи" className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="max-w-[calc(100vw-1rem)] max-h-[var(--radix-select-content-available-height)]">
                                {(["URGENT", "LOW"] as const).map((opt) => (
                                  <SelectItem key={opt} value={opt}>
                                    <span
                                      className={cn(
                                        "inline-flex items-center gap-2",
                                        priorityColors[opt]
                                      )}
                                    >
                                      {priorityLabels[opt]}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>}

                          {/* Deadline */}
                          {(canEditFields || canSetDeadline) && <div className="min-w-0 p-3 rounded-lg border bg-card shadow-sm">
                            <div className="flex items-center gap-2 mb-2">
                              <Calendar className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-medium">Срок выполнения</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Button
                                    ref={deadlineTriggerRef}
                                    variant="outline"
                                    size="sm"
                                    disabled={scalarSaveBlocked || !canSetDeadline}
                                    className={cn(
                                      "h-9 min-w-0 flex-1",
                                      deadline &&
                                        isPast(deadline) &&
                                        !isToday(deadline) &&
                                        "text-red-500 border-red-500/30"
                                    )}
                                  >
                                    <Clock className="h-4 w-4 mr-1" />
                                    {deadline
                                      ? format(deadline, "d MMM", { locale: ru })
                                      : canSetDeadline ? "Установить" : "Не установлен"}
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent
                                  ref={deadlinePopoverRef}
                                  className="w-auto max-w-[calc(100vw-1rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-0"
                                  align="start"
                                  collisionPadding={8}
                                  onOpenAutoFocus={() => { deadlineEscapeOriginRef.current = null; }}
                                  onEscapeKeyDown={() => {
                                    deadlineEscapeOriginRef.current = {
                                      panel: panelRef.current,
                                      content: deadlinePopoverRef.current,
                                    };
                                  }}
                                  onCloseAutoFocus={event => {
                                    const origin = deadlineEscapeOriginRef.current;
                                    deadlineEscapeOriginRef.current = null;
                                    if (!origin) return;
                                    const panel = origin.panel;
                                    const trigger = deadlineTriggerRef.current;
                                    if (!panel?.isConnected || panelRef.current !== panel) {
                                      event.preventDefault();
                                      return;
                                    }
                                    const focused = document.activeElement;
                                    const focusMoved = focused?.isConnected && focused !== document.body
                                      && focused !== trigger && !origin.content?.contains(focused);
                                    const anotherDialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
                                      .some(dialog => dialog !== panel && dialog !== origin.content
                                        && !dialog.closest('[hidden], [aria-hidden="true"], [data-state="closed"]'));
                                    if (focusMoved || anotherDialog) {
                                      event.preventDefault();
                                      return;
                                    }
                                    // Radix restores its trigger normally; a pending save
                                    // disables that button, so keep focus in this panel.
                                    if (trigger?.isConnected && !trigger.disabled) return;
                                    event.preventDefault();
                                    const fallback = panel.querySelector<HTMLButtonElement>('button[aria-label="Закрыть окно"]:not(:disabled):not([aria-disabled="true"])');
                                    if (fallback?.isConnected) fallback.focus();
                                  }}
                                >
                                  <CalendarComponent
                                    disabled={scalarSaveBlocked || !canSetDeadline}
                                    mode="single"
                                    selected={deadline ?? undefined}
                                    onSelect={(date) => handleDeadlineChange(date ?? null)}
                                    initialFocus
                                  />
                                </PopoverContent>
                              </Popover>
                              {deadline && canSetDeadline && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-9 w-9 shrink-0 p-0"
                                  aria-label="Очистить дедлайн"
                                  disabled={scalarSaveBlocked || !canSetDeadline}
                                  title="Очистить дедлайн"
                                  onClick={() => handleDeadlineChange(null)}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>}
                        </div>

                        {/* Current assignee; assignment controls enforce role authority. */}
                        {canUseLegacyAssignees && <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
                          {/* Assignees */}
                          <div className="min-w-0 p-3 rounded-lg border bg-card shadow-sm [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:h-auto [&>button]:min-h-9">
                            <div className="flex items-center gap-2 mb-2">
                              <Users className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-medium">Исполнители</span>
                            </div>
                            {canUseLegacyAssignees && <AssigneeSelector
                              projectId={task.projectId}
                              taskId={task.id}
                              selectedAssignees={selectedAssignees}
                              onAssigneesChange={setSelectedAssignees}
                            />}
                            {selectedAssignees.length > 0 && (
                              <div className="flex flex-wrap gap-2 mt-2">
                                {selectedAssignees.map((assignee) => (
                                  <div
                                    key={assignee.id}
                                    className="flex min-w-0 max-w-full items-center gap-2 px-2 py-1 rounded-md bg-secondary/50 text-sm"
                                  >
                                    <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                                      {assignee.user.name || assignee.user.email}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                        </div>}
                      </div>

</div>
                      </details>}
                      {/* Existing files stay visible; an empty upload surface is opt-in. */}
                      {(attachments.length > 0 || addingAttachments) ? <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Вложения
                          </label>
                          {attachments.length > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {attachments.length}
                            </span>
                          )}
                        </div>
                        <div className="p-4 rounded-lg border bg-card shadow-sm">
                          <TaskAttachments
                            taskId={task.id}
                            version={task.version}
                            marked={Boolean(task.request)}
                            canUpload={canEditDescription && !scalarSaveBlocked}
                            canRemove={canEditDescription && !scalarSaveBlocked}
                            onCommitted={onLifecycleChanged}
                            attachments={attachments}
                            onUpdate={setAttachments}
                          />
                        </div>
                      </div> : canEditDescription && !scalarSaveBlocked ? <Button type="button" variant="outline" className="min-h-11" onClick={() => setAddingAttachments(true)}>Прикрепить файл</Button> : null}
                </div>
                <TaskWatchersPanel taskId={task.id} projectId={task.projectId} actorId={userId} disabled={scalarSaveBlocked} onChanged={onLifecycleChanged} />
                <TaskRelatedRequests taskId={task.id} version={task.version ?? 0} actorId={userId ?? ""} onChanged={onLifecycleChanged} />
                <section aria-label="Переписка" className="min-w-0 space-y-3">
                  <h3 className="text-xl font-semibold">Переписка</h3>
                  <TaskChatPanel taskId={task.id} mode="thread" onReadinessChange={setChatReady}/>
                  <p className="text-sm text-muted-foreground">Обычный комментарий не меняет статус обращения.</p>
                </section>
                <section aria-label="История действий" className="min-w-0 space-y-3 rounded-xl border bg-muted/10 p-4">
                  <h3 className="text-xl font-semibold">История действий</h3>
                  <p className="text-base text-muted-foreground">Здесь видны изменения статуса, исполнителя и текста. Сообщения сотрудников находятся отдельно в переписке выше.</p>
                  <details onToggle={event => setHistoryOpen(event.currentTarget.open)}>
                    <summary className="min-h-12 cursor-pointer py-3 text-base font-medium">Показать историю действий</summary>
                    {historyOpen && <div className="mt-3"><ActivityTimeline taskId={task.id} /></div>}
                  </details>
                </section>
              </div>
            </div>

          </motion.aside>

        </>
      ) : null}
    </AnimatePresence>
  );
}
