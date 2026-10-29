"use client";

import { RequestActionsContext } from "@/components/task/RequestQuickTake";
import { isUrgentRequest } from "@/lib/request-presentation";
import { RequestBoardPresentation } from "./RequestBoardPresentation";
import { TaskChangesProvider } from "@/components/task/TaskChangeInformation";
import { useRequestDialog } from "@/components/task/RequestDialogProvider";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  type Announcements,
  type CollisionDetection,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragMoveEvent,
  DragEndEvent,
  DragOverEvent,
} from "@dnd-kit/core";
import dynamic from "next/dynamic";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { Plus } from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { KanbanColumn } from "./Column";
import { KanbanCardView, type TaskType } from "./Card";
import { SkeletonColumn } from "@/components/shared/skeleton";
import { BulkActionsBar } from "@/components/bulk/BulkActionsBar";
import { apiFetch, apiPost } from "@/lib/api";
import { useRequestQueueUnseenCounts } from "@/hooks/useRequestQueueUnseenCounts";
import { TASK_LIST_MAX_LIMIT } from "@/lib/task-list-limits";
import { isTaskVisibleInRequestList } from "@/lib/task-list-visibility";
import { useProjectBoard } from "@/hooks/useProjectBoard";
import {
  requestCanonicalTaskMovedRefresh,
  shouldApplyTaskVersionSnapshot,
  type TaskMovedEventPayload,
} from "@/hooks/useProjectBoard";
import { normalizeBoard } from "@/features/kanban/model/normalize-board";
import { planMove } from "@/features/kanban/model/plan-move";
import { TaskMoveMenuProvider, type TaskMoveMenuCommand } from "@/features/kanban/components/TaskMoveMenu";
import { sortTasksForDisplay } from "@/features/kanban/model/task-display-sort";
import { compareRequestsByVisibleWork } from "@/lib/request-display-order";
import { isTaskReorderEnabled } from "@/features/kanban/dnd/use-kanban-dnd";
import { getMoveErrorFeedback } from "@/features/kanban/accessibility/move-announcements";
import { derivedTaskStatus, resolveWorkflowColumnFilter, type MoveTaskResponse } from "@/features/kanban/server/move-contract";
import { planLegacyMove, type LegacyRect } from "./legacy-move";
import { legacyKeyboardCoordinates } from "./legacy-keyboard";

// The v2 board and its @dnd-kit/react runtime are only needed when the project
// flag is on; the legacy @dnd-kit/core board stays in the initial chunk.
const KanbanDndBoard = dynamic(
  () => import("@/features/kanban/dnd/KanbanDndBoard").then((mod) => ({ default: mod.KanbanDndBoard })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-w-0 gap-4 h-full items-stretch overflow-x-auto overflow-y-hidden">
        {[1, 2, 3, 4].map((i) => (
          <SkeletonColumn key={i} />
        ))}
      </div>
    ),
  }
);

interface ProjectColumn {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
  workflowKey: string;
  status?: string | null; // Added for backward compatibility with task status
  createdAt: string;
  updatedAt: string;
}

export interface BoardAnnouncementTask {
  id: string;
  title: string;
  columnId?: string | null;
}

export interface BoardDropAnnouncement {
  columnId: string;
  position: number;
  total: number;
}

export interface BoardAnnouncementsInput {
  columns: readonly { id: string; name: string }[];
  tasks: readonly BoardAnnouncementTask[];
  resolveDrop?: (
    active: DragStartEvent["active"],
    over: NonNullable<DragOverEvent["over"]>,
  ) => BoardDropAnnouncement | null;
}

export function createBoardAnnouncements({
  columns,
  tasks,
  resolveDrop,
}: BoardAnnouncementsInput): Announcements {
  const columnName = (id?: string | null) =>
    columns.find((column) => column.id === id)?.name;
  const columnTasks = (columnId?: string | null) =>
    tasks.filter((task) => task.columnId === columnId);
  const activeTask = (active: DragStartEvent["active"]) =>
    active.data.current?.task as BoardAnnouncementTask | undefined;
  const position = (value: number, total: number) =>
    `позиция ${value} из ${total}`;

  return {
    onDragStart({ active }) {
      const task = activeTask(active);
      if (!task) return undefined;
      const name = columnName(task.columnId);
      const list = columnTasks(task.columnId);
      const index = list.findIndex((candidate) => candidate.id === task.id);
      const placement = index >= 0 ? `, ${position(index + 1, list.length)}` : "";
      return name
        ? `Задача «${task.title}» взята из колонки «${name}»${placement}.`
        : `Задача «${task.title}» взята${placement}.`;
    },
    onDragOver({ active, over }) {
      const task = activeTask(active);
      if (!task) return undefined;
      if (!over) return `Задача «${task.title}» вне колонок.`;
      // `over` is a column or another card; the drop plan resolves both.
      const drop = resolveDrop?.(active, over);
      const name = columnName(drop?.columnId ?? String(over.id));
      if (!name) return undefined;
      return drop
        ? `Задача «${task.title}»: колонка «${name}», ${position(drop.position, drop.total)}.`
        : `Задача «${task.title}»: колонка «${name}».`;
    },
    onDragEnd({ active, over }) {
      const task = activeTask(active);
      if (!task) return undefined;
      const drop = over ? resolveDrop?.(active, over) : null;
      const name = columnName(drop?.columnId ?? task.columnId);
      if (drop && name) {
        return `Задача «${task.title}» отпущена в колонке «${name}», ${position(drop.position, drop.total)}.`;
      }
      return name
        ? `Задача «${task.title}» осталась в колонке «${name}».`
        : `Задача «${task.title}» осталась на прежнем месте.`;
    },
    onDragCancel({ active }) {
      const task = activeTask(active);
      if (!task) return undefined;
      const name = columnName(task.columnId);
      return name
        ? `Перемещение задачи «${task.title}» отменено. Задача осталась в колонке «${name}».`
        : `Перемещение задачи «${task.title}» отменено.`;
    },
  };
}

