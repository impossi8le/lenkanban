import type {
  KanbanBoardState,
  KanbanTaskRecord,
  NormalizeBoardInput,
} from "./types";

export type KanbanBoardNormalizationErrorCode =
  | "UNKNOWN_TASK_COLUMN"
  | "DUPLICATE_TASK_ID"
  | "DUPLICATE_COLUMN_ID"
  | "INVALID_TASK_POSITION";

export class KanbanBoardNormalizationError extends Error {
  constructor(public readonly code: KanbanBoardNormalizationErrorCode) {
    super(`Cannot normalize board: ${code}`);
    this.name = "KanbanBoardNormalizationError";
  }
}

export function normalizeBoard({ columns, tasks }: NormalizeBoardInput): KanbanBoardState {
  const columnIds = new Set<string>();
  for (const column of columns) {
    if (columnIds.has(column.id)) {
      throw new KanbanBoardNormalizationError("DUPLICATE_COLUMN_ID");
    }
    columnIds.add(column.id);
  }

  const orderedColumns = [...columns].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
  const columnOrder = orderedColumns.map((column) => column.id);
  const taskIdsByColumn = Object.fromEntries(
    columnOrder.map((columnId) => [columnId, [] as string[]]),
  ) as Record<string, string[]>;
  const tasksById: Record<string, KanbanTaskRecord> = {};

  for (const task of tasks) {
    if (!Number.isFinite(task.position)) {
      throw new KanbanBoardNormalizationError("INVALID_TASK_POSITION");
    }
    if (task.id in tasksById) {
      throw new KanbanBoardNormalizationError("DUPLICATE_TASK_ID");
    }
    if (!columnIds.has(task.columnId)) {
      throw new KanbanBoardNormalizationError("UNKNOWN_TASK_COLUMN");
    }

    tasksById[task.id] = { ...task };
    taskIdsByColumn[task.columnId].push(task.id);
  }

  for (const columnId of columnOrder) {
    taskIdsByColumn[columnId].sort(
      (leftTaskId, rightTaskId) =>
        tasksById[leftTaskId].position - tasksById[rightTaskId].position ||
        leftTaskId.localeCompare(rightTaskId),
    );
  }

  return { columnOrder, taskIdsByColumn, tasksById };
}

export type {
  KanbanColumnRecord,
  KanbanTaskRecord,
  NormalizeBoardInput,
} from "./types";
