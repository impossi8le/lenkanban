"use client";

import {
  DragDropProvider,
  DragOverlay,
} from "@dnd-kit/react";
import {
  Accessibility,
  type DragDropManager,
  KeyboardSensor,
  PointerSensor,
} from "@dnd-kit/dom";
import type { Plugins } from "@dnd-kit/abstract";
import { useCallback, useState, type ReactNode } from "react";
import type { TaskType } from "@/components/kanban/Card";
import { KanbanDndColumn } from "@/components/kanban/Column";
import {
  announceMove,
  announceMoveError,
  announceMoveUnchanged,
} from "@/features/kanban/accessibility/move-announcements";
import type { KanbanBoardState } from "@/features/kanban/model/types";
import {
  isAlternateTaskDisplaySort,
  sortTasksForDisplay,
} from "@/features/kanban/model/task-display-sort";
import type { MoveTaskResponse } from "@/features/kanban/server/move-contract";
import { TaskMoveMenuProvider } from "@/features/kanban/components/TaskMoveMenu";
import { KanbanCardOverlay } from "./KanbanCardOverlay";
import {
  getKanbanPointerActivationConstraints,
  preventKanbanPointerActivation,
  type KanbanMoveClient,
  useKanbanDnd,
} from "./use-kanban-dnd";

export interface KanbanDndBoardColumn {
  id: string;
  name: string;
  color: string;
}

export interface KanbanDndBoardProps {
  columns: readonly KanbanDndBoardColumn[];
  snapshot: KanbanBoardState;
  snapshotRevision: number;
  reorderEnabled: boolean;
  sortBy?: string;
  visibleTaskIds?: ReadonlySet<string>;
  selectedTaskIds?: readonly string[];
  onToggleTaskSelect?: (taskId: string) => void;
  selectionDisabled?: boolean;
  moveClient?: KanbanMoveClient;
  onCreateTask: (input: { title: string; columnId: string }) => void;
  allowedCreationColumnIds?: readonly string[] | null;
  canChangeStatus?: boolean;
  onOpenTask: (task: TaskType) => void;
  onMoveError?: (error: unknown) => void;
  onMoveConfirmed?: (response: MoveTaskResponse) => void;
  isTaskVisibleAfterMove?: (taskId: string, toColumnId: string) => boolean;
  boardHeadingRef?: React.RefObject<HTMLElement | null>;
  onMoveAnnounce?: (message: string) => void;
  afterColumns?: ReactNode;
}

const taskSensors = [
  PointerSensor.configure({
    activationConstraints: getKanbanPointerActivationConstraints,
    preventActivation: (event) => preventKanbanPointerActivation(event),
  }),
  KeyboardSensor,
];

type KanbanAccessibilityOptions = NonNullable<
  ConstructorParameters<typeof Accessibility>[1]
>;

const announcedDragPositions = new WeakMap<DragDropManager, { columnId: unknown; position: number } | null>();

const kanbanAccessibilityOptions: KanbanAccessibilityOptions = {
  debounce: 0,
  screenReaderInstructions: {
    draggable:
      "Чтобы взять задачу, нажмите пробел или Enter. Используйте стрелки, чтобы изменить колонку или позицию. Нажмите пробел или Enter, чтобы разместить задачу, либо Escape, чтобы отменить перемещение.",
  },
  announcements: {
    dragstart({ operation: { source } }, manager) {
      announcedDragPositions.delete(manager);
      if (!source) {
        return undefined;
      }
      announcedDragPositions.set(manager, { columnId: entityData(source).columnId, position: sortablePosition(source, true) });
      return `Поднята задача «${taskTitle(source)}» из колонки «${columnTitle(source)}», позиция ${sortablePosition(source, true)}.`;
    },
    dragover({ operation: { source, target } }, manager) {
      if (!source) {
        return undefined;
      }
      const activatorType = manager.dragOperation.activatorEvent?.type ?? "";
      if (/^(pointer|mouse|touch)/.test(activatorType)) {
        return undefined;
      }
      if (!target) {
        if (announcedDragPositions.has(manager) && announcedDragPositions.get(manager) === null) return undefined;
        announcedDragPositions.set(manager, null);
        return `Задача «${taskTitle(source)}» находится вне колонок. Исходная колонка «${columnTitle(source)}», позиция ${sortablePosition(source)}.`;
      }
      const destination = { columnId: entityData(target).columnId, position: dropPosition(source, target) };
      const previous = announcedDragPositions.get(manager);
      // Collision detection can report the starting destination immediately after
      // activation. Keep the lift instruction until the semantic position changes.
      if (previous && previous.columnId === destination.columnId && previous.position === destination.position) return undefined;
      announcedDragPositions.set(manager, destination);
      return `Текущая позиция задачи «${taskTitle(source)}» — колонка «${columnTitle(target)}», позиция ${dropPosition(source, target)}.`;
    },
    dragend({ operation: { source }, canceled }, manager) {
      announcedDragPositions.delete(manager);
      if (!source) {
        return undefined;
      }
      if (canceled) {
        return `Перемещение задачи «${taskTitle(source)}» отменено. Задача возвращена на исходную позицию.`;
      }
      return `Перемещение задачи «${taskTitle(source)}» обрабатывается.`;
    },
  },
};

