import { describe, expect, it } from "vitest";
import {
  createBase36RankService,
  formatRank,
  type RankService,
} from "../rank/rank-service";
import { MoveTaskError } from "./move-errors";
import { planMove } from "../model/plan-move";
import type { KanbanBoardState } from "../model/types";
import {
  moveTask,
  type MovableColumn,
  type MovableTask,
  type MoveTaskRepository,
  type MoveTaskTransaction,
  type OrderedTaskUpdate,
  type StoredMoveOperation,
  type MoveActivityInput,
} from "./move-task-service";

const OPERATION_ID = "b1e62929-6741-4860-a6a3-5f90b82d5a11";
const SECOND_OPERATION_ID = "b13ce0b6-643a-458c-ad01-8e475ecad6f3";

interface Snapshot {
  columns: Record<string, MovableColumn>;
  tasks: Record<string, MovableTask & { position: number }>;
  taskIdsByColumn: Record<string, string[]>;
  operations: Record<string, StoredMoveOperation>;
  activities: MoveActivityInput[];
  boardRevisions: Record<string, number>;
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}

class InMemoryMoveRepository implements MoveTaskRepository {
  snapshot: Snapshot;
  writeCount = 0;
  failAt: "writeMoveActivity" | null = null;
  guardFailure: MoveTaskError | null = null;
  protocol: string[] = [];

  constructor(snapshot = createSnapshot()) {
    this.snapshot = cloneSnapshot(snapshot);
  }

  async transact<T>(
    operation: (tx: MoveTaskTransaction) => Promise<T>,
  ): Promise<T> {
    const working = cloneSnapshot(this.snapshot);
    const tx: MoveTaskTransaction = {
      assertLegacyMoveAllowed: async () => { this.protocol.push("preflight"); if (this.guardFailure) throw this.guardFailure; },
      getOperation: async (operationId) => { this.protocol.push("receipt"); return working.operations[operationId] ?? null; },
      getTaskForUpdate: async (taskId) => working.tasks[taskId] ?? null,
      getColumnForUpdate: async (columnId) =>
        working.columns[columnId] ?? null,
      getOrderedColumnTasksForUpdate: async (columnId) =>
        (working.taskIdsByColumn[columnId] ?? []).map(
          (taskId) => working.tasks[taskId],
        ),
      writeRanksAndCompatibilityPositions: async (updates) => {
        this.writeCount += 1;
        applyOrderedUpdates(working, updates);
      },
      updateMovedTask: async (input) => {
        this.writeCount += 1;
        const task = working.tasks[input.taskId];
        if (!task) {
          throw new Error(`Missing task ${input.taskId}`);
        }
        task.columnId = input.toColumnId;
        task.status = input.status;
        task.version += 1;
        rebuildColumnIndexes(working);
        return task;
      },
      incrementBoardRevision: async (projectId) => {
        this.writeCount += 1;
        working.boardRevisions[projectId] =
          (working.boardRevisions[projectId] ?? 0) + 1;
        return working.boardRevisions[projectId];
      },
      storeOperation: async (input) => {
        this.writeCount += 1;
        working.operations[input.operationId] = {
          operationId: input.operationId,
          requestHash: input.requestHash,
          response: structuredClone(input.response),
        };
      },
      writeMoveActivity: async (input) => {
        this.writeCount += 1;
        working.activities.push(structuredClone(input));
        if (this.failAt === "writeMoveActivity") {
          throw new Error("injected transaction failure");
        }
      },
    };

    const result = await operation(tx);
    this.snapshot = working;
    return result;
  }
}

function applyOrderedUpdates(
  snapshot: Snapshot,
  updates: readonly OrderedTaskUpdate[],
): void {
  for (const update of updates) {
    const task = snapshot.tasks[update.taskId];
    if (!task) {
      throw new Error(`Missing task ${update.taskId}`);
    }
    task.columnId = update.columnId;
    task.rank = update.rank;
    task.position = update.position;
  }
  rebuildColumnIndexes(snapshot);
}

function rebuildColumnIndexes(snapshot: Snapshot): void {
  snapshot.taskIdsByColumn = Object.fromEntries(
    Object.keys(snapshot.columns).map((columnId) => [
      columnId,
      Object.values(snapshot.tasks)
        .filter((task) => task.columnId === columnId)
        .toSorted((left, right) => left.rank.localeCompare(right.rank))
        .map((task) => task.id),
    ]),
  );
}

