import { describe, expect, it } from "vitest";
import {
  KanbanMovePlanningError,
  planMove,
  type KanbanBoardState,
} from "./plan-move";
import {
  KanbanBoardNormalizationError,
  normalizeBoard,
  type KanbanTaskRecord,
} from "./normalize-board";

const state: KanbanBoardState = {
  columnOrder: ["todo", "doing", "done"],
  taskIdsByColumn: {
    todo: ["a", "b", "c"],
    doing: ["d"],
    done: [],
  },
  tasksById: {
    a: { id: "a", columnId: "todo", position: 1, version: 2 },
    b: { id: "b", columnId: "todo", position: 2, version: 0 },
    c: { id: "c", columnId: "todo", position: 3, version: 0 },
    d: { id: "d", columnId: "doing", position: 1, version: 1 },
  },
};

describe("planMove", () => {
  it("moves c before a and derives null/a neighbors", () => {
    const result = planMove(state, {
      taskId: "c",
      toColumnId: "todo",
      targetIndex: 0,
    });

    expect(result.nextState.taskIdsByColumn.todo).toEqual(["c", "a", "b"]);
    expect(result.command).toEqual({
      toColumnId: "todo",
      beforeTaskId: null,
      afterTaskId: "a",
    });
  });

  it("moves b into an empty column", () => {
    const result = planMove(state, {
      taskId: "b",
      toColumnId: "done",
      targetIndex: 99,
    });

    expect(result.nextState.taskIdsByColumn.todo).toEqual(["a", "c"]);
    expect(result.nextState.taskIdsByColumn.done).toEqual(["b"]);
    expect(result.nextState.tasksById.b.columnId).toBe("done");
    expect(result.command).toEqual({
      toColumnId: "done",
      beforeTaskId: null,
      afterTaskId: null,
    });
  });

  it("does not mutate the source snapshot", () => {
    const frozen = structuredClone(state);

    planMove(state, { taskId: "a", toColumnId: "doing", targetIndex: 1 });

    expect(state).toEqual(frozen);
  });

  it("clamps a negative target index to the destination start", () => {
    const result = planMove(state, {
      taskId: "b",
      toColumnId: "doing",
      targetIndex: -3,
    });

    expect(result.nextState.taskIdsByColumn.doing).toEqual(["b", "d"]);
    expect(result.command).toEqual({
      toColumnId: "doing",
      beforeTaskId: null,
      afterTaskId: "d",
    });
  });

  it("clamps a target index above the destination length to its end", () => {
    const result = planMove(state, {
      taskId: "c",
      toColumnId: "todo",
      targetIndex: 99,
    });

    expect(result.nextState.taskIdsByColumn.todo).toEqual(["a", "b", "c"]);
    expect(result.command).toEqual({
      toColumnId: "todo",
      beforeTaskId: "b",
      afterTaskId: null,
    });
  });

  it("calculates neighbors after removing the active task", () => {
    const result = planMove(state, {
      taskId: "b",
      toColumnId: "todo",
      targetIndex: 2,
    });

    expect(result.nextState.taskIdsByColumn.todo).toEqual(["a", "c", "b"]);
    expect(result.command).toEqual({
      toColumnId: "todo",
      beforeTaskId: "c",
      afterTaskId: null,
    });
  });

  it("preserves a no-op location while deriving its current neighbors", () => {
    const result = planMove(state, {
      taskId: "b",
      toColumnId: "todo",
      targetIndex: 1,
    });

    expect(result.nextState.taskIdsByColumn.todo).toEqual(["a", "b", "c"]);
    expect(result.command).toEqual({
      toColumnId: "todo",
      beforeTaskId: "a",
      afterTaskId: "c",
    });
  });

  it("rejects a missing task with a typed error", () => {
    expect(() =>
      planMove(state, { taskId: "missing", toColumnId: "todo", targetIndex: 0 }),
    ).toThrow(KanbanMovePlanningError);

    try {
      planMove(state, { taskId: "missing", toColumnId: "todo", targetIndex: 0 });
    } catch (error) {
      expect(error).toMatchObject({ code: "TASK_NOT_FOUND" });
    }
  });

  it("rejects a missing destination column with a typed error", () => {
    expect(() =>
      planMove(state, { taskId: "a", toColumnId: "missing", targetIndex: 0 }),
    ).toThrow(KanbanMovePlanningError);

    try {
      planMove(state, { taskId: "a", toColumnId: "missing", targetIndex: 0 });
    } catch (error) {
      expect(error).toMatchObject({ code: "COLUMN_NOT_FOUND" });
    }
  });

  it("rejects a declared source column that is absent from the board", () => {
    const corrupted = structuredClone(state);
    corrupted.tasksById.a.columnId = "missing";

    expect(() =>
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 }),
    ).toThrow(KanbanMovePlanningError);

    try {
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_BOARD_STATE" });
    }
  });

  it("rejects an active task missing from its declared source list", () => {
    const corrupted = structuredClone(state);
    corrupted.taskIdsByColumn.todo = ["b", "c"];

    expect(() =>
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 }),
    ).toThrow(KanbanMovePlanningError);

    try {
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_BOARD_STATE" });
    }
  });

  it("rejects an active task duplicated in its declared source list", () => {
    const corrupted = structuredClone(state);
    corrupted.taskIdsByColumn.todo = ["a", "a", "b", "c"];

    expect(() =>
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 }),
    ).toThrow(KanbanMovePlanningError);

    try {
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_BOARD_STATE" });
    }
  });

  it("rejects an active task that also appears in another column", () => {
    const corrupted = structuredClone(state);
    corrupted.taskIdsByColumn.doing = ["d", "a"];

    expect(() =>
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 }),
    ).toThrow(KanbanMovePlanningError);

    try {
      planMove(corrupted, { taskId: "a", toColumnId: "todo", targetIndex: 0 });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_BOARD_STATE" });
    }
  });

  it("rejects a NaN target index with a typed error", () => {
    expect(() =>
      planMove(state, { taskId: "a", toColumnId: "todo", targetIndex: Number.NaN }),
    ).toThrow(KanbanMovePlanningError);

    try {
      planMove(state, { taskId: "a", toColumnId: "todo", targetIndex: Number.NaN });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_TARGET_INDEX" });
    }
  });

  it("clamps negative infinity to the destination start", () => {
    const result = planMove(state, {
      taskId: "b",
      toColumnId: "doing",
      targetIndex: Number.NEGATIVE_INFINITY,
    });

    expect(result.nextState.taskIdsByColumn.doing).toEqual(["b", "d"]);
  });

  it("clamps positive infinity to the destination end", () => {
    const result = planMove(state, {
      taskId: "b",
      toColumnId: "doing",
      targetIndex: Number.POSITIVE_INFINITY,
    });

    expect(result.nextState.taskIdsByColumn.doing).toEqual(["d", "b"]);
  });
});

