"use client";

import { useSortable } from "@dnd-kit/react/sortable";
import { OptimisticSortingPlugin } from "@dnd-kit/dom/sortable";
import type { DragDropManager } from "@dnd-kit/dom";
import type { Plugins } from "@dnd-kit/abstract";
import { useId } from "react";
import type React from "react";
import {
  KanbanCardView,
  type TaskType,
} from "@/components/kanban/Card";

export interface SortableKanbanCardProps {
  task: TaskType;
  index: number;
  columnId: string;
  columnTitle: string;
  reorderEnabled: boolean;
  isPending?: boolean;
  isSelected?: boolean;
  onTaskSelect?: () => void;
  selectionDisabled?: boolean;
  onOpen?: () => void;
}

type DragHandleProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>;
  "data-kanban-drag-handle"?: string;
};

const kanbanSortablePlugins = (
  defaults: Plugins<DragDropManager>,
): Plugins<DragDropManager> =>
  defaults.filter((plugin) => plugin !== OptimisticSortingPlugin);

export function SortableKanbanCard(props: SortableKanbanCardProps): React.ReactElement {
  if (!props.reorderEnabled) {
    // Without a mounted handle, dnd-kit falls back to the wrapper as activator
    // and marks its entire open surface aria-disabled. Keep this presentation
    // unregistered so drag availability cannot disable opening the task.
    return (
      <div data-testid="kanban-sortable-card" data-task-id={props.task.id}>
        <KanbanCardView
          task={props.task}
          isPending={props.isPending}
          isSelected={props.isSelected}
          onTaskSelect={props.onTaskSelect}
          selectionDisabled={props.selectionDisabled}
          onOpen={props.onOpen}
        />
      </div>
    );
  }
  return <EnabledSortableKanbanCard {...props} />;
}

function EnabledSortableKanbanCard({
  task,
  index,
  columnId,
  columnTitle,
  reorderEnabled,
  isPending = false,
  isSelected = false,
  onTaskSelect,
  selectionDisabled = false,
  onOpen,
}: SortableKanbanCardProps): React.ReactElement {
  const disabledDescriptionId = useId();
  const dragDisabled = !reorderEnabled || isPending;
  const dragDisabledDescription = isPending
    ? "Перетаскивание временно недоступно: дождитесь сохранения текущего перемещения."
    : "Перетаскивание недоступно: отключите фильтры и выберите сортировку по позиции.";
  const {
    ref,
    handleRef,
    isDragging,
  } = useSortable({
    id: task.id,
    index,
    group: columnId,
    type: "task",
    accept: "task",
    data: {
      taskId: task.id,
      taskTitle: task.title,
      columnId,
      columnTitle,
    },
    plugins: kanbanSortablePlugins,
    disabled: { draggable: dragDisabled },
  });
  const dragHandleProps: DragHandleProps = {
    ref: handleRef as React.Ref<HTMLButtonElement>,
    "aria-disabled": dragDisabled || undefined,
    "aria-describedby": dragDisabled ? disabledDescriptionId : undefined,
    "aria-label": `Переместить задачу «${task.title}»`,
    "data-kanban-drag-handle": "",
  };

  return (
    <div
      ref={ref}
      data-testid="kanban-sortable-card"
      data-task-id={task.id}
    >
      <KanbanCardView
        task={task}
        isDragging={isDragging}
        isPending={isPending}
        isSelected={isSelected}
        onTaskSelect={onTaskSelect}
        selectionDisabled={selectionDisabled}
        dragHandleProps={reorderEnabled ? dragHandleProps : undefined}
        onOpen={onOpen}
      />
      {dragDisabled ? (
        <span id={disabledDescriptionId} className="sr-only">
          {dragDisabledDescription}
        </span>
      ) : null}
    </div>
  );
}
