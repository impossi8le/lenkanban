import { describe, expect, it } from "vitest";
import { planLegacyMove } from "./legacy-move";
import { moveTask, type MovableTask, type MoveTaskTransaction } from "@/features/kanban/server/move-task-service";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";

const tasks = [
  { id: "a", columnId: "one", position: 1024, version: 2 },
  { id: "b", columnId: "one", position: 2048, version: 0 },
  { id: "c", columnId: "one", position: 3072, version: 0 },
  { id: "d", columnId: "two", position: 1024, version: 0 },
  { id: "e", columnId: "two", position: 2048, version: 0 },
];
const rects = new Map([
  ["a", { top: 0, height: 80, left: 0, width: 300 }],
  ["b", { top: 100, height: 80, left: 0, width: 300 }],
  ["c", { top: 200, height: 80, left: 0, width: 300 }],
  ["d", { top: 0, height: 60, left: 330, width: 300 }],
  ["e", { top: 80, height: 240, left: 330, width: 300 }],
]);

describe("legacy center-based move", () => {
  it("moves up when the keyboard places the dragged card exactly on the previous card center", () => {
    expect(planLegacyMove({ tasks, taskId: "b", toColumnId: "one", centerY: 40, rects })).toMatchObject({ beforeTaskId: null, afterTaskId: "a" });
  });

  it("moves down when the keyboard places the dragged card exactly on the next card center", () => {
    expect(planLegacyMove({ tasks, taskId: "a", toColumnId: "one", centerY: 140, rects })).toMatchObject({ beforeTaskId: "b", afterTaskId: "c" });
  });

  it("places a same-column card between destination neighbors instead of sorting back by its old position", () => {
    const plan = planLegacyMove({ tasks, taskId: "a", toColumnId: "one", centerY: 180, rects });
    expect(plan).toMatchObject({ beforeTaskId: "b", afterTaskId: "c" });
    expect(plan!.tasks.filter(t => t.columnId === "one").sort((a,b) => a.position-b.position).map(t => t.id)).toEqual(["b", "a", "c"]);
  });

  it("uses dragged center against unequal-height destination centers and shows the middle slot", () => {
    const plan = planLegacyMove({ tasks, taskId: "a", toColumnId: "two", centerY: 180, rects });
    expect(plan).toMatchObject({ beforeTaskId: "d", afterTaskId: "e", indicator: { top: 70, left: 330, width: 300 } });
    expect(plan!.tasks.filter(t => t.columnId === "two").sort((a,b) => a.position-b.position).map(t => t.id)).toEqual(["d", "a", "e"]);
  });

  it("does not alter task state while previewing a move that can be cancelled", () => {
    const snapshot = structuredClone(tasks);
    planLegacyMove({ tasks, taskId: "a", toColumnId: "two", centerY: 180, rects });
    expect(tasks).toEqual(snapshot);
  });

  it("does not persist a drop into the same slot", () => {
    expect(planLegacyMove({ tasks, taskId: "a", toColumnId: "one", centerY: 40, rects })).toBeNull();
  });

  it("plans an empty-column drop without inventing neighbors", () => {
    expect(planLegacyMove({ tasks, taskId: "a", toColumnId: "empty", centerY: 40, rects })).toMatchObject({ beforeTaskId: null, afterTaskId: null });
  });

  it("persists the planned same-column order in canonical ranks and compatibility positions", async () => {
    const plan = planLegacyMove({ tasks, taskId: "a", toColumnId: "one", centerY: 180, rects });
    expect(plan).not.toBeNull();
    const ranks = createBase36RankService();
    const initialRanks = ranks.rebalance(["a", "b", "c"]);
    const stored = tasks.slice(0, 3).map(t => ({ ...t, projectId: "project", status: "TODO", rank: initialRanks.get(t.id)! }));
    const tx: MoveTaskTransaction = {
      assertLegacyMoveAllowed: async () => {},
      getOperation: async () => null,
      getTaskForUpdate: async id => stored.find(t => t.id === id) ?? null,
      getColumnForUpdate: async id => ({ id, projectId: "project", name: "One", workflowKey: "TODO" }),
      getOrderedColumnTasksForUpdate: async () => [...stored].sort((a,b) => a.rank.localeCompare(b.rank)),
      writeRanksAndCompatibilityPositions: async updates => { for (const update of updates) Object.assign(stored.find(t => t.id === update.taskId)!, update); },
      updateMovedTask: async input => { const task = stored.find(t => t.id === input.taskId)!; task.version++; return task as MovableTask; },
      incrementBoardRevision: async () => 1,
      storeOperation: async () => {},
      writeMoveActivity: async () => {},
    };
    await moveTask({ taskId: "a", request: { toColumnId: "one", beforeTaskId: plan!.beforeTaskId, afterTaskId: plan!.afterTaskId, expectedVersion: 2, operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11" }, repository: { transact: operation => operation(tx) }, ranks });
    expect([...stored].sort((a,b) => a.rank.localeCompare(b.rank)).map(t => t.id)).toEqual(["b", "a", "c"]);
    expect([...stored].sort((a,b) => a.position-b.position).map(t => t.id)).toEqual(["b", "a", "c"]);
  });
});
