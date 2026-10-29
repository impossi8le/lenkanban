import { describe, expect, it, vi } from "vitest";
import { moveTask, type MoveTaskTransaction } from "./move-task-service";
import { prepareTaskRelocation, type TaskRelocationPort } from "./task-relocation";
import { createBase36RankService } from "../rank/rank-service";

const columns = [
  { id: "todo", projectId: "project", name: "Новая", workflowKey: "TODO", position: 10 },
  { id: "doing", projectId: "project", name: "В работе", workflowKey: "IN_PROGRESS", position: 40 },
  { id: "done", projectId: "project", name: "Закрыта", workflowKey: "DONE", position: 90, precedingColumnId: "doing" },
];
const ranks = createBase36RankService();

function fixture(from: string, to: string) {
  const task = { id: "task", projectId: "project", columnId: from, status: columns.find(c => c.id === from)!.workflowKey, version: 2, rank: "0|HZZZZZZZZZZZZZZZZZZZ" };
  const write = vi.fn();
  const tx: MoveTaskTransaction = {
    assertLegacyMoveAllowed: async () => {},
    getOperation: async () => null,
    getTaskForUpdate: async () => task,
    getColumnForUpdate: async id => columns.find(c => c.id === id) ?? null,
    getOrderedColumnTasksForUpdate: async id => id === from ? [task] : [],
    writeRanksAndCompatibilityPositions: write,
    updateMovedTask: async input => { write(); return { ...task, columnId: input.toColumnId, status: input.status, version: 3 }; },
    incrementBoardRevision: async () => { write(); return 8; },
    storeOperation: write,
    writeMoveActivity: write,
  };
  const port: TaskRelocationPort = {
    assertLegacyMoveAllowed: async () => {},
    lockTask: async () => task,
    getColumnIdentity: tx.getColumnForUpdate,
    lockColumn: async () => {},
    getLastRank: async () => null,
    rebalanceColumn: async () => { write(); return []; },
    getLastPosition: async () => null,
  };
  return {
    task, tx, port,
    write,
    move: () => moveTask({ taskId: task.id, request: { toColumnId: to, beforeTaskId: null, afterTaskId: null, operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11", expectedVersion: 2 }, repository: { transact: operation => operation(tx) }, ranks }),
    relocate: () => prepareTaskRelocation({ taskId: task.id, expectedProjectId: "project", toColumnId: to, port, ranks }),
  };
}

describe.each(["move", "relocate"] as const)("DONE route guard: %s", caller => {
  it.each([["todo", "done"], ["done", "doing"]])("rejects %s -> %s before writes", async (from, to) => {
    const f = fixture(from, to);
    await expect(f[caller]()).rejects.toMatchObject({ code: "INVALID_MOVE_ROUTE" });
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each([["doing", "done", "DONE"], ["todo", "doing", "IN_PROGRESS"]])("allows %s -> %s", async (from, to, status) => {
    const f = fixture(from, to);
    await expect(f[caller]()).resolves.toMatchObject(caller === "move" ? { task: { columnId: to, status, version: 3 } } : { columnId: to, status });
  });

  it("checks the source workflow key even if task.status is stale", async () => {
    const f = fixture("done", "doing");
    f.task.status = "TODO";
    await expect(f[caller]()).rejects.toMatchObject({ code: "INVALID_MOVE_ROUTE" });
    expect(f.write).not.toHaveBeenCalled();
  });

  it("permits same-column DONE ordering without reopening", async () => {
    const f = fixture("done", "done");
    await expect(f[caller]()).resolves.toMatchObject(caller === "move"
      ? { task: { columnId: "done", status: "DONE" } }
      : { columnId: "done", status: "DONE" });
  });

  it("fails closed when DONE has no database predecessor", async () => {
    const f = fixture("doing", "done");
    const getColumn = async (id: string) => {
      const column = columns.find(c => c.id === id);
      return column ? { ...column, precedingColumnId: null } : null;
    };
    f.tx.getColumnForUpdate = getColumn;
    f.port.getColumnIdentity = getColumn;
    await expect(f[caller]()).rejects.toMatchObject({ code: "INVALID_MOVE_ROUTE" });
    expect(f.write).not.toHaveBeenCalled();
  });
});

it("relocation rechecks the destination route after acquiring the project lock", async () => {
  const f = fixture("doing", "done");
  let locked = false;
  f.port.lockColumn = async () => { locked = true; };
  f.port.getColumnIdentity = async id => {
    const column = columns.find(c => c.id === id);
    return column ? { ...column, precedingColumnId: locked ? "todo" : "doing" } : null;
  };
  await expect(f.relocate()).rejects.toMatchObject({ code: "INVALID_MOVE_ROUTE" });
  expect(f.write).not.toHaveBeenCalled();
});
