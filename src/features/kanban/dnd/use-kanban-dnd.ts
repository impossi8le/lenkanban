"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragDropEventHandlers,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/react";
import { PointerActivationConstraints } from "@dnd-kit/dom";
import { move as moveSortableItems } from "@dnd-kit/helpers";
import type { ActivationConstraints } from "@dnd-kit/abstract";
import { apiPost } from "@/lib/api";
import { planMove } from "@/features/kanban/model/plan-move";
import { TaskMoveQueue } from "@/features/kanban/model/task-move-queue";
import type { KanbanBoardState } from "@/features/kanban/model/types";
import type {
  MoveTaskRequest,
  MoveTaskResponse,
} from "@/features/kanban/server/move-contract";

export interface KanbanMoveClient {
  moveTask(taskId: string, request: MoveTaskRequest): Promise<MoveTaskResponse>;
}

export interface UseKanbanDndOptions {
  snapshot: KanbanBoardState;
  snapshotRevision?: number;
  moveClient?: KanbanMoveClient;
  createOperationId?: () => string;
  onMoveError?: (error: unknown) => void;
  onMoveConfirmed?: (response: MoveTaskResponse) => void;
  onPointerMoveSettled?: (
    settlement: KanbanPointerMoveSettlement,
  ) => void;
}

export type KanbanDndHandlers = Pick<
  DragDropEventHandlers,
  "onDragStart" | "onDragMove" | "onDragOver" | "onDragEnd"
>;

export interface KanbanDndController {
  state: KanbanBoardState;
  activeTaskId: string | null;
  pendingTaskIds: ReadonlySet<string>;
  isDragging: boolean;
  hasPendingMoves: boolean;
  moveTask: (
    command: KanbanSemanticMoveCommand,
  ) => Promise<MoveTaskResponse | null>;
  handlers: KanbanDndHandlers;
}

export interface KanbanSemanticMoveCommand {
  taskId: string;
  toColumnId: string;
  targetIndex: number;
}

export type KanbanPointerMoveSettlement =
  | (KanbanSemanticMoveCommand & {
      status: "unchanged";
      taskTitle: string;
      fromColumnId: string;
    })
  | (KanbanSemanticMoveCommand & {
      status: "confirmed";
      taskTitle: string;
      fromColumnId: string;
      position: number;
      total: number;
      response: MoveTaskResponse;
    })
  | (KanbanSemanticMoveCommand & {
      status: "failed";
      taskTitle: string;
      fromColumnId: string;
      error: unknown;
    });

interface DeferredSnapshot {
  state: KanbanBoardState;
  revision: number;
}

interface ConfirmedMove {
  taskId: string;
  boardRevision: number;
  taskVersion: number;
  toColumnId: string;
  beforeTaskId: string | null;
  afterTaskId: string | null;
  fallbackIndex: number;
}

interface SortableSourceLocation {
  id: string | number;
  initialIndex: number;
  index: number;
  initialGroup: string | number;
  group: string | number;
  type?: string | number | symbol;
}

interface ColumnDropTarget {
  type?: string | number | symbol;
  data?: {
    columnId?: unknown;
  };
}

interface PointerColumnGeometry {
  columnId: string;
  element: HTMLElement;
  scrollElement: HTMLElement;
  cardCenters: Array<{
    taskId: string;
    contentCenterY: number;
  }>;
}

interface PointerDragGeometry {
  columns: PointerColumnGeometry[];
}

export interface TaskReorderPolicyInput {
  sortBy: string;
  statusFilter: string | null;
  priorityFilter: string | null;
  assigneeFilter: string | null;
  tagsFilter: readonly string[] | null;
}

const fetchMoveClient: KanbanMoveClient = {
  moveTask(taskId, request) {
    return apiPost<MoveTaskResponse>(`/api/tasks/${taskId}/move`, request);
  },
};