function createSnapshot(): Snapshot {
  const columns: Record<string, MovableColumn> = {
    todo: {
      id: "todo",
      projectId: "project-1",
      name: "К выполнению",
      workflowKey: "TODO",
    },
    doing: {
      id: "doing",
      projectId: "project-1",
      name: "В работе",
      workflowKey: "IN_PROGRESS",
    },
    empty: {
      id: "empty",
      projectId: "project-1",
      name: "На проверке",
      workflowKey: "REVIEW",
    },
    foreign: {
      id: "foreign",
      projectId: "project-2",
      name: "Готово",
      workflowKey: "DONE",
    },
  };
  const tasks: Snapshot["tasks"] = {
    "task-a": task("task-a", "todo", 1, formatRank(100n)),
    "task-b": task("task-b", "todo", 1, formatRank(200n)),
    "task-c": task("task-c", "todo", 2, formatRank(300n)),
    "task-d": task("task-d", "doing", 1, formatRank(100n), "IN_PROGRESS"),
  };
  const snapshot: Snapshot = {
    columns,
    tasks,
    taskIdsByColumn: {},
    operations: {},
    activities: [],
    boardRevisions: { "project-1": 7, "project-2": 2 },
  };
  rebuildColumnIndexes(snapshot);
  return snapshot;
}

function task(
  id: string,
  columnId: string,
  version: number,
  rank: string,
  status = "TODO",
): Snapshot["tasks"][string] {
  return {
    id,
    projectId: "project-1",
    columnId,
    status,
    version,
    rank,
    position: 0,
  };
}

function request(
  overrides: Partial<{
    toColumnId: string;
    beforeTaskId: string | null;
    afterTaskId: string | null;
    operationId: string;
    expectedVersion: number;
  }> = {},
) {
  return {
    toColumnId: "doing",
    beforeTaskId: "task-d",
    afterTaskId: null,
    operationId: OPERATION_ID,
    expectedVersion: 2,
    ...overrides,
  };
}

async function execute(
  repository: MoveTaskRepository,
  overrides: Parameters<typeof request>[0] = {},
  ranks: RankService = createBase36RankService(),
) {
  return moveTask({
    taskId: "task-c",
    request: request(overrides),
    repository,
    ranks,
  });
}