const configuredKanbanAccessibility = Accessibility.configure(
  kanbanAccessibilityOptions,
);

export function kanbanAccessibilityPlugins(
  defaults: Plugins<DragDropManager>,
): Plugins<DragDropManager> {
  return [...defaults, configuredKanbanAccessibility];
}

export function KanbanDndBoard({
  columns,
  snapshot,
  snapshotRevision,
  reorderEnabled,
  sortBy = "position",
  visibleTaskIds,
  selectedTaskIds,
  onToggleTaskSelect,
  selectionDisabled,
  moveClient,
  onCreateTask,
  allowedCreationColumnIds = null,
  canChangeStatus = true,
  onOpenTask,
  onMoveError,
  onMoveConfirmed,
  isTaskVisibleAfterMove,
  boardHeadingRef,
  onMoveAnnounce,
  afterColumns,
}: KanbanDndBoardProps): React.ReactElement {
  const [localMoveAnnouncement, setLocalMoveAnnouncement] = useState("");
  const publishMoveAnnouncement = useCallback(
    (message: string) => {
      if (onMoveAnnounce) {
        onMoveAnnounce(message);
      } else {
        setLocalMoveAnnouncement(message);
      }
    },
    [onMoveAnnounce],
  );
  const columnsById = new Map(columns.map((column) => [column.id, column]));
  const controller = useKanbanDnd({
    snapshot,
    snapshotRevision,
    moveClient,
    onMoveError,
    onMoveConfirmed,
    onPointerMoveSettled: (settlement) => {
      if (settlement.status === "unchanged") {
        publishMoveAnnouncement(
          announceMoveUnchanged(settlement.taskTitle),
        );
        restoreDragHandleFocus(settlement.taskId);
        return;
      }
      if (settlement.status === "failed") {
        publishMoveAnnouncement(
          announceMoveError(settlement.taskTitle, settlement.error),
        );
        restoreDragHandleFocus(settlement.taskId);
        return;
      }

      const fromColumn =
        columnsById.get(settlement.fromColumnId)?.name ?? "Без названия";
      const toColumn =
        columnsById.get(settlement.toColumnId)?.name ?? "Без названия";
      publishMoveAnnouncement(
        announceMove({
          title: settlement.taskTitle,
          fromColumn,
          toColumn,
          position: settlement.position,
          total: settlement.total,
        }),
      );
    },
  });
  const activeTask = controller.activeTaskId
    ? toTaskType(controller.state.tasksById[controller.activeTaskId])
    : null;
  const hasAlternateSort = isAlternateTaskDisplaySort(sortBy);
  const positionMovesEnabled = reorderEnabled && !hasAlternateSort;
  const canReorder = canChangeStatus && positionMovesEnabled && !controller.hasPendingMoves;

  return (
    <TaskMoveMenuProvider
      value={{
        canMove: canChangeStatus,
        state: controller.state,
        columns,
        pendingTaskIds: controller.pendingTaskIds,
        positionMovesEnabled,
        moveTask: controller.moveTask,
        isTaskVisibleAfterMove,
        boardHeadingRef,
        onAnnounce: publishMoveAnnouncement,
      }}
    >
      <DragDropProvider
        sensors={taskSensors}
        plugins={kanbanAccessibilityPlugins}
        onDragStart={(event, manager) => {
          if (positionMovesEnabled) {
            controller.handlers.onDragStart?.(event, manager);
          }
        }}
        onDragMove={(event, manager) => {
          if (positionMovesEnabled) {
            controller.handlers.onDragMove?.(event, manager);
          }
        }}
        onDragOver={(event, manager) => {
          if (positionMovesEnabled) {
            controller.handlers.onDragOver?.(event, manager);
          }
        }}
        onDragEnd={(event, manager) => {
          // A sort/filter can change during a drag. Cancel its preview instead
          // of persisting neighbors inferred from a presentation-only order.
          controller.handlers.onDragEnd?.(
            positionMovesEnabled ? event : { ...event, operation: event.operation, canceled: true },
            manager,
          );
        }}
      >
        <div
          role="region"
          aria-label="Колонки канбан-доски, горизонтальная прокрутка"
          tabIndex={0}
          className="flex min-w-0 min-h-0 gap-4 items-stretch h-full overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {controller.state.columnOrder.map((columnId) => {
            const column = columnsById.get(columnId);
            if (!column) {
              return null;
            }
            const tasks = controller.state.taskIdsByColumn[columnId]
              .filter((taskId) => !visibleTaskIds || visibleTaskIds.has(taskId))
              .map((taskId) => toTaskType(controller.state.tasksById[taskId]))
              .filter((task): task is TaskType => task !== null);
            // Keep controller order for position/unknown modes: scalar
            // positions may lag behind optimistic semantic moves.
            const displayedTasks = hasAlternateSort
              ? sortTasksForDisplay(tasks, sortBy)
              : tasks;

            return (
              <KanbanDndColumn
                key={columnId}
                id={columnId}
                title={column.name}
                color={column.color}
                tasks={displayedTasks}
                reorderEnabled={canReorder}
                pendingTaskIds={controller.pendingTaskIds}
                selectedTaskIds={selectedTaskIds}
                onToggleTaskSelect={onToggleTaskSelect}
                selectionDisabled={selectionDisabled}
                onCreateTask={onCreateTask}
                canCreate={allowedCreationColumnIds === null || allowedCreationColumnIds.includes(columnId)}
                onOpenTask={onOpenTask}
              />
            );
          })}
          {afterColumns}
        </div>

        <DragOverlay>
          {activeTask ? <KanbanCardOverlay task={activeTask} /> : null}
        </DragOverlay>
        {!onMoveAnnounce ? (
          <span role="status" aria-live="polite" className="sr-only">
            {localMoveAnnouncement}
          </span>
        ) : null}
      </DragDropProvider>
    </TaskMoveMenuProvider>
  );
}