describe("normalizeBoard", () => {
  it("sorts serializable board records into independent normalized collections", () => {
    const source = {
      columns: [
        { id: "doing", position: 2, name: "Doing" },
        { id: "todo", position: 1, name: "To do" },
      ],
      tasks: [
        { id: "b", columnId: "todo", position: 20, version: 1, title: "B" },
        { id: "a", columnId: "todo", position: 10, version: 3, title: "A" },
      ],
    };

    const result = normalizeBoard(source);

    expect(result).toEqual({
      columnOrder: ["todo", "doing"],
      taskIdsByColumn: { todo: ["a", "b"], doing: [] },
      tasksById: {
        a: { id: "a", columnId: "todo", position: 10, version: 3, title: "A" },
        b: { id: "b", columnId: "todo", position: 20, version: 1, title: "B" },
      },
    });
    expect(result.tasksById.a).not.toBe(source.tasks[1]);
  });

  it("sorts equal-position columns and tasks by ID", () => {
    const result = normalizeBoard({
      columns: [
        { id: "beta", position: 1 },
        { id: "alpha", position: 1 },
      ],
      tasks: [
        { id: "b", columnId: "alpha", position: 1, version: 0 },
        { id: "a", columnId: "alpha", position: 1, version: 0 },
      ],
    });

    expect(result.columnOrder).toEqual(["alpha", "beta"]);
    expect(result.taskIdsByColumn.alpha).toEqual(["a", "b"]);
  });

  it("rejects a task assigned to an unknown column", () => {
    expect(() =>
      normalizeBoard({
        columns: [{ id: "todo", position: 1 }],
        tasks: [{ id: "a", columnId: "missing", position: 1, version: 0 }],
      }),
    ).toThrow(KanbanBoardNormalizationError);

    try {
      normalizeBoard({
        columns: [{ id: "todo", position: 1 }],
        tasks: [{ id: "a", columnId: "missing", position: 1, version: 0 }],
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "UNKNOWN_TASK_COLUMN" });
    }
  });

  it("rejects duplicate task IDs", () => {
    expect(() =>
      normalizeBoard({
        columns: [{ id: "todo", position: 1 }],
        tasks: [
          { id: "a", columnId: "todo", position: 1, version: 0 },
          { id: "a", columnId: "todo", position: 2, version: 0 },
        ],
      }),
    ).toThrow(KanbanBoardNormalizationError);
  });

  it("rejects duplicate column IDs", () => {
    expect(() =>
      normalizeBoard({
        columns: [
          { id: "todo", position: 1 },
          { id: "todo", position: 2 },
        ],
        tasks: [],
      }),
    ).toThrow(KanbanBoardNormalizationError);
  });

  it.each([
    ["missing", { id: "a", columnId: "todo", version: 0 }],
    ["NaN", { id: "a", columnId: "todo", position: Number.NaN, version: 0 }],
    ["infinite", { id: "a", columnId: "todo", position: Number.POSITIVE_INFINITY, version: 0 }],
  ])("rejects a %s task position", (_kind, task) => {
    expect(() =>
      normalizeBoard({
        columns: [{ id: "todo", position: 1 }],
        tasks: [task as KanbanTaskRecord],
      }),
    ).toThrow(KanbanBoardNormalizationError);
  });
});