describe("transactional task move service", () => {
  it.each(["doing", "empty"])("moves forward into %s then back to the first nonempty column with fresh canonical neighbors", async destination => {
    const repository = new InMemoryMoveRepository();
    const clientState = (): KanbanBoardState => ({
      columnOrder: ["todo", "doing", "empty"],
      taskIdsByColumn: structuredClone(repository.snapshot.taskIdsByColumn),
      tasksById: Object.fromEntries(Object.entries(repository.snapshot.tasks).map(([id, task]) => [id, { ...task }])),
    });
    const forward = planMove(clientState(), { taskId: "task-c", toColumnId: destination, targetIndex: 99 });
    const first = await execute(repository, forward.command);
    const backward = planMove(clientState(), { taskId: "task-c", toColumnId: "todo", targetIndex: 0 });
    expect(backward.command).toEqual({ toColumnId: "todo", beforeTaskId: null, afterTaskId: "task-a" });
    const second = await execute(repository, { ...backward.command, expectedVersion: first.task.version, operationId: SECOND_OPERATION_ID });
    expect(second.task).toMatchObject({ columnId: "todo", version: first.task.version + 1, status: "TODO" });
    expect(repository.snapshot.taskIdsByColumn.todo).toEqual(["task-c", "task-a", "task-b"]);
    expect(repository.snapshot.activities).toHaveLength(2);
  });
  it("rejects incomplete visible-order anchors on the return trip without writes, receipts or implicit append", async () => {
    const repository = new InMemoryMoveRepository();
    const first = await execute(repository, { toColumnId: "empty", beforeTaskId: null, afterTaskId: null });
    const before = cloneSnapshot(repository.snapshot), writes = repository.writeCount;
    const visible: KanbanBoardState = {
      columnOrder: ["todo", "doing", "empty"],
      taskIdsByColumn: { todo: [], doing: [], empty: ["task-c"] },
      tasksById: { "task-c": { ...repository.snapshot.tasks["task-c"] } },
    };
    const backward = planMove(visible, { taskId: "task-c", toColumnId: "todo", targetIndex: 0 });
    expect(backward.command).toEqual({ toColumnId: "todo", beforeTaskId: null, afterTaskId: null });
    await expect(execute(repository, { ...backward.command, expectedVersion: first.task.version, operationId: SECOND_OPERATION_ID }))
      .rejects.toEqual(new MoveTaskError("INVALID_MOVE_NEIGHBORS"));
    expect(repository.snapshot).toEqual(before);
    expect(repository.writeCount).toBe(writes);
    expect(repository.snapshot.operations[SECOND_OPERATION_ID]).toBeUndefined();
  });
  it.each(["REQUEST_LIFECYCLE_NOT_ENABLED", "INVALID_REQUEST_MARKER"] as const)("runs required %s preflight before both a new move and historical replay", async code => {
    const repository = new InMemoryMoveRepository();
    await execute(repository); const before = cloneSnapshot(repository.snapshot), writes = repository.writeCount;
    repository.guardFailure = new MoveTaskError(code);
    for (const operationId of [OPERATION_ID, SECOND_OPERATION_ID]) {
      repository.protocol = [];
      await expect(execute(repository, { operationId })).rejects.toEqual(new MoveTaskError(code));
      expect(repository.protocol).toEqual(["preflight"]); expect(repository.snapshot).toEqual(before); expect(repository.writeCount).toBe(writes);
    }
  });
  it("does not bypass required preflight for an unchanged same-column placement", async () => {
    const repository = new InMemoryMoveRepository(); repository.guardFailure = new MoveTaskError("REQUEST_LIFECYCLE_NOT_ENABLED");
    await expect(execute(repository, { toColumnId: "todo", beforeTaskId: "task-b", afterTaskId: null })).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" });
    expect(repository.protocol).toEqual(["preflight"]); expect(repository.writeCount).toBe(0);
  });
  it("persists the exact same-column order requested by semantic neighbors", async () => {
    const repository = new InMemoryMoveRepository();

    await execute(repository, {
      toColumnId: "todo",
      beforeTaskId: null,
      afterTaskId: "task-a",
    });

    expect(repository.snapshot.taskIdsByColumn.todo).toEqual([
      "task-c",
      "task-a",
      "task-b",
    ]);
    expect(
      repository.snapshot.taskIdsByColumn.todo.map(
        (id) => repository.snapshot.tasks[id].position,
      ),
    ).toEqual([1024, 2048, 3072]);
  });

  it("persists exact cross-column order and returns the committed versions", async () => {
    const repository = new InMemoryMoveRepository();

    const result = await execute(repository);

    expect(result).toEqual({
      operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11",
      boardRevision: 8,
      task: {
        id: "task-c",
        columnId: "doing",
        version: 3,
        status: "IN_PROGRESS",
      },
    });
    expect(repository.snapshot.taskIdsByColumn.doing).toEqual([
      "task-d",
      "task-c",
    ]);
    expect(repository.snapshot.taskIdsByColumn.todo).toEqual([
      "task-a",
      "task-b",
    ]);
  });

  it("moves into an empty destination when both semantic neighbors are null", async () => {
    const repository = new InMemoryMoveRepository();

    await execute(repository, {
      toColumnId: "empty",
      beforeTaskId: null,
      afterTaskId: null,
    });

    expect(repository.snapshot.taskIdsByColumn.empty).toEqual(["task-c"]);
    expect(repository.snapshot.tasks["task-c"]).toMatchObject({
      status: "IN_REVIEW",
      position: 1024,
    });
  });

  it("removes the active task before validating same-column neighbors", async () => {
    const repository = new InMemoryMoveRepository();
    repository.snapshot.tasks["task-d"].columnId = "todo";
    repository.snapshot.tasks["task-d"].status = "TODO";
    repository.snapshot.tasks["task-d"].rank = formatRank(400n);
    rebuildColumnIndexes(repository.snapshot);

    await execute(repository, {
      toColumnId: "todo",
      beforeTaskId: "task-b",
      afterTaskId: "task-d",
    });

    expect(repository.snapshot.taskIdsByColumn.todo).toEqual([
      "task-a",
      "task-b",
      "task-c",
      "task-d",
    ]);
  });

  it("rejects a destination column from another project", async () => {
    const repository = new InMemoryMoveRepository();

    await expect(
      execute(repository, {
        toColumnId: "foreign",
        beforeTaskId: null,
        afterTaskId: null,
      }),
    ).rejects.toEqual(
      new MoveTaskError("INVALID_DESTINATION_COLUMN"),
    );
  });

  it.each([
    {
      label: "non-adjacent",
      beforeTaskId: "task-a",
      afterTaskId: "task-c",
    },
    {
      label: "missing",
      beforeTaskId: "missing-task",
      afterTaskId: "task-d",
    },
  ])("rejects a $label neighbor pair", async ({ beforeTaskId, afterTaskId }) => {
    const repository = new InMemoryMoveRepository();

    await expect(
      execute(repository, {
        beforeTaskId,
        afterTaskId,
      }),
    ).rejects.toEqual(new MoveTaskError("INVALID_MOVE_NEIGHBORS"));
  });

  it("rejects a stale task version before writing", async () => {
    const repository = new InMemoryMoveRepository();

    await expect(
      execute(repository, { expectedVersion: 1 }),
    ).rejects.toEqual(new MoveTaskError("STALE_TASK_VERSION"));
    expect(repository.writeCount).toBe(0);
  });

  it("returns an identical operation retry without another write", async () => {
    const repository = new InMemoryMoveRepository();
    const first = await execute(repository);
    const writesAfterFirstCommit = repository.writeCount;

    const replay = await execute(repository);

    expect(replay).toEqual(first);
    expect(repository.writeCount).toBe(writesAfterFirstCommit);
    expect(repository.snapshot.activities).toHaveLength(1);
    expect(repository.snapshot.boardRevisions["project-1"]).toBe(8);
  });

  it("rejects operation ID reuse with a different canonical request hash", async () => {
    const repository = new InMemoryMoveRepository();
    await execute(repository);

    await expect(
      execute(repository, {
        toColumnId: "empty",
        beforeTaskId: null,
        afterTaskId: null,
      }),
    ).rejects.toEqual(new MoveTaskError("OPERATION_ID_REUSED"));
  });

  it("rebalances exactly once when the requested rank gap is exhausted", async () => {
    const snapshot = createSnapshot();
    snapshot.tasks["task-a"].columnId = "doing";
    snapshot.tasks["task-a"].status = "IN_PROGRESS";
    snapshot.tasks["task-a"].rank = formatRank(100n);
    snapshot.tasks["task-d"].rank = formatRank(101n);
    rebuildColumnIndexes(snapshot);
    const repository = new InMemoryMoveRepository(snapshot);
    const baseRanks = createBase36RankService();
    let rebalanceCount = 0;
    const countingRanks: RankService = {
      between: baseRanks.between,
      rebalance(taskIds) {
        rebalanceCount += 1;
        return baseRanks.rebalance(taskIds);
      },
    };

    await execute(
      repository,
      {
        beforeTaskId: "task-a",
        afterTaskId: "task-d",
      },
      countingRanks,
    );

    expect(rebalanceCount).toBe(1);
    expect(repository.snapshot.taskIdsByColumn.doing).toEqual([
      "task-a",
      "task-c",
      "task-d",
    ]);
    const persistedRanks = repository.snapshot.taskIdsByColumn.doing.map(
      (id) => repository.snapshot.tasks[id].rank,
    );
    expect(persistedRanks).toEqual(persistedRanks.toSorted());
  });

  it("rolls back every write when the transaction fails", async () => {
    const repository = new InMemoryMoveRepository();
    const before = cloneSnapshot(repository.snapshot);
    repository.failAt = "writeMoveActivity";

    await expect(execute(repository)).rejects.toThrow(
      "injected transaction failure",
    );

    expect(repository.snapshot).toEqual(before);
  });

  it("increments the task version and board revision exactly once", async () => {
    const repository = new InMemoryMoveRepository();

    await execute(repository, { operationId: SECOND_OPERATION_ID });

    expect(repository.snapshot.tasks["task-c"].version).toBe(3);
    expect(repository.snapshot.boardRevisions["project-1"]).toBe(8);
    expect(repository.snapshot.activities).toEqual([
      {
        taskId: "task-c",
        fromColumnId: "todo",
        fromColumnName: "К выполнению",
        toColumnId: "doing",
        toColumnName: "В работе",
        oldStatus: "TODO",
        newStatus: "IN_PROGRESS",
      },
    ]);
  });
});