interface KanbanBoardProps {
  claim?: boolean;
  beznal?: boolean;
  projectId: string;
  dndV2Enabled: boolean;
  boardRevision?: number;
  canManage?: boolean;
  allowedCreationColumnIds?: readonly string[] | null;
  canExecuteRequests?: boolean;
  canChangeStatus?: boolean;
  /** Lifecycle boards use canonical card actions instead of arbitrary moves. */
  manualTaskMovesEnabled?: boolean;
  statusFilter?: string | null;
  priorityFilter?: string | null;
  assigneeFilter?: string | null;
  tagsFilter?: string[] | null;
  sortBy?: string;
  onStatusFilterChange?: (value: string | null) => void;
  onPriorityFilterChange?: (value: string | null) => void;
  onAssigneeFilterChange?: (value: string | null) => void;
  onTagsFilterChange?: (value: string[] | null) => void;
  onSortByChange?: (value: string) => void;
}

export function KanbanBoard({
  claim = false,
  beznal = false,
  projectId,
  dndV2Enabled,
  boardRevision = 0,
  canManage = false,
  allowedCreationColumnIds = null,
  canExecuteRequests = false,
  statusFilter: externalStatusFilter,
  priorityFilter: externalPriorityFilter,
  assigneeFilter: externalAssigneeFilter,
  tagsFilter: externalTagsFilter,
  sortBy: externalSortBy,
}: KanbanBoardProps) {
  const canChangeStatus = false; // All status changes use canonical request actions.
  const queryClient = useQueryClient();
  const router = useRouter();
  const openRequest = useRequestDialog();
  const [tasks, setTasks] = useState<TaskType[]>([]);
  const [tasksOwner, setTasksOwner] = useState("");
  const [columns, setColumns] = useState<ProjectColumn[]>([]);
  const [activeTask, setActiveTask] = useState<TaskType | null>(null);
  const [selection, setSelection] = useState<{ scope: string; generation: number; ids: string[] }>({ scope: "", generation: 0, ids: [] });
  const [bulkPending, setBulkPending] = useState<{ scope: string; pending: boolean }>({ scope: "", pending: false });

  // This simplified board has no hidden mutable filter state.
  const statusFilter = externalStatusFilter ?? null;
  const priorityFilter = externalPriorityFilter ?? null;
  const assigneeFilter = externalAssigneeFilter ?? null;
  const tagsFilter = externalTagsFilter ?? null;
  const sortBy = externalSortBy ?? "position";
  const resolvedStatusFilter = useMemo(() => {
    if (!statusFilter || statusFilter === "ALL") {
      return statusFilter;
    }
    return resolveWorkflowColumnFilter(statusFilter, columns);
  }, [columns, statusFilter]);

  const tasksRef = useRef<TaskType[]>([]);
  const announcedTaskIdsRef = useRef(new Set<string>());
  const legacyRectsRef = useRef<Map<string, LegacyRect>>(new Map());
  const legacyMovePendingRef = useRef(false);
  const [legacyPendingTaskId, setLegacyPendingTaskId] = useState<string | null>(null);
  const legacyDragSessionRef = useRef<string | null>(null);
  const [legacyIndicator, setLegacyIndicator] = useState<{ top: number; left: number; width: number } | null>(null);
  const recentlyMovedTaskIds = useRef<Set<string>>(new Set());
  const timeoutIdsRef = useRef<Set<NodeJS.Timeout>>(new Set());
  const [dragAnnouncement, setDragAnnouncement] = useState<string>("");
  const boardHeadingRef = useRef<HTMLHeadingElement>(null);
  const boardViewportRef = useRef<HTMLDivElement>(null);
  const boardRevisionRef = useRef(boardRevision);

  // Real-time board updates via Socket.IO
  const { socket, isJoined } = useProjectBoard({ projectId });
  const { data: session } = useSession();
  const currentUserId =
    session?.user &&
    "id" in session.user &&
    typeof session.user.id === "string"
      ? session.user.id
      : undefined;
  const [unseenSelection, setUnseenSelection] = useState({ scope: "", only: false });
  const queueScope = JSON.stringify([currentUserId, projectId]);
  const unseenOnly = unseenSelection.scope === queueScope && unseenSelection.only;
  const queueCounts = useRequestQueueUnseenCounts();
  useEffect(() => { announcedTaskIdsRef.current.clear(); }, [projectId, currentUserId]);
  const refreshCanonicalBoard = useCallback(
    (confirmedRevision: number) => {
      boardRevisionRef.current = Math.max(
        boardRevisionRef.current,
        confirmedRevision,
      );
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
      ]);
    },
    [projectId, queryClient],
  );

  const { data: serverTasks, isLoading, isFetching: tasksFetching, isError: tasksError, error: taskReadError, refetch: refetchTasks } = useQuery<TaskType[]>({
    queryKey: ["tasks", projectId, currentUserId, unseenOnly],
    placeholderData: (previous, query) => query?.queryKey[1] === projectId && query.queryKey[2] === currentUserId ? previous : undefined,
    queryFn: ({ signal }) =>
      apiFetch<TaskType[]>(
        `/api/tasks?projectId=${projectId}&limit=${TASK_LIST_MAX_LIMIT}${unseenOnly ? "&unseen=1" : ""}`, { signal },
      ),
  });

  // Fetch project columns
  const { data: serverColumns, isLoading: isLoadingColumns, isFetching: columnsFetching, isError: columnsError, refetch: refetchColumns } = useQuery({
    queryKey: ["columns", projectId],
    queryFn: ({ signal }) => apiFetch<ProjectColumn[]>(`/api/projects/${projectId}/columns`, { signal }),
  });

  // Apply filters and sorting to tasks
  const filteredTasks = useMemo(() => {
    if (!tasks || tasksOwner !== queueScope) return [];

    const filtered = tasks.filter((task) => {
      // Status filter
      if (
        resolvedStatusFilter &&
        resolvedStatusFilter !== "ALL" &&
        task.columnId !== resolvedStatusFilter
      ) {
        return false;
      }

      // Priority filter
      if (priorityFilter && priorityFilter !== "ALL" && (priorityFilter === "URGENT" ? !isUrgentRequest(task.priority) : task.priority !== priorityFilter)) return false;

      // Assignee filter - check if any assignee matches
      if (assigneeFilter && assigneeFilter !== "ALL") {
        const hasAssignees = task.assignees && task.assignees.length > 0;
        if (assigneeFilter === "unassigned" && hasAssignees) return false;
        if (assigneeFilter !== "unassigned") {
          const hasMatchingAssignee = task.assignees?.some(a => a.user.id === assigneeFilter);
          if (!hasMatchingAssignee) return false;
        }
      }

      // Tags filter
      if (
        tagsFilter &&
        tagsFilter.length > 0 &&
        !(tagsFilter.length === 1 && tagsFilter[0] === "ALL")
      ) {
        const taskTagIds = task.tags?.map(t => t.tag.id) ?? [];
        const hasAllTags = tagsFilter.every(tagId => taskTagIds.includes(tagId));
        if (!hasAllTags) return false;
      }

      return true;
    });

    return beznal ? [...filtered].sort(compareRequestsByVisibleWork) : sortTasksForDisplay(filtered, sortBy);
  }, [tasks, tasksOwner, queueScope, resolvedStatusFilter, priorityFilter, assigneeFilter, tagsFilter, sortBy, beznal]);

  const reorderEnabled = canChangeStatus && isTaskReorderEnabled({
    sortBy,
    statusFilter: resolvedStatusFilter,
    priorityFilter,
    assigneeFilter,
    tagsFilter,
  });
  const visibleTaskIds = useMemo(
    () => new Set(filteredTasks.map((task) => task.id)),
    [filteredTasks],
  );
  // Screen reader text must describe task and column names, never internal IDs.
  const announcements = useMemo(
    () => createBoardAnnouncements({
      columns,
      tasks: filteredTasks,
      resolveDrop: (active, over) => {
        const taskId = String(active.id);
        const overId = String(over.id);
        const toColumnId = columns.some((column) => column.id === overId)
          ? overId
          : tasksRef.current.find((task) => task.id === overId)?.columnId;
        const rect = active.rect.current.translated;
        if (!toColumnId || !rect) return null;
        const plan = planLegacyMove({
          tasks: tasksRef.current,
          taskId,
          toColumnId,
          centerY: rect.top + rect.height / 2,
          rects: legacyRectsRef.current,
        });
        // A no-op plan still has a current slot; report it instead of dropping
        // the position, so repeated announcements stay identical.
        const destination = (plan?.tasks ?? tasksRef.current)
          .filter((task) => task.columnId === toColumnId)
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
        const index = destination.findIndex((task) => task.id === taskId);
        if (index < 0) return null;
        return {
          columnId: toColumnId,
          position: index + 1,
          total: destination.length,
        };
      },
    }),
    [columns, filteredTasks],
  );
  // A selection belongs to one actor, board and filter context. Derive the safe
  // IDs during render so a changed context can never submit yesterday's choice.
  const selectionScope = JSON.stringify([
    projectId, currentUserId ?? null, resolvedStatusFilter ?? null,
    priorityFilter ?? null, assigneeFilter ?? null, [...(tagsFilter ?? [])].sort(),
    dndV2Enabled,
  ]);
  const selectionGeneration = selection.scope === selectionScope ? selection.generation : selection.generation + 1;
  const selectionToken = `${selectionGeneration}:${selectionScope}`;
  const selectionScopeRef = useRef(selectionToken);
  selectionScopeRef.current = selectionToken;
  const selectableTaskIds = new Set(filteredTasks.filter(task =>
    task.projectId === projectId && !task.id.startsWith("optimistic_") &&
    columns.some(column => column.id === task.columnId),
  ).map(task => task.id));
  const selectedTaskIds = selection.scope === selectionScope
    ? selection.ids.filter(id => selectableTaskIds.has(id))
    : [];
  if (selection.scope !== selectionScope || selectedTaskIds.length !== selection.ids.length) {
    setSelection({ scope: selectionScope, generation: selectionGeneration, ids: selectedTaskIds });
  }
  const selectionPending = bulkPending.scope === selectionToken && bulkPending.pending;
  const handleBulkPendingChange = useCallback((pending: boolean) => {
    if (selectionScopeRef.current === selectionToken) setBulkPending({ scope: selectionToken, pending });
  }, [selectionToken]);
  const isTaskVisibleAfterMove = useCallback(
    (taskId: string, toColumnId: string) => {
      const task = tasksRef.current.find((candidate) => candidate.id === taskId);
      if (!task || !visibleTaskIds.has(taskId)) {
        return false;
      }
      if (!resolvedStatusFilter || resolvedStatusFilter === "ALL") {
        return true;
      }

      return toColumnId === resolvedStatusFilter;
    },
    [resolvedStatusFilter, visibleTaskIds],
  );
  const normalizedBoard = useMemo(() => {
    if (columns.length === 0) {
      return null;
    }

    return normalizeBoard({
      columns: columns.map((column) => ({ ...column })),
      tasks: tasks.filter(task => dndV2Enabled || columns.some(column => column.id === task.columnId)).map((task) => ({
        ...task,
        columnId: task.columnId ?? "",
        version: task.version ?? 0,
      })),
    });
  }, [columns, dndV2Enabled, tasks]);

  useEffect(() => {
    if (serverTasks && !legacyMovePendingRef.current) {
      setTasks(serverTasks);
      setTasksOwner(queueScope);
    }
  }, [serverTasks, queueScope]);

  useEffect(() => {
    if (serverColumns) {
      setColumns(serverColumns);
    }
  }, [serverColumns]);

  useEffect(() => {
    boardRevisionRef.current = Math.max(
      boardRevisionRef.current,
      boardRevision,
    );
  }, [boardRevision]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // Cleanup all timeouts on unmount
  useEffect(() => {
    const timeoutIds = timeoutIdsRef.current;
    return () => {
      timeoutIds.forEach(clearTimeout);
      timeoutIds.clear();
    };
  }, []);

  // A successful room join cannot replay changes missed while disconnected.
  // Keep this separate from event listeners: column updates reattach listeners,
  // but must not trigger another snapshot fetch.
  //
  // Only the three snapshots the board is rendered from are re-read. Tasks and
  // columns live in local state fed by socket events alone, so a gap leaves them
  // stale with no way to catch up. `project` carries boardRevision, the watermark
  // that makes stale task:moved payloads recognisable after the gap.
  //
  // Members and tags are reference data with a 5 minute staleTime and
  // refetchOnMount, and member changes already arrive as project:members:updated
  // / project:member:deleted (handled in ProjectBoardClient and
  // AssigneeSelector); tags have no socket channel at all, so re-reading them
  // here never made them fresher. Refetching both on every reconnect added two
  // requests per reconnect — and per flaky-network blip — for no visible change.
  useEffect(() => {
    if (!isJoined) return;

    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["columns", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
    ]);
  }, [isJoined, projectId, queryClient]);

  // Browser suspension can lose events without closing the socket. Reconcile
  // on return, coalescing visibility/focus into one bounded canonical refresh.
  useEffect(() => {
    if (!isJoined) return;
    let lastRefresh = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const reconcile = () => {
      if (document.visibilityState !== "visible" || pending || Date.now() - lastRefresh < 5000) return;
      pending = setTimeout(() => {
        pending = undefined;
        if (document.visibilityState !== "visible") return;
        lastRefresh = Date.now();
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["tasks", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["columns", projectId] }),
          queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        ]);
      }, 100);
    };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      clearTimeout(pending);
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("focus", reconcile);
    };
  }, [isJoined, projectId, queryClient]);

  // Real-time board updates: listen to socket events
  useEffect(() => {
    if (!socket || !isJoined) return;

    const onTaskCreated = (task: TaskType) => {
      if (task.projectId !== projectId) return;
      if (!isTaskVisibleInRequestList(task)) {
        // Creation can race the request marker. An incomplete snapshot must not
        // turn an author's private DRAFT into a temporary ordinary list row.
        if (task.request?.state === "DRAFT") setTasks(prev => prev.filter(row => row.id !== task.id));
        void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
        return;
      }

      setTasks((prev) => {
        // Avoid duplicates by ID
        if (prev.some((t) => t.id === task.id)) return prev;

        // Also check for optimistic tasks that might be replaced
        // Skip if we have an optimistic task with the same title (being created right now)
        const hasOptimisticWithSameTitle = prev.some(
          (t) => t.id.startsWith('optimistic_') && t.title === task.title
        );
        if (hasOptimisticWithSameTitle) return prev;

        return [...prev, task];
      });

      // Only show toast if the task was created by another user
      if (task.createdById && currentUserId && task.createdById !== currentUserId && task.request?.state !== "DRAFT" && !announcedTaskIdsRef.current.has(task.id)) {
        announcedTaskIdsRef.current.add(task.id);
        // Column names are localized; only workflowKey identifies a status.
        // Legacy columns without a key simply yield no name instead of crashing.
        const column = task.status
          ? columns.find(
              (c) =>
                c.workflowKey === task.status ||
                derivedTaskStatus(c.workflowKey) === task.status,
            )
          : undefined;
        toast.success("Добавлена новая задача", {
          description: `"${task.title}" добавлена другим пользователем${column ? ` в ${column.name}` : ''}`,
        });
      }
    };

    const onTaskUpdated = (task: TaskType) => {
      if (task.projectId !== projectId) return;
      if (!isTaskVisibleInRequestList(task)) {
        if (task.request?.state === "DRAFT") setTasks(prev => prev.filter(row => row.id !== task.id));
        void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
        return;
      }

      // Skip updates for tasks that are currently being moved to prevent race conditions
      if (recentlyMovedTaskIds.current.has(task.id)) return;

      if (task.request?.state === "SUBMITTED" && !tasksRef.current.some(candidate => candidate.id === task.id)
        && task.createdById && currentUserId && task.createdById !== currentUserId && !announcedTaskIdsRef.current.has(task.id)) {
        announcedTaskIdsRef.current.add(task.id);
        toast.success("Новая заявка в очереди", { description: "Откройте обращение, чтобы взять его в работу." });
      }

      setTasks((prev) => {
        const index = prev.findIndex((t) => t.id === task.id);
          // The private draft's task:created event was correctly hidden from
          // executors. Its committed submit arrives as task:updated, which is
          // their first authorized snapshot and must enter the board now.
        if (index === -1) return [...prev, task];
        if (
          !shouldApplyTaskVersionSnapshot({
            currentTaskVersion: prev[index].version,
            incomingTaskVersion: task.version,
          })
        ) {
          return prev;
        }
        const next = [...prev];
        next[index] = task;
        return next;
      });
      // Keep the query snapshot authoritative too; another invalidation must
      // not restore the pre-submit list after the local update above.
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    };

    const onTaskMoved = (move: TaskMovedEventPayload) => {
      const currentTask = tasksRef.current.find(
        (task) => task.id === move.task.id,
      );
      if (!currentTask) {
        return;
      }

      requestCanonicalTaskMovedRefresh({
        currentTaskVersion: currentTask.version ?? 0,
        currentBoardRevision: boardRevisionRef.current,
        move,
        onRefresh: refreshCanonicalBoard,
      });
    };

    const onTaskDeleted = (payload: { projectId: string; taskId: string; deletedById?: string }) => {
      if (payload.projectId !== projectId) return;

      setTasks((prev) => prev.filter((t) => t.id !== payload.taskId));

      // Only show toast if deleted by another user
      if (payload.deletedById && currentUserId && payload.deletedById === currentUserId) {
        // Current user deleted the task - no toast needed, action was intentional
        return;
      }

      toast.info("Задача удалена", {
        description: "Задача была удалена другим пользователем",
      });
    };

    const onColumnCreated = (column: ProjectColumn & { createdById?: string }) => {
      if (column.projectId !== projectId) return;

      setColumns((prev) => {
        if (prev.some((c) => c.id === column.id)) return prev;
        return [...prev, column].sort((a, b) => a.position - b.position);
      });

      // Only show toast if created by another user
      if (column.createdById && currentUserId && column.createdById === currentUserId) {
        // Current user created the column - no toast needed
        return;
      }

      toast.success("Добавлена новая колонка", {
        description: `"${column.name}" добавлена другим пользователем`,
      });
    };

    const onColumnUpdated = (column: ProjectColumn & { updatedById?: string }) => {
      if (column.projectId !== projectId) return;

      setColumns((prev) => {
        const index = prev.findIndex((c) => c.id === column.id);
        if (index === -1) return prev;

        const next = [...prev];
        next[index] = column;
        return next;
      });

      // Only show toast if updated by another user
      if (column.updatedById && currentUserId && column.updatedById === currentUserId) {
        // Current user updated the column - no toast needed
        return;
      }

      toast.info("Колонка обновлена", {
        description: `"${column.name}" обновлена другим пользователем`,
      });
    };

    const onColumnDeleted = (payload: { projectId: string; columnId: string; userId?: string }) => {
      if (payload.projectId !== projectId) return;

      setColumns((prev) => prev.filter((c) => c.id !== payload.columnId));

      // Only show toast if deleted by another user
      if (payload.userId && currentUserId && payload.userId === currentUserId) {
        // Current user deleted the column - no toast needed, action was intentional
        return;
      }

      toast.info("Колонка удалена", {
        description: "Колонка была удалена другим пользователем",
      });
    };

    const onColumnsReordered = (updatedColumns: ProjectColumn[]) => {
      if (updatedColumns.length === 0 || updatedColumns[0].projectId !== projectId) return;

      setColumns(updatedColumns);

      toast.info("Порядок колонок изменен", {
        description: "Колонки были переупорядочены другим пользователем",
      });
    };

    const onMessageNew = () => {
      // Invalidate tasks query to refresh unread counts
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    };

    const onMessageRead = () => {
      // Invalidate tasks query to refresh unread counts when messages are read
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    };

    socket.on("task:created", onTaskCreated);
    socket.on("task:updated", onTaskUpdated);
    socket.on("task:moved", onTaskMoved);
    socket.on("task:deleted", onTaskDeleted);
    socket.on("column:created", onColumnCreated);
    socket.on("column:updated", onColumnUpdated);
    socket.on("column:deleted", onColumnDeleted);
    socket.on("columns:reordered", onColumnsReordered);
    socket.on("message:new", onMessageNew);
    socket.on("message:read", onMessageRead);

    return () => {
      socket.off("task:created", onTaskCreated);
      socket.off("task:updated", onTaskUpdated);
      socket.off("task:moved", onTaskMoved);
      socket.off("task:deleted", onTaskDeleted);
      socket.off("column:created", onColumnCreated);
      socket.off("column:updated", onColumnUpdated);
      socket.off("column:deleted", onColumnDeleted);
      socket.off("columns:reordered", onColumnsReordered);
      socket.off("message:new", onMessageNew);
      socket.off("message:read", onMessageRead);
    };
  }, [
    socket,
    isJoined,
    projectId,
    columns,
    queryClient,
    currentUserId,
    refreshCanonicalBoard,
    session?.user,
  ]);

  const createTaskMutation = useMutation({
    mutationFn: (input: { title: string; columnId: string }) =>
      apiPost<TaskType>("/api/tasks", {
        title: input.title,
        columnId: input.columnId,
        projectId,
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });

  const createColumnMutation = useMutation({
    mutationFn: (data: { name: string; color: string }) =>
      apiPost<ProjectColumn>(`/api/projects/${projectId}/columns`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["columns", projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      toast.success("Колонка создана", {
        description: "Новая колонка добавлена в проект",
      });
    },
    onError: () => {
      toast.error("Не удалось создать колонку", {
        description: "Попробуйте еще раз",
      });
    },
  });

  const handleAddColumn = () => {
    const name = prompt("Введите название колонки:");
    if (!name || !name.trim()) return;

    const color = prompt("Введите цвет колонки (например, #3b82f6):", "#3b82f6");
    if (!color) return;

    createColumnMutation.mutate({
      name: name.trim(),
      color: color || "#3b82f6",
    });
  };

  const onCreateTask = (input: { title: string; columnId: string }) => {
    if (!input.title.trim()) { router.push(`/projects/${projectId}/board?create=task`); return; }
    if (allowedCreationColumnIds !== null && !allowedCreationColumnIds.includes(input.columnId)) {
      toast.error("Создание заявки в этой колонке недоступно");
      return;
    }
    const optimisticTask: TaskType = {
      id: `optimistic_${Math.random().toString(16).slice(2)}`,
      title: input.title,
      columnId: input.columnId,
      priority: "MEDIUM",
      position: Date.now(),
      projectId,
    };

    setTasks((prev) => [optimisticTask, ...prev]);

    createTaskMutation.mutate(input, {
      onSuccess: (created) => {
        setTasks((prev) => prev.map((t) => (t.id === optimisticTask.id ? created : t)));
        const column = columns.find((c) => c.id === created.columnId);
        toast.success("Задача создана", {
          description: `"${created.title}" добавлена в ${column?.name || 'колонку'}`,
        });
      },
      onError: (error) => {
        setTasks((prev) => prev.filter((t) => t.id !== optimisticTask.id));
        toast.error("Не удалось создать задачу", {
          description: error instanceof Error ? error.message : "Попробуйте еще раз",
        });
      },
    });
  };

  const handleToggleTaskSelect = (taskId: string) => {
    if (selectionPending || !selectableTaskIds.has(taskId)) return;
    setSelection(prev => {
      const ids = prev.scope === selectionScope ? prev.ids.filter(id => selectableTaskIds.has(id)) : [];
      return { scope: selectionScope, generation: selectionGeneration, ids: ids.includes(taskId)
        ? ids.filter(id => id !== taskId) : [...ids, taskId] };
    });
  };

  const handleClearSelection = () => {
    setSelection(prev => prev.scope === selectionScope && prev.generation === selectionGeneration
      ? { scope: selectionScope, generation: selectionGeneration, ids: [] } : prev);
  };

  const handleBulkDelete = async (taskIds: string[]) => {
    const ids = [...new Set(taskIds)].filter(id => selectedTaskIds.includes(id));
    if (ids.length !== taskIds.length || ids.length === 0) throw new Error("Выберите доступные задачи заново");
    const results = await Promise.allSettled(ids.map(async taskId => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Не удалось удалить задачу");
      return taskId;
    }));
    const deletedIds = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    if (selectionScopeRef.current === selectionToken) {
      setTasks(prev => prev.filter(task => !deletedIds.includes(task.id)));
      setSelection(prev => prev.scope === selectionScope && prev.generation === selectionGeneration
        ? { scope: selectionScope, generation: selectionGeneration, ids: prev.ids.filter(id => !deletedIds.includes(id)) } : prev);
    }
    await queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    if (deletedIds.length > 0) {
      toast.success("Задачи удалены", {
        description: `Удалено задач: ${deletedIds.length}`,
      });
    }
    if (deletedIds.length !== ids.length) throw new Error("Часть задач не удалена. Выбор сохранён для повторной попытки");
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: legacyKeyboardCoordinates })
  );

  const legacyCollisionDetection: CollisionDetection = ({ droppableRects, collisionRect }) => {
    legacyRectsRef.current = new Map(
      [...droppableRects].map(([id, rect]) => [String(id), rect]),
    );
    const centerX = collisionRect.left + collisionRect.width / 2;
    const centerY = collisionRect.top + collisionRect.height / 2;
    const target = columns.find(column => {
      const rect = droppableRects.get(column.id);
      return rect && centerX >= rect.left && centerX <= rect.left + rect.width
        && centerY >= rect.top && centerY <= rect.top + rect.height;
    });
    return target ? [{ id: target.id }] : [];
  };

  const getLegacyPlan = (event: DragMoveEvent | DragEndEvent) => {
    if (!event.over || legacyMovePendingRef.current || !reorderEnabled
      || legacyDragSessionRef.current !== String(event.active.id)) return null;
    const taskId = String(event.active.id);
    const overId = String(event.over.id);
    const toColumnId = columns.some(column => column.id === overId)
      ? overId : tasksRef.current.find(task => task.id === overId)?.columnId;
    const rect = event.active.rect.current.translated;
    if (!toColumnId || !rect) return null;
    return planLegacyMove({
      tasks: tasksRef.current, taskId, toColumnId,
      centerY: rect.top + rect.height / 2, rects: legacyRectsRef.current,
    });
  };

  const onDragStart = (event: DragStartEvent) => {
    legacyDragSessionRef.current = null;
    if (legacyMovePendingRef.current) return;
    if (!reorderEnabled) {
      const message = "Для изменения порядка сбросьте фильтры и выберите «По позиции»";
      toast.info(message);
      setDragAnnouncement(message);
      return;
    }
    if (event.active.data.current?.type === "Task") {
      legacyDragSessionRef.current = String(event.active.id);
      setActiveTask(event.active.data.current.task);
    }
  };

  // Preview only the insertion slot; source data stays untouched until drop.
  const onDragOver = (event: DragMoveEvent) => {
    const indicator = getLegacyPlan(event)?.indicator;
    const viewport = boardViewportRef.current?.getBoundingClientRect();
    if (!indicator || !viewport) {
      setLegacyIndicator(null);
      return;
    }
    // Droppable rectangles can extend under the sidebar after horizontal
    // scrolling. Clip only the visual cue; keep semantic neighbor selection.
    const left = Math.max(indicator.left, viewport.left);
    const right = Math.min(indicator.left + indicator.width, viewport.right);
    setLegacyIndicator(right > left && indicator.top >= viewport.top && indicator.top + 4 <= viewport.bottom
      ? { ...indicator, left, width: right - left }
      : null);
  };

  const onDragCancel = () => {
    legacyDragSessionRef.current = null;
    setActiveTask(null);
    setLegacyIndicator(null);
  };

  // Pointer, keyboard sensor, and action-menu commands share one persistence path.
  const persistLegacyMove = async (taskId: string, plan: {
    toColumnId: string;
    beforeTaskId: string | null;
    afterTaskId: string | null;
    tasks: TaskType[];
  }) => {
    if (legacyMovePendingRef.current) throw new Error("Дождитесь завершения перемещения");
    const before = tasksRef.current;
    const task = before.find(candidate => candidate.id === taskId);
    if (!task) throw new Error("Задача недоступна");
    legacyMovePendingRef.current = true;
    setLegacyPendingTaskId(taskId);
    recentlyMovedTaskIds.current.add(taskId);
    const column = columns.find(candidate => candidate.id === plan.toColumnId);
    const optimistic = plan.tasks.map(candidate => candidate.id === taskId
      ? { ...candidate, status: column ? derivedTaskStatus(column.workflowKey) : candidate.status }
      : candidate);
    tasksRef.current = optimistic;
    setTasks(optimistic);

      try {
        const result = await apiPost<MoveTaskResponse>(`/api/tasks/${taskId}/move`, {
          toColumnId: plan.toColumnId,
          beforeTaskId: plan.beforeTaskId,
          afterTaskId: plan.afterTaskId,
          expectedVersion: task.version ?? 0,
          operationId: crypto.randomUUID(),
        });
        // Update the ref immediately, so a subsequent drag uses the confirmed version.
        const confirmed = tasksRef.current.map(candidate => candidate.id === taskId
          ? { ...candidate, ...result.task } : candidate);
        tasksRef.current = confirmed;
        setTasks(confirmed);
        boardRevisionRef.current = Math.max(boardRevisionRef.current, result.boardRevision);
        setDragAnnouncement(`Задача перемещена в ${column?.name ?? "другую колонку"}`);
        toast.success("Задача перемещена");
      } catch (error) {
        // Restore only placement fields changed by this move, preserving unrelated updates.
        const originals = new Map(before.map(candidate => [candidate.id, candidate]));
        const rollback = tasksRef.current.map(candidate => {
          const original = originals.get(candidate.id);
          return original ? {
            ...candidate, columnId: original.columnId, position: original.position,
            status: original.status,
          } : candidate;
        });
        tasksRef.current = rollback;
        setTasks(rollback);
        const feedback = getMoveErrorFeedback(error);
        toast.error(feedback.title, { description: feedback.description });
        throw error;
      } finally {
        // Apply the authoritative response explicitly: React Query may reuse an
        // unchanged array that the serverTasks effect skipped while pending.
        try {
          const fresh = await apiFetch<TaskType[]>(
            `/api/tasks?projectId=${projectId}&limit=${TASK_LIST_MAX_LIMIT}`,
          );
          tasksRef.current = fresh;
          setTasks(fresh);
          queryClient.setQueryData(["tasks", projectId], fresh);
        } catch {
          // Keep the confirmed/rolled-back state; normal query retries can recover.
        }
        legacyMovePendingRef.current = false;
        setLegacyPendingTaskId(null);
        recentlyMovedTaskIds.current.delete(taskId);
        void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      }
  };

  const onDragEnd = (event: DragEndEvent) => {
    const plan = getLegacyPlan(event);
    onDragCancel();
    if (plan) {
      // The shared path reports the error and restores/refetches placement.
      void persistLegacyMove(String(event.active.id), plan).catch(() => {});
    }
  };

  const onLegacyMenuMove = async (command: TaskMoveMenuCommand) => {
    if (!canChangeStatus) throw new Error("Изменение статуса недоступно");
    if (legacyMovePendingRef.current) throw new Error("Дождитесь завершения перемещения");
    const task = tasksRef.current.find(candidate => candidate.id === command.taskId);
    if (!task) throw new Error("Задача недоступна");
    if (!reorderEnabled && task.columnId === command.toColumnId) {
      throw new Error("Для изменения порядка сбросьте фильтры и выберите «По позиции»");
    }
    const current = normalizeBoard({
      columns: columns.map(column => ({ ...column })),
      tasks: tasksRef.current.filter(candidate => columns.some(column => column.id === candidate.columnId))
        .map(candidate => ({ ...candidate, columnId: candidate.columnId ?? "", version: candidate.version ?? 0 })),
    });
    const planned = planMove(current, command);
    if (JSON.stringify(current.taskIdsByColumn) === JSON.stringify(planned.nextState.taskIdsByColumn)) return;
    // These are presentation-only legacy positions, as in planLegacyMove;
    // only the existing planner's semantic neighbors are sent to the server.
    const positions = new Map(planned.nextState.taskIdsByColumn[command.toColumnId]
      .map((id, index) => [id, (index + 1) * 1024]));
    const optimisticTasks = tasksRef.current.map(candidate => positions.has(candidate.id)
      ? { ...candidate, columnId: command.toColumnId, position: positions.get(candidate.id)! }
      : candidate);
    await persistLegacyMove(command.taskId, { ...planned.command, tasks: optimisticTasks });
  };

  const readDenied = taskReadError && typeof taskReadError === "object" && "status" in taskReadError && [401, 403, 404].includes(Number(taskReadError.status));
  if (columnsError || tasksError && (tasksOwner !== queueScope || !columns.length || readDenied)) {
    return (
      <div role="alert" className="space-y-3 rounded-xl border p-4">
        <p>Не удалось загрузить {columnsError ? "колонки доски" : "задачи"}</p>
        <button type="button" className="min-h-11 rounded-md border px-4" disabled={tasksFetching || columnsFetching}
          onClick={() => { void Promise.all([refetchTasks(), refetchColumns()]); }}>
          {tasksFetching || columnsFetching ? "Загрузка…" : "Повторить загрузку"}
        </button>
      </div>
    );
  }

  if (isLoading || isLoadingColumns || (serverColumns?.length && !columns.length)) {
    return (
      <>
        <div role="status" aria-live="polite" className="sr-only">
          Загрузка задач...
        </div>
        <div className="flex min-w-0 gap-4 h-full items-stretch overflow-x-auto overflow-y-hidden">
          {[1, 2, 3, 4].map((i) => (
            <SkeletonColumn key={i} />
          ))}
        </div>
      </>
    );
  }

  if (!columns.length) {
    return (
      <div className="space-y-3 rounded-xl border p-4">
        <p role="status">На доске пока нет колонок</p>
        {canManage && <button type="button" onClick={handleAddColumn} className="min-h-11 rounded-md border px-4" disabled={createColumnMutation.isPending}>Добавить колонку</button>}
      </div>
    );
  }

  const addColumnButton = canManage ? (
    <button
      type="button"
      className="flex-shrink-0 w-[280px] h-[100px] flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted bg-card/50 text-muted-foreground transition-all hover:border-primary hover:text-primary hover:bg-primary/5 cursor-pointer"
      onClick={handleAddColumn}
      disabled={createColumnMutation.isPending}
      aria-label="Добавить колонку"
    >
      <Plus className="h-5 w-5" />
      <span className="font-medium">
        {createColumnMutation.isPending ? "Создание..." : "Добавить колонку"}
      </span>
    </button>
  ) : null;

  return (
    <TaskChangesProvider projectId={projectId} enabled><RequestActionsContext.Provider value={canExecuteRequests}><div className="flex h-full min-h-[24rem] min-w-0 flex-col">
      <h2 ref={boardHeadingRef} tabIndex={-1} className="sr-only">
        Канбан-доска
      </h2>

      {/* Live region for screen reader announcements */}
      <div role="status" aria-live="polite" className="sr-only">
        {dragAnnouncement}
      </div>

      <RequestBoardPresentation projectId={projectId} tasks={tasksError ? [] : filteredTasks} readError={tasksError} readPending={tasksFetching} onRetryRead={() => { void refetchTasks(); }} claim={claim} beznal={beznal} unseenOnly={unseenOnly} onUnseenOnlyChange={only => setUnseenSelection({ scope: queueScope, only })} unseenCount={queueCounts.isLoading || queueCounts.isError ? null : queueCounts.byProject[projectId] ?? 0} defaultView={canExecuteRequests ? "board" : "list"} onOpen={(task, opener) => openRequest ? openRequest({ projectId: task.projectId, taskId: task.id }, opener) : router.push(`/projects/${task.projectId}/tasks/${task.id}`, { scroll: false })} />

      {canChangeStatus && <div ref={boardViewportRef} className="min-h-64 min-w-0 flex-1 overflow-hidden">
        {dndV2Enabled && normalizedBoard ? (
          <KanbanDndBoard
            columns={columns}
            snapshot={normalizedBoard}
            snapshotRevision={boardRevisionRef.current}
            reorderEnabled={reorderEnabled}
            sortBy={sortBy}
            visibleTaskIds={visibleTaskIds}
            selectedTaskIds={selectedTaskIds}
            onToggleTaskSelect={handleToggleTaskSelect}
            selectionDisabled={selectionPending}
            onCreateTask={onCreateTask}
            allowedCreationColumnIds={allowedCreationColumnIds}
            canChangeStatus={canChangeStatus}
            onOpenTask={(task) =>
              router.push(`/projects/${task.projectId}/tasks/${task.id}`)
            }
            onMoveError={(error) => {
              const feedback = getMoveErrorFeedback(error);
              toast.error(feedback.title, {
                description: feedback.description,
              });
              void queryClient.invalidateQueries({
                queryKey: ["tasks", projectId],
              });
            }}
            onMoveConfirmed={(response) => {
              refreshCanonicalBoard(response.boardRevision);
            }}
            isTaskVisibleAfterMove={isTaskVisibleAfterMove}
            boardHeadingRef={boardHeadingRef}
            onMoveAnnounce={setDragAnnouncement}
            afterColumns={addColumnButton}
          />
        ) : normalizedBoard ? (
          <TaskMoveMenuProvider value={{
            canMove: canChangeStatus,
            state: normalizedBoard,
            columns: columns.map(column => ({ id: column.id, name: column.name })),
            pendingTaskIds: new Set(legacyPendingTaskId ? [legacyPendingTaskId] : []),
            positionMovesEnabled: reorderEnabled,
            moveTask: onLegacyMenuMove,
            isTaskVisibleAfterMove,
            boardHeadingRef,
            onAnnounce: setDragAnnouncement,
          }}>
          <DndContext
            sensors={sensors}
            accessibility={{ announcements }}
            collisionDetection={legacyCollisionDetection}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragMove={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <div role="region" aria-label="Колонки канбан-доски" tabIndex={0} className="flex h-full min-w-0 gap-4 items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <AnimatePresence mode="popLayout">
                {columns.map((col, index) => (
                  <motion.div
                    key={col.id}
                    initial={false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1, duration: 0.3 }}
                    className="h-full shrink-0"
                  >
                    <KanbanColumn
                      id={col.id}
                      title={col.name}
                      color={col.color}
                      tasks={filteredTasks.filter((task) => task.columnId === col.id)}
                      onCreateTask={onCreateTask}
                      canCreate={allowedCreationColumnIds === null || allowedCreationColumnIds.includes(col.id)}
                      canChangeStatus={canChangeStatus}
                      selectedTaskIds={selectedTaskIds}
                      onToggleTaskSelect={handleToggleTaskSelect}
                      selectionDisabled={selectionPending}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
              {addColumnButton}
            </div>

            {legacyIndicator && (
              <div
                role="separator"
                aria-label="Место вставки задачи"
                className="fixed pointer-events-none z-[100] h-1 rounded-full bg-primary"
                style={{ top: legacyIndicator.top, left: legacyIndicator.left, width: legacyIndicator.width }}
              />
            )}
            <DragOverlay>
              {activeTask ? (
                <motion.div
                  initial={{ scale: 1, rotate: 0 }}
                  animate={{ scale: 1.05, rotate: 2 }}
                  exit={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 25 }}
                >
                  <KanbanCardView task={activeTask} />
                </motion.div>
              ) : null}
            </DragOverlay>
          </DndContext>
          </TaskMoveMenuProvider>
        ) : null}
      </div>}

      <BulkActionsBar
        key={selectionToken}
        selectedTaskIds={selectedTaskIds}
        projectId={projectId}
        columns={columns}
        canChangeStatus={canChangeStatus}
        onClearSelection={handleClearSelection}
        onDeleteTasks={handleBulkDelete}
        onPendingChange={handleBulkPendingChange}
      />
    </div></RequestActionsContext.Provider></TaskChangesProvider>
  );
}