function restoreDragHandleFocus(taskId: string): void {
  requestAnimationFrame(() => {
    for (const card of document.querySelectorAll<HTMLElement>("[data-task-id]")) {
      if (card.dataset.taskId !== taskId) {
        continue;
      }
      card
        .querySelector<HTMLButtonElement>("[data-kanban-drag-handle]")
        ?.focus();
      return;
    }
  });
}

function taskTitle(entity: unknown): string {
  const title = entityData(entity).taskTitle;
  return typeof title === "string" && title.trim() ? title : "Без названия";
}

function columnTitle(entity: unknown): string {
  const title = entityData(entity).columnTitle;
  return typeof title === "string" && title.trim() ? title : "Без названия";
}

function entityData(entity: unknown): Record<string, unknown> {
  if (!entity || typeof entity !== "object" || !("data" in entity)) {
    return {};
  }
  const data = (entity as { data?: unknown }).data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

function sortablePosition(entity: unknown, initial = false): number {
  if (!entity || typeof entity !== "object") {
    return 1;
  }
  const sortable = entity as { initialIndex?: unknown; index?: unknown };
  const index = initial ? sortable.initialIndex : sortable.index;
  const fallbackIndex = initial ? sortable.index : sortable.initialIndex;
  const resolved =
    typeof index === "number"
      ? index
      : typeof fallbackIndex === "number"
        ? fallbackIndex
        : 0;
  return Math.max(0, resolved) + 1;
}

function dropPosition(source: unknown, target: unknown): number {
  if (
    target &&
    typeof target === "object" &&
    "type" in target &&
    (target as { type?: unknown }).type === "column"
  ) {
    const taskCount = entityData(target).taskCount;
    if (typeof taskCount !== "number" || !Number.isFinite(taskCount)) {
      return 1;
    }
    const sourceColumnId = entityData(source).columnId;
    const targetColumnId = entityData(target).columnId;
    const activeTaskIsAlreadyCounted =
      typeof sourceColumnId === "string" &&
      sourceColumnId === targetColumnId;
    const destinationCount = Math.max(
      0,
      Math.trunc(taskCount) - (activeTaskIsAlreadyCounted ? 1 : 0),
    );
    return destinationCount + 1;
  }
  return sortablePosition(source);
}

function toTaskType(
  record: KanbanBoardState["tasksById"][string] | undefined,
): TaskType | null {
  return record ? (record as TaskType) : null;
}