export function getKanbanPointerActivationConstraints(
  event: PointerEvent,
): ActivationConstraints<PointerEvent> {
  if (event.pointerType === "touch") {
    return [
      new PointerActivationConstraints.Delay({
        value: 250,
        tolerance: 5,
      }),
    ];
  }

  return [
    new PointerActivationConstraints.Distance({
      value: 6,
    }),
  ];
}

export function preventKanbanPointerActivation(event: PointerEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest("[data-kanban-drag-handle]")) {
    return false;
  }

  return Boolean(
    target.closest(
      "button, a, input, textarea, select, option, [contenteditable='true'], [data-no-drag]",
    ),
  );
}

function isAllFilter(value: string | null): boolean {
  return value === null || value === "ALL";
}

export function isTaskReorderEnabled({
  sortBy,
  statusFilter,
  priorityFilter,
  assigneeFilter,
  tagsFilter,
}: TaskReorderPolicyInput): boolean {
  const allTags =
    tagsFilter === null ||
    tagsFilter.length === 0 ||
    (tagsFilter.length === 1 && tagsFilter[0] === "ALL");

  return (
    sortBy === "position" &&
    isAllFilter(statusFilter) &&
    isAllFilter(priorityFilter) &&
    isAllFilter(assigneeFilter) &&
    allTags
  );
}

function isSortableTaskSource(
  source: DragStartEvent["operation"]["source"] | DragEndEvent["operation"]["source"],
): source is NonNullable<typeof source> & SortableSourceLocation {
  return Boolean(
    source &&
      source.type === "task" &&
      typeof (source as Partial<SortableSourceLocation>).initialIndex === "number" &&
      typeof (source as Partial<SortableSourceLocation>).index === "number" &&
      (typeof (source as Partial<SortableSourceLocation>).initialGroup === "string" ||
        typeof (source as Partial<SortableSourceLocation>).initialGroup === "number") &&
      (typeof (source as Partial<SortableSourceLocation>).group === "string" ||
        typeof (source as Partial<SortableSourceLocation>).group === "number"),
  );
}

function columnDropLocation(
  target: DragEndEvent["operation"]["target"],
  state: KanbanBoardState,
): { columnId: string; index: number } | null {
  const columnTarget = target as ColumnDropTarget | null;
  const columnId = columnTarget?.data?.columnId;
  if (
    columnTarget?.type !== "column" ||
    typeof columnId !== "string" ||
    !state.columnOrder.includes(columnId)
  ) {
    return null;
  }

  return {
    columnId,
    index: state.taskIdsByColumn[columnId]?.length ?? 0,
  };
}

function hasSameTaskOrder(
  current: KanbanBoardState,
  next: KanbanBoardState,
): boolean {
  return current.columnOrder.every((columnId) => {
    const currentIds = current.taskIdsByColumn[columnId] ?? [];
    const nextIds = next.taskIdsByColumn[columnId] ?? [];
    return (
      currentIds.length === nextIds.length &&
      currentIds.every((taskId, index) => taskId === nextIds[index])
    );
  });
}

function updateTaskFromResponse(
  state: KanbanBoardState,
  response: MoveTaskResponse,
): KanbanBoardState {
  const current = state.tasksById[response.task.id];
  if (!current || response.task.version < current.version) {
    return state;
  }

  return {
    ...state,
    tasksById: {
      ...state.tasksById,
      [response.task.id]: {
        ...current,
        columnId: response.task.columnId,
        status: response.task.status,
        version: response.task.version,
      },
    },
  };
}

function hasLowerTaskVersion(
  incoming: KanbanBoardState,
  current: KanbanBoardState,
  exceptTaskId?: string,
): boolean {
  return Object.values(incoming.tasksById).some((task) => {
    if (task.id === exceptTaskId) {
      return false;
    }
    const currentTask = current.tasksById[task.id];
    return currentTask ? task.version < currentTask.version : false;
  });
}

