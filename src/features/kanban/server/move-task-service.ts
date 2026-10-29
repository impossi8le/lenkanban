import { createHash } from "node:crypto";
import type { RankService } from "../rank/rank-service";
import {
  derivedTaskStatus,
  isPlainMoveRouteAllowed,
  type WorkflowMoveColumn,
  type MoveTaskRequest,
  type MoveTaskResponse,
} from "./move-contract";
import { MoveTaskError } from "./move-errors";

export interface StoredMoveOperation {
  operationId: string;
  requestHash: string;
  response: MoveTaskResponse;
}

export interface MovableTask {
  id: string;
  projectId: string;
  columnId: string;
  rank: string;
  version: number;
  status: string;
}

export interface MovableColumn extends WorkflowMoveColumn {
  name: string;
}

export interface OrderedTaskUpdate {
  taskId: string;
  columnId: string;
  rank: string;
  position: number;
}

export interface UpdateMovedTaskInput {
  taskId: string;
  toColumnId: string;
  status: string;
  expectedVersion: number;
}

export interface StoreMoveOperationInput {
  operationId: string;
  taskId: string;
  projectId: string;
  requestHash: string;
  response: MoveTaskResponse;
}

export interface MoveActivityInput {
  taskId: string;
  fromColumnId: string;
  fromColumnName: string;
  toColumnId: string;
  toColumnName: string;
  oldStatus: string;
  newStatus: string;
}

export interface MoveTaskRepository {
  transact<T>(
    operation: (tx: MoveTaskTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface MoveTaskTransaction {
  assertLegacyMoveAllowed(taskId: string): Promise<void>;
  getOperation(operationId: string): Promise<StoredMoveOperation | null>;
  getTaskForUpdate(taskId: string): Promise<MovableTask | null>;
  getColumnForUpdate(columnId: string): Promise<MovableColumn | null>;
  getOrderedColumnTasksForUpdate(columnId: string): Promise<MovableTask[]>;
  writeRanksAndCompatibilityPositions(
    updates: readonly OrderedTaskUpdate[],
  ): Promise<void>;
  updateMovedTask(input: UpdateMovedTaskInput): Promise<MovableTask>;
  incrementBoardRevision(projectId: string): Promise<number>;
  storeOperation(input: StoreMoveOperationInput): Promise<void>;
  writeMoveActivity(input: MoveActivityInput): Promise<void>;
}

function hashMoveRequest(
  taskId: string,
  request: MoveTaskRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        taskId,
        request.toColumnId,
        request.beforeTaskId,
        request.afterTaskId,
        request.expectedVersion,
      ]),
    )
    .digest("hex");
}

function insertionIndex(
  destinationWithoutActiveTask: readonly MovableTask[],
  beforeTaskId: string | null,
  afterTaskId: string | null,
): number {
  if (beforeTaskId === null && afterTaskId === null) {
    if (destinationWithoutActiveTask.length === 0) {
      return 0;
    }
    throw new MoveTaskError("INVALID_MOVE_NEIGHBORS");
  }

  if (beforeTaskId === null) {
    if (destinationWithoutActiveTask[0]?.id === afterTaskId) {
      return 0;
    }
    throw new MoveTaskError("INVALID_MOVE_NEIGHBORS");
  }

  if (afterTaskId === null) {
    if (destinationWithoutActiveTask.at(-1)?.id === beforeTaskId) {
      return destinationWithoutActiveTask.length;
    }
    throw new MoveTaskError("INVALID_MOVE_NEIGHBORS");
  }

  const beforeIndex = destinationWithoutActiveTask.findIndex(
    (task) => task.id === beforeTaskId,
  );
  if (
    beforeIndex >= 0 &&
    destinationWithoutActiveTask[beforeIndex + 1]?.id === afterTaskId
  ) {
    return beforeIndex + 1;
  }

  throw new MoveTaskError("INVALID_MOVE_NEIGHBORS");
}

function rankForTask(
  task: MovableTask,
  movedTaskId: string,
  movedTaskRank: string,
  rebalancedRanks: ReadonlyMap<string, string> | null,
): string {
  const rebalancedRank = rebalancedRanks?.get(task.id);
  if (rebalancedRanks && rebalancedRank === undefined) {
    throw new Error(`Missing rebalanced rank for task ${task.id}`);
  }
  if (rebalancedRank !== undefined) {
    return rebalancedRank;
  }
  return task.id === movedTaskId ? movedTaskRank : task.rank;
}

function orderedUpdates(input: {
  movedTaskId: string;
  sourceColumnId: string;
  destinationColumnId: string;
  sourceTasks: readonly MovableTask[];
  destinationTasks: readonly MovableTask[];
  movedTaskRank: string;
  rebalancedRanks: ReadonlyMap<string, string> | null;
}): OrderedTaskUpdate[] {
  const updates = new Map<string, OrderedTaskUpdate>();
  const addColumn = (
    columnId: string,
    tasks: readonly MovableTask[],
    useDestinationRanks: boolean,
  ) => {
    tasks.forEach((task, index) => {
      updates.set(task.id, {
        taskId: task.id,
        columnId,
        rank: useDestinationRanks
          ? rankForTask(
              task,
              input.movedTaskId,
              input.movedTaskRank,
              input.rebalancedRanks,
            )
          : task.rank,
        position: (index + 1) * 1024,
      });
    });
  };

  if (input.sourceColumnId !== input.destinationColumnId) {
    addColumn(input.sourceColumnId, input.sourceTasks, false);
  }
  addColumn(input.destinationColumnId, input.destinationTasks, true);
  return [...updates.values()];
}

