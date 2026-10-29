import type {
  KanbanBoardState,
  KanbanTaskRecord,
  MoveTaskCommandDraft,
} from "./types";

export type KanbanMovePlanningErrorCode =
  | "TASK_NOT_FOUND"
  | "COLUMN_NOT_FOUND"
  | "INVALID_BOARD_STATE"
  | "INVALID_TARGET_INDEX";

export class KanbanMovePlanningError extends Error {
  constructor(public readonly code: KanbanMovePlanningErrorCode) {
    super(`Cannot plan move: ${code}`);
    this.name = "KanbanMovePlanningError";
  }
}

export function planMove(
  state: KanbanBoardState,
  input: { taskId: string; toColumnId: string; targetIndex: number },
): { nextState: KanbanBoardState; command: MoveTaskCommandDraft } {
  const task = state.tasksById[input.taskId];
  if (!task) {
    throw new KanbanMovePlanningError("TASK_NOT_FOUND");
  }

  if (typeof input.targetIndex !== "number" || Number.isNaN(input.targetIndex)) {
    throw new KanbanMovePlanningError("INVALID_TARGET_INDEX");
  }

  const sourceTaskIds = state.taskIdsByColumn[task.columnId];
  if (!state.columnOrder.includes(task.columnId) || !Array.isArray(sourceTaskIds)) {
    throw new KanbanMovePlanningError("INVALID_BOARD_STATE");
  }

  const sourceOccurrences = sourceTaskIds.filter((taskId) => taskId === task.id).length;
  const appearsInAnotherColumn = Object.entries(state.taskIdsByColumn).some(
    ([columnId, taskIds]) =>
      columnId !== task.columnId && taskIds.some((taskId) => taskId === task.id),
  );
  if (sourceOccurrences !== 1 || appearsInAnotherColumn) {
    throw new KanbanMovePlanningError("INVALID_BOARD_STATE");
  }

  if (!state.columnOrder.includes(input.toColumnId) || !state.taskIdsByColumn[input.toColumnId]) {
    throw new KanbanMovePlanningError("COLUMN_NOT_FOUND");
  }

  const taskIdsByColumn = Object.fromEntries(
    Object.entries(state.taskIdsByColumn).map(([columnId, taskIds]) => [columnId, [...taskIds]]),
  ) as Record<string, string[]>;
  taskIdsByColumn[task.columnId] = sourceTaskIds.filter((taskId) => taskId !== task.id);

  const destinationTaskIds = taskIdsByColumn[input.toColumnId];
  if (
    new Set(destinationTaskIds).size !== destinationTaskIds.length ||
    destinationTaskIds.some((taskId) => {
      const neighbor = state.tasksById[taskId];
      return !neighbor || neighbor.id !== taskId || neighbor.columnId !== input.toColumnId;
    })
  ) {
    throw new KanbanMovePlanningError("INVALID_BOARD_STATE");
  }
  const normalizedTargetIndex = Math.trunc(input.targetIndex);
  const targetIndex = Math.min(Math.max(normalizedTargetIndex, 0), destinationTaskIds.length);

  // Derive anchors from the destination without the active task, as the server does.
  // At the end use its last task; at the top use its first task.
  const command: MoveTaskCommandDraft = {
    toColumnId: input.toColumnId,
    beforeTaskId: destinationTaskIds[targetIndex - 1] ?? null,
    afterTaskId: destinationTaskIds[targetIndex] ?? null,
  };
  destinationTaskIds.splice(targetIndex, 0, task.id);
  const tasksById: Record<string, KanbanTaskRecord> = {
    ...state.tasksById,
    [task.id]: { ...task, columnId: input.toColumnId },
  };

  return {
    nextState: {
      columnOrder: [...state.columnOrder],
      taskIdsByColumn,
      tasksById,
    },
    command,
  };
}

export type { KanbanBoardState, KanbanTaskRecord, MoveTaskCommandDraft } from "./types";