function confirmsOrSupersedesMove(
  snapshot: KanbanBoardState,
  confirmed: ConfirmedMove,
): boolean {
  const task = snapshot.tasksById[confirmed.taskId];
  if (!task || task.version < confirmed.taskVersion) {
    return false;
  }
  if (task.version > confirmed.taskVersion) {
    return true;
  }

  const destination = snapshot.taskIdsByColumn[confirmed.toColumnId];
  if (task.columnId !== confirmed.toColumnId || !destination) {
    return false;
  }
  const taskIndex = destination.indexOf(confirmed.taskId);
  if (taskIndex < 0) {
    return false;
  }

  const beforeIndex = confirmed.beforeTaskId
    ? destination.indexOf(confirmed.beforeTaskId)
    : -1;
  const afterIndex = confirmed.afterTaskId
    ? destination.indexOf(confirmed.afterTaskId)
    : -1;

  return (
    (beforeIndex < 0 || beforeIndex < taskIndex) &&
    (afterIndex < 0 || taskIndex < afterIndex)
  );
}

function reconcileDeferredWithConfirmedMove(
  current: KanbanBoardState,
  deferred: KanbanBoardState,
  confirmed: ConfirmedMove,
): KanbanBoardState {
  const confirmedTask = current.tasksById[confirmed.taskId];
  const destinationTaskIds = deferred.taskIdsByColumn[confirmed.toColumnId];
  if (!confirmedTask || !destinationTaskIds) {
    return current;
  }

  const taskIdsByColumn = Object.fromEntries(
    Object.entries(deferred.taskIdsByColumn).map(([columnId, taskIds]) => [
      columnId,
      taskIds.filter((taskId) => taskId !== confirmed.taskId),
    ]),
  ) as Record<string, string[]>;
  const destination = taskIdsByColumn[confirmed.toColumnId];
  const beforeIndex = confirmed.beforeTaskId
    ? destination.indexOf(confirmed.beforeTaskId)
    : -1;
  const afterIndex = confirmed.afterTaskId
    ? destination.indexOf(confirmed.afterTaskId)
    : -1;
  const insertionIndex =
    beforeIndex >= 0
      ? beforeIndex + 1
      : afterIndex >= 0
        ? afterIndex
        : Math.min(Math.max(confirmed.fallbackIndex, 0), destination.length);
  destination.splice(insertionIndex, 0, confirmed.taskId);

  return {
    columnOrder: [...deferred.columnOrder],
    taskIdsByColumn,
    tasksById: {
      ...deferred.tasksById,
      [confirmed.taskId]: confirmedTask,
    },
  };
}

function defaultOperationId(): string {
  return globalThis.crypto.randomUUID();
}

function humanTaskTitle(
  task: KanbanBoardState["tasksById"][string],
): string {
  return typeof task.title === "string" && task.title.trim()
    ? task.title
    : "Без названия";
}

function capturePointerDragGeometry(
  state: KanbanBoardState,
): PointerDragGeometry | null {
  const columnElements = new Map(
    Array.from(document.querySelectorAll<HTMLElement>("[data-column-id]"))
      .map((element) => [element.dataset.columnId, element] as const)
      .filter(
        (entry): entry is readonly [string, HTMLElement] =>
          typeof entry[0] === "string",
      ),
  );
  const columns = state.columnOrder.flatMap((columnId) => {
    const element = columnElements.get(columnId);
    if (!element) {
      return [];
    }
    const scrollElement =
      element.querySelector<HTMLElement>("[data-kanban-column-scroll]") ??
      element;
    const scrollRect = scrollElement.getBoundingClientRect();
    const cardElements = new Map(
      Array.from(
        scrollElement.querySelectorAll<HTMLElement>("[data-task-id]"),
      )
        .map((card) => [card.dataset.taskId, card] as const)
        .filter(
          (entry): entry is readonly [string, HTMLElement] =>
            typeof entry[0] === "string",
        ),
    );
    const cardCenters = (state.taskIdsByColumn[columnId] ?? []).flatMap(
      (taskId) => {
        const card = cardElements.get(taskId);
        if (!card) {
          return [];
        }
        const cardRect = card.getBoundingClientRect();
        return [{
          taskId,
          contentCenterY:
            cardRect.top +
            cardRect.height / 2 -
            scrollRect.top +
            scrollElement.scrollTop,
        }];
      },
    );

    return [{
      columnId,
      element,
      scrollElement,
      cardCenters,
    }];
  });

  return columns.length > 0 ? { columns } : null;
}