export async function moveTask(input: {
  taskId: string;
  request: MoveTaskRequest;
  repository: MoveTaskRepository;
  ranks: RankService;
}): Promise<MoveTaskResponse> {
  const requestHash = hashMoveRequest(input.taskId, input.request);

  return input.repository.transact(async (tx) => {
    await tx.assertLegacyMoveAllowed(input.taskId);
    const storedOperation = await tx.getOperation(
      input.request.operationId,
    );
    if (storedOperation) {
      if (storedOperation.requestHash !== requestHash) {
        throw new MoveTaskError("OPERATION_ID_REUSED");
      }
      return storedOperation.response;
    }

    const task = await tx.getTaskForUpdate(input.taskId);
    if (!task) {
      throw new MoveTaskError("TASK_NOT_FOUND");
    }

    const destinationColumn = await tx.getColumnForUpdate(
      input.request.toColumnId,
    );
    if (
      !destinationColumn ||
      destinationColumn.projectId !== task.projectId
    ) {
      throw new MoveTaskError("INVALID_DESTINATION_COLUMN");
    }
    if (task.version !== input.request.expectedVersion) {
      throw new MoveTaskError("STALE_TASK_VERSION");
    }

    const sourceColumnId = task.columnId;
    const oldStatus = task.status;
    const sourceColumn =
      sourceColumnId === destinationColumn.id
        ? destinationColumn
        : await tx.getColumnForUpdate(sourceColumnId);
    if (!sourceColumn || sourceColumn.projectId !== task.projectId) {
      throw new Error(
        `Source column ${sourceColumnId} disappeared during task move`,
      );
    }
    if (!isPlainMoveRouteAllowed(sourceColumn, destinationColumn)) {
      throw new MoveTaskError("INVALID_MOVE_ROUTE");
    }
    const sourceColumnTasks =
      await tx.getOrderedColumnTasksForUpdate(sourceColumnId);
    const sourceTasksWithoutActive = sourceColumnTasks.filter(
      (candidate) => candidate.id !== task.id,
    );
    const destinationColumnTasks =
      sourceColumnId === destinationColumn.id
        ? sourceColumnTasks
        : await tx.getOrderedColumnTasksForUpdate(destinationColumn.id);
    const destinationWithoutActive = destinationColumnTasks.filter(
      (candidate) => candidate.id !== task.id,
    );
    const destinationIndex = insertionIndex(
      destinationWithoutActive,
      input.request.beforeTaskId,
      input.request.afterTaskId,
    );
    const destinationTasks = destinationWithoutActive.toSpliced(
      destinationIndex,
      0,
      task,
    );
    const previousRank =
      destinationTasks[destinationIndex - 1]?.rank ?? null;
    const nextRank =
      destinationTasks[destinationIndex + 1]?.rank ?? null;
    let movedTaskRank = input.ranks.between(previousRank, nextRank);
    let rebalancedRanks: ReadonlyMap<string, string> | null = null;
    if (movedTaskRank === null) {
      rebalancedRanks = input.ranks.rebalance(
        destinationTasks.map((candidate) => candidate.id),
      );
      movedTaskRank = rebalancedRanks.get(task.id) ?? null;
      if (movedTaskRank === null) {
        throw new Error(`Missing rebalanced rank for task ${task.id}`);
      }
    }

    await tx.writeRanksAndCompatibilityPositions(
      orderedUpdates({
        movedTaskId: task.id,
        sourceColumnId,
        destinationColumnId: destinationColumn.id,
        sourceTasks: sourceTasksWithoutActive,
        destinationTasks,
        movedTaskRank,
        rebalancedRanks,
      }),
    );

    const status = derivedTaskStatus(destinationColumn.workflowKey);
    const movedTask = await tx.updateMovedTask({
      taskId: task.id,
      toColumnId: destinationColumn.id,
      status,
      expectedVersion: input.request.expectedVersion,
    });
    await tx.writeMoveActivity({
      taskId: task.id,
      fromColumnId: sourceColumnId,
      fromColumnName: sourceColumn.name,
      toColumnId: destinationColumn.id,
      toColumnName: destinationColumn.name,
      oldStatus,
      newStatus: status,
    });
    const boardRevision = await tx.incrementBoardRevision(task.projectId);
    const response: MoveTaskResponse = {
      operationId: input.request.operationId,
      boardRevision,
      task: {
        id: movedTask.id,
        columnId: movedTask.columnId,
        version: movedTask.version,
        status: movedTask.status,
      },
    };
    await tx.storeOperation({
      operationId: input.request.operationId,
      taskId: task.id,
      projectId: task.projectId,
      requestHash,
      response,
    });
    return response;
  });
}
