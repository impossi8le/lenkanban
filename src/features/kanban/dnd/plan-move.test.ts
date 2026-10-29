import { describe, expect, it } from "vitest";
import { planMove } from "../model/plan-move";
import type { KanbanBoardState } from "../model/types";

function board(): KanbanBoardState {
  return {
    columnOrder: ["todo", "doing"],
    taskIdsByColumn: { todo: ["a", "b"], doing: ["c"] },
    tasksById: {
      a: { id: "a", columnId: "todo", position: 1, version: 1 },
      b: { id: "b", columnId: "todo", position: 2, version: 1 },
      c: { id: "c", columnId: "doing", position: 1, version: 1 },
    },
  };
}

describe("move neighbor contract", () => {
  it.each([
    { index: 0, before: null, after: "a", ids: ["c", "a", "b"] },
    { index: 1, before: "a", after: "b", ids: ["a", "c", "b"] },
    { index: 99, before: "b", after: null, ids: ["a", "b", "c"] },
  ])("uses destination anchors at index $index without mutating the snapshot", ({ index, before, after, ids }) => {
    const snapshot = board();
    const result = planMove(snapshot, { taskId: "c", toColumnId: "todo", targetIndex: index });
    expect(result.command).toEqual({ toColumnId: "todo", beforeTaskId: before, afterTaskId: after });
    expect(result.nextState.taskIdsByColumn.todo).toEqual(ids);
    expect(snapshot).toEqual(board());
  });

  it.each([undefined, null, "1"])("rejects a malformed runtime index %s before it can produce null/null", (targetIndex) => {
    expect(() => planMove(board(), {
      taskId: "c", toColumnId: "todo", targetIndex: targetIndex as unknown as number,
    })).toThrow(expect.objectContaining({ code: "INVALID_TARGET_INDEX" }));
  });

  it.each(["missing", "foreign", "duplicate", "mismatched-id"])("rejects %s destination anchors", (corruption) => {
    const snapshot = board();
    if (corruption === "missing") delete snapshot.tasksById.b;
    if (corruption === "foreign") snapshot.tasksById.b.columnId = "doing";
    if (corruption === "duplicate") snapshot.taskIdsByColumn.todo.push("b");
    if (corruption === "mismatched-id") snapshot.tasksById.b.id = "other";
    expect(() => planMove(snapshot, { taskId: "c", toColumnId: "todo", targetIndex: 99 }))
      .toThrow(expect.objectContaining({ code: "INVALID_BOARD_STATE" }));
  });
});