function projectPointerMove(
  geometry: PointerDragGeometry,
  taskId: string,
  center: { x: number; y: number },
  previous?: KanbanSemanticMoveCommand | null,
): KanbanSemanticMoveCommand | null {
  let nearest:
    | {
        column: PointerColumnGeometry;
        horizontalDistance: number;
      }
    | undefined;

  for (const column of geometry.columns) {
    const rect = column.element.getBoundingClientRect();
    if (center.y < rect.top - 24 || center.y > rect.bottom + 24) {
      continue;
    }
    const horizontalDistance =
      center.x < rect.left
        ? rect.left - center.x
        : center.x > rect.right
          ? center.x - rect.right
          : 0;
    if (!nearest || horizontalDistance < nearest.horizontalDistance) {
      nearest = { column, horizontalDistance };
    }
  }

  if (!nearest || nearest.horizontalDistance > 24) {
    return null;
  }

  let { column } = nearest;
  if (previous && previous.toColumnId !== column.columnId) {
    const previousColumn = geometry.columns.find(
      (candidate) => candidate.columnId === previous.toColumnId,
    );
    if (previousColumn) {
      const previousRect = previousColumn.element.getBoundingClientRect();
      const remainsNearPreviousColumn =
        center.y >= previousRect.top - 24 &&
        center.y <= previousRect.bottom + 24 &&
        center.x >= previousRect.left - 12 &&
        center.x <= previousRect.right + 12;
      if (remainsNearPreviousColumn) {
        column = previousColumn;
      }
    }
  }
  const scrollRect = column.scrollElement.getBoundingClientRect();
  const contentCenterY =
    center.y - scrollRect.top + column.scrollElement.scrollTop;
  const orderedCenters = column.cardCenters.filter(
    (card) => card.taskId !== taskId,
  );
  let targetIndex = orderedCenters.reduce(
    (index, card) =>
      contentCenterY > card.contentCenterY
        ? index + 1
        : index,
    0,
  );
  if (previous?.toColumnId === column.columnId) {
    const previousIndex = Math.min(
      Math.max(previous.targetIndex, 0),
      orderedCenters.length,
    );
    if (targetIndex > previousIndex) {
      const boundary = orderedCenters[previousIndex]?.contentCenterY;
      if (boundary !== undefined && contentCenterY <= boundary + 6) {
        targetIndex = previousIndex;
      }
    } else if (targetIndex < previousIndex) {
      const boundary = orderedCenters[previousIndex - 1]?.contentCenterY;
      if (boundary !== undefined && contentCenterY >= boundary - 6) {
        targetIndex = previousIndex;
      }
    }
  }

  return {
    taskId,
    toColumnId: column.columnId,
    targetIndex,
  };
}

function projectedDragMoveCenter(
  event: DragMoveEvent,
  manager: Parameters<
    NonNullable<KanbanDndHandlers["onDragMove"]>
  >[1],
): { x: number; y: number } | null {
  const center =
    event.operation.shape?.current.center ??
    manager?.dragOperation?.shape?.current.center;
  const currentPosition =
    event.operation.position?.current ??
    manager?.dragOperation?.position?.current;
  if (!center || !currentPosition) {
    return center ?? null;
  }

  const nextPosition = event.to ?? {
    x: currentPosition.x + (event.by?.x ?? 0),
    y: currentPosition.y + (event.by?.y ?? 0),
  };
  return {
    x: center.x + nextPosition.x - currentPosition.x,
    y: center.y + nextPosition.y - currentPosition.y,
  };
}

export function useKanbanDnd({
  snapshot,
  snapshotRevision = 0,
  moveClient = fetchMoveClient,
  createOperationId = defaultOperationId,
  onMoveError,
  onMoveConfirmed,
  onPointerMoveSettled,
}: UseKanbanDndOptions): KanbanDndController {
  const [state, setState] = useState(snapshot);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [pendingMoves, setPendingMoves] = useState<ReadonlyMap<symbol, string>>(
    () => new Map(),
  );
  const pendingTaskIds = useMemo(
    () => new Set(pendingMoves.values()),
    [pendingMoves],
  );
  const stateRef = useRef(state);
  const activeTaskIdRef = useRef<string | null>(null);
  const pendingMovesRef = useRef(pendingMoves);
  const revisionRef = useRef(snapshotRevision);
  const dragSnapshotRef = useRef<DeferredSnapshot | null>(null);
  const dragPreviewCommandRef = useRef<KanbanSemanticMoveCommand | null>(null);
  const pointerGeometryRef = useRef<PointerDragGeometry | null>(null);
  const deferredSnapshotRef = useRef<DeferredSnapshot | null>(null);
  const confirmedMoveRef = useRef<ConfirmedMove | null>(null);
  const lastSnapshotRef = useRef(snapshot);
  const queueRef = useRef(new TaskMoveQueue());

  const replaceState = useCallback((nextState: KanbanBoardState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const applyDeferredSnapshot = useCallback(() => {
    const deferred = deferredSnapshotRef.current;
    if (!deferred || activeTaskIdRef.current || pendingMovesRef.current.size > 0) {
      return;
    }

    deferredSnapshotRef.current = null;
    const confirmed = confirmedMoveRef.current;
    if (
      hasLowerTaskVersion(
        deferred.state,
        stateRef.current,
        confirmed?.taskId,
      )
    ) {
      return;
    }

    if (confirmed) {
      const incomingConfirmedTask = deferred.state.tasksById[confirmed.taskId];
      const isCanonicalConfirmation = confirmsOrSupersedesMove(
        deferred.state,
        confirmed,
      );
      const confirmsDeletion =
        !incomingConfirmedTask &&
        deferred.revision >= confirmed.boardRevision;

      if (!isCanonicalConfirmation && !confirmsDeletion) {
        revisionRef.current = Math.max(
          revisionRef.current,
          deferred.revision,
        );
        replaceState(
          reconcileDeferredWithConfirmedMove(
            stateRef.current,
            deferred.state,
            confirmed,
          ),
        );
        return;
      }

      if (deferred.revision < revisionRef.current) {
        return;
      }
      confirmedMoveRef.current = null;
    } else if (deferred.revision < revisionRef.current) {
      return;
    }

    revisionRef.current = deferred.revision;
    replaceState(deferred.state);
  }, [replaceState]);

  useEffect(() => {
    if (lastSnapshotRef.current === snapshot) {
      return;
    }
    lastSnapshotRef.current = snapshot;

    if (activeTaskIdRef.current || pendingMovesRef.current.size > 0) {
      deferredSnapshotRef.current = {
        state: snapshot,
        revision: snapshotRevision,
      };
      return;
    }

    if (
      snapshotRevision < revisionRef.current ||
      hasLowerTaskVersion(snapshot, stateRef.current)
    ) {
      return;
    }

    const confirmed = confirmedMoveRef.current;
    if (confirmed) {
      const confirmsDeletion =
        !snapshot.tasksById[confirmed.taskId] &&
        snapshotRevision >= confirmed.boardRevision;
      if (confirmsOrSupersedesMove(snapshot, confirmed) || confirmsDeletion) {
        confirmedMoveRef.current = null;
      } else {
        revisionRef.current = Math.max(
          revisionRef.current,
          snapshotRevision,
        );
        replaceState(
          reconcileDeferredWithConfirmedMove(
            stateRef.current,
            snapshot,
            confirmed,
          ),
        );
        return;
      }
    }

    revisionRef.current = snapshotRevision;
    replaceState(snapshot);
  }, [replaceState, snapshot, snapshotRevision]);

  useEffect(() => {
    applyDeferredSnapshot();
  }, [activeTaskId, applyDeferredSnapshot, pendingTaskIds]);

  const beginPendingMove = useCallback((taskId: string) => {
    // One token per invocation, including moves queued for the same task.
    // Both synchronous snapshot guards and rendered IDs use this registry;
    // there is no separately incremented counter or impure state updater.
    const token = Symbol();
    const next = new Map(pendingMovesRef.current);
    next.set(token, taskId);
    pendingMovesRef.current = next;
    setPendingMoves(next);
    return () => {
      if (!pendingMovesRef.current.has(token)) return;
      const remaining = new Map(pendingMovesRef.current);
      remaining.delete(token);
      pendingMovesRef.current = remaining;
      setPendingMoves(remaining);
    };
  }, []);

  const finishDrag = useCallback(() => {
    pointerGeometryRef.current = null;
    activeTaskIdRef.current = null;
    setActiveTaskId(null);
  }, []);

  const restoreDragSnapshot = useCallback(() => {
    const dragSnapshot = dragSnapshotRef.current;
    dragSnapshotRef.current = null;
    dragPreviewCommandRef.current = null;
    finishDrag();
    if (dragSnapshot) {
      revisionRef.current = dragSnapshot.revision;
      replaceState(dragSnapshot.state);
    }
  }, [finishDrag, replaceState]);

  const planDragMove = useCallback((
    dragSnapshot: DeferredSnapshot,
    command: KanbanSemanticMoveCommand,
  ) => {
    try {
      return planMove(dragSnapshot.state, command);
    } catch (error) {
      restoreDragSnapshot();
      throw error;
    }
  }, [restoreDragSnapshot]);

  const moveTask = useCallback(
    async ({
      taskId,
      toColumnId,
      targetIndex,
    }: KanbanSemanticMoveCommand): Promise<MoveTaskResponse | null> => {
      const moveSnapshot: DeferredSnapshot = {
        state: stateRef.current,
        revision: revisionRef.current,
      };
      const task = moveSnapshot.state.tasksById[taskId];

      try {
        const planned = planMove(moveSnapshot.state, {
          taskId,
          toColumnId,
          targetIndex,
        });
        if (hasSameTaskOrder(moveSnapshot.state, planned.nextState)) {
          return null;
        }

        const request: MoveTaskRequest = {
          ...planned.command,
          operationId: createOperationId(),
          expectedVersion: task.version,
        };

        const finishPendingMove = beginPendingMove(taskId);
        try {
          replaceState(planned.nextState);
          const response = await queueRef.current.enqueue(taskId, () =>
            moveClient.moveTask(taskId, request),
          );
          revisionRef.current = Math.max(
            revisionRef.current,
            response.boardRevision,
          );
          const confirmedState = updateTaskFromResponse(
            stateRef.current,
            response,
          );
          confirmedMoveRef.current = {
            taskId,
            boardRevision: response.boardRevision,
            taskVersion: response.task.version,
            toColumnId: planned.command.toColumnId,
            beforeTaskId: planned.command.beforeTaskId,
            afterTaskId: planned.command.afterTaskId,
            fallbackIndex: targetIndex,
          };
          replaceState(confirmedState);
          onMoveConfirmed?.(response);
          return response;
        } finally {
          finishPendingMove();
        }
      } catch (error) {
        revisionRef.current = moveSnapshot.revision;
        replaceState(moveSnapshot.state);
        onMoveError?.(error);
        throw error;
      }
    },
    [
      createOperationId,
      beginPendingMove,
      moveClient,
      onMoveConfirmed,
      onMoveError,
      replaceState,
    ],
  );

  const onDragStart = useCallback<NonNullable<KanbanDndHandlers["onDragStart"]>>(
    (event, manager) => {
      const source = event.operation.source;
      if (!isSortableTaskSource(source)) {
        return;
      }

      const taskId = String(source.id);
      if (!stateRef.current.tasksById[taskId]) {
        return;
      }

      dragSnapshotRef.current = {
        state: stateRef.current,
        revision: revisionRef.current,
      };
      dragPreviewCommandRef.current = null;
      activeTaskIdRef.current = taskId;
      setActiveTaskId(taskId);
      const activatorEvent =
        event.nativeEvent ?? manager?.dragOperation?.activatorEvent;
      pointerGeometryRef.current =
        activatorEvent &&
        /^(pointer|mouse|touch)/.test(activatorEvent.type)
          ? capturePointerDragGeometry(stateRef.current)
          : null;
    },
    [],
  );

  const onDragMove = useCallback<NonNullable<KanbanDndHandlers["onDragMove"]>>(
    (event: DragMoveEvent, manager) => {
      const geometry = pointerGeometryRef.current;
      const dragSnapshot = dragSnapshotRef.current;
      const source = event.operation.source;
      if (!geometry || !dragSnapshot || !isSortableTaskSource(source)) {
        return;
      }

      const taskId = String(source.id);
      if (!dragSnapshot.state.tasksById[taskId]) {
        return;
      }
      const dragCenter = projectedDragMoveCenter(event, manager);
      if (!dragCenter) {
        return;
      }
      const command = projectPointerMove(
        geometry,
        taskId,
        dragCenter,
        dragPreviewCommandRef.current,
      );
      if (!command) {
        return;
      }

      dragPreviewCommandRef.current = command;
      const planned = planDragMove(dragSnapshot, command);
      if (!hasSameTaskOrder(stateRef.current, planned.nextState)) {
        replaceState(planned.nextState);
      }
    },
    [planDragMove, replaceState],
  );

  const onDragOver = useCallback<NonNullable<KanbanDndHandlers["onDragOver"]>>(
    (event: DragOverEvent, manager) => {
      const source = event.operation.source;
      const dragSnapshot = dragSnapshotRef.current;
      if (
        !dragSnapshot ||
        !isSortableTaskSource(source)
      ) {
        return;
      }

      const taskId = String(source.id);
      const task = dragSnapshot.state.tasksById[taskId];
      if (!task) {
        return;
      }
      const dragCenter =
        event.operation.shape?.current.center ??
        manager?.dragOperation?.shape?.current.center;
      const pointerCommand =
        pointerGeometryRef.current && dragCenter
          ? projectPointerMove(
              pointerGeometryRef.current,
              taskId,
              dragCenter,
              dragPreviewCommandRef.current,
            )
          : null;
      if (!event.operation.target && !pointerCommand) {
        return;
      }
      if (
        !pointerCommand &&
        event.operation.target &&
        String(event.operation.target.id) === taskId &&
        dragPreviewCommandRef.current?.taskId === taskId
      ) {
        return;
      }

      const columnLocation = columnDropLocation(
        event.operation.target,
        dragSnapshot.state,
      );
      const movedTaskIdsByColumn = event.operation.target
        ? moveSortableItems(
            dragSnapshot.state.taskIdsByColumn,
            event,
          )
        : dragSnapshot.state.taskIdsByColumn;
      const helperChanged = dragSnapshot.state.columnOrder.some((columnId) => {
        const currentIds = dragSnapshot.state.taskIdsByColumn[columnId] ?? [];
        const movedIds = movedTaskIdsByColumn[columnId] ?? [];
        return (
          currentIds.length !== movedIds.length ||
          currentIds.some((id, index) => id !== movedIds[index])
        );
      });
      const movedEntry = helperChanged
        ? Object.entries(movedTaskIdsByColumn).find(([, taskIds]) =>
            taskIds.includes(taskId),
          )
        : undefined;
      const movedIndex = movedEntry?.[1].indexOf(taskId) ?? -1;
      const command = pointerCommand ??
        (movedEntry && movedIndex >= 0
          ? {
              taskId,
              toColumnId: movedEntry[0],
              targetIndex: movedIndex,
            }
          : {
              taskId,
              toColumnId: columnLocation?.columnId ?? String(source.group),
              targetIndex: columnLocation?.index ?? source.index,
            });
      dragPreviewCommandRef.current = command;
      const planned = planDragMove(dragSnapshot, command);
      if (!hasSameTaskOrder(stateRef.current, planned.nextState)) {
        replaceState(planned.nextState);
      }
    },
    [planDragMove, replaceState],
  );

  const onDragEnd = useCallback<NonNullable<KanbanDndHandlers["onDragEnd"]>>(
    (event, manager) => {
      const source = event.operation.source;
      const dragSnapshot = dragSnapshotRef.current;
      const sortableSource = isSortableTaskSource(source) ? source : null;
      const taskId = sortableSource ? String(sortableSource.id) : null;
      const task = dragSnapshot && taskId
        ? dragSnapshot.state.tasksById[taskId]
        : null;
      const initialGroup = task?.columnId
        ?? (sortableSource ? String(sortableSource.initialGroup) : null);
      const dragCenter =
        event.operation.shape?.current.center ??
        manager?.dragOperation?.shape?.current.center;
      const projectedDrop =
        pointerGeometryRef.current && taskId && dragCenter
          ? projectPointerMove(
              pointerGeometryRef.current,
              taskId,
              dragCenter,
              dragPreviewCommandRef.current,
            )
          : null;
      const hasValidDropLocation = pointerGeometryRef.current && dragCenter
        ? projectedDrop !== null
        : event.operation.target !== null;

      if (
        event.canceled ||
        !hasValidDropLocation ||
        !dragSnapshot ||
        !sortableSource ||
        !taskId ||
        !task ||
        !initialGroup
      ) {
        restoreDragSnapshot();
        return;
      }

      const columnLocation = columnDropLocation(
        event.operation.target,
        dragSnapshot.state,
      );
      const group = columnLocation?.columnId ?? String(sortableSource.group);
      const targetIndex = columnLocation?.index ?? sortableSource.index;

      const latestPreview = dragPreviewCommandRef.current;
      dragPreviewCommandRef.current = null;
      const command =
        projectedDrop ??
        (latestPreview?.taskId === taskId
          ? latestPreview
          : {
              taskId,
              toColumnId: group,
              targetIndex,
            });
      const planned = planDragMove(dragSnapshot, command);
      if (hasSameTaskOrder(dragSnapshot.state, planned.nextState)) {
        restoreDragSnapshot();
        onPointerMoveSettled?.({
          ...command,
          status: "unchanged",
          taskTitle: humanTaskTitle(task),
          fromColumnId: initialGroup,
        });
        return;
      }

      dragSnapshotRef.current = null;
      finishDrag();
      stateRef.current = dragSnapshot.state;
      revisionRef.current = dragSnapshot.revision;
      void moveTask(command)
        .then((response) => {
          if (!response) {
            return;
          }
          const destination =
            stateRef.current.taskIdsByColumn[command.toColumnId] ?? [];
          const confirmedIndex = destination.indexOf(command.taskId);
          onPointerMoveSettled?.({
            ...command,
            status: "confirmed",
            taskTitle: humanTaskTitle(task),
            fromColumnId: initialGroup,
            position:
              (confirmedIndex >= 0 ? confirmedIndex : command.targetIndex) + 1,
            total: destination.length,
            response,
          });
        })
        .catch((error: unknown) => {
          onPointerMoveSettled?.({
            ...command,
            status: "failed",
            taskTitle: humanTaskTitle(task),
            fromColumnId: initialGroup,
            error,
          });
        });
    },
    [
      finishDrag,
      moveTask,
      onPointerMoveSettled,
      planDragMove,
      restoreDragSnapshot,
    ],
  );

  const handlers = useMemo<KanbanDndHandlers>(
    () => ({ onDragStart, onDragMove, onDragOver, onDragEnd }),
    [onDragEnd, onDragMove, onDragOver, onDragStart],
  );

  return {
    state,
    activeTaskId,
    pendingTaskIds,
    isDragging: activeTaskId !== null,
    hasPendingMoves: pendingTaskIds.size > 0,
    moveTask,
    handlers,
  };
}
