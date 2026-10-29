import { describe, expect, it, vi } from "vitest";
import { createBase36RankService } from "../rank/rank-service";
import {
  createTaskRelocationPort,
  prepareTaskRelocation,
  TaskRelocationError,
  type TaskRelocationPort,
  validateColumnDerivedStatusUpdate,
} from "./task-relocation";
import * as relocationModule from "./task-relocation";

function expectRelocationError(
  operation: () => unknown,
  code: TaskRelocationError["code"],
) {
  try {
    operation();
    throw new Error("Expected relocation error");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskRelocationError);
    expect((error as TaskRelocationError).code).toBe(code);
  }
}

describe("task relocation", () => {
  const ranks = createBase36RankService();

  it("rejects a standalone status change", () => {
    expectRelocationError(
      () =>
        validateColumnDerivedStatusUpdate({
          status: "DONE",
        }),
      "STATUS_REQUIRES_COLUMN",
    );
  });

  it("allows unrelated updates and column-derived status updates", () => {
    expect(() =>
      validateColumnDerivedStatusUpdate({ priority: "HIGH" }),
    ).not.toThrow();
    expect(() =>
      validateColumnDerivedStatusUpdate({
        status: "DONE",
        columnId: "column-2",
      }),
    ).not.toThrow();
  });

  it("rejects a target column from another project before rank allocation", async () => {
    const port: TaskRelocationPort = {
      async assertLegacyMoveAllowed() {},
      async lockTask() {
        throw new Error("mismatched moves must not lock task");
      },
      async getColumnIdentity() {
        return {
          id: "column-2",
          projectId: "project-2",
          name: "Чужая",
          workflowKey: "DONE",
        };
      },
      async getLastPosition() {
        throw new Error("mismatched moves must not read position");
      },
      async lockColumn() {
        throw new Error("mismatched moves must not lock rank");
      },
      async getLastRank() {
        throw new Error("mismatched moves must not read rank");
      },
      async rebalanceColumn() {
        throw new Error("mismatched moves must not rebalance");
      },
    };

    await expect(
      prepareTaskRelocation({
        taskId: "task-1",
        expectedProjectId: "project-1",
        toColumnId: "column-2",
        port,
        ranks,
      }),
    ).rejects.toMatchObject({ code: "COLUMN_PROJECT_MISMATCH" });
  });

  it("allocates destination append rank and compatibility position", async () => {
    const events: string[] = [];
    const port: TaskRelocationPort = {
      async assertLegacyMoveAllowed() { events.push("preflight"); },
      async lockTask() {
        events.push("task");
        return {
          id: "task-1",
          projectId: "project-1",
          columnId: "column-1",
          status: "TODO",
          version: 4,
        };
      },
      async getColumnIdentity(columnId) {
        events.push("column");
        return {
          id: columnId,
          projectId: "project-1",
          name: "Доставка",
          workflowKey: "COLUMN_column-2",
        };
      },
      async lockColumn() {
        events.push("lock");
      },
      async getLastRank() {
        events.push("rank");
        return "0|HZZZZZZZZZZZZZZZZZZZ";
      },
      async rebalanceColumn() {
        throw new Error("available rank space must not rebalance");
      },
      async getLastPosition() {
        events.push("position");
        return 2048;
      },
    };

    await expect(
      prepareTaskRelocation({
        taskId: "task-1",
        expectedProjectId: "project-1",
        toColumnId: "column-2",
        port,
        ranks,
      }),
    ).resolves.toEqual({
      columnId: "column-2",
      status: "COLUMN_column-2",
      rank: "0|QZZZZZZZZZZZZZZZZZZZ",
      position: 3072,
    });
    expect(events).toEqual(["column", "lock", "task", "preflight", "column", "column", "rank", "position"]);
  });

  it("derives status without replacing rank when the column is unchanged", async () => {
    const port: TaskRelocationPort = {
      async assertLegacyMoveAllowed() {},
      async lockTask() {
        return {
          id: "task-1",
          projectId: "project-1",
          columnId: "column-1",
          status: "IN_REVIEW",
          version: 4,
        };
      },
      async getColumnIdentity() {
        return {
          id: "column-1",
          projectId: "project-1",
          name: "На проверке",
          workflowKey: "REVIEW",
        };
      },
      async getLastPosition() {
        throw new Error("same-column updates must not append position");
      },
      async lockColumn() {},
      async getLastRank() {
        throw new Error("same-column updates must not read rank");
      },
      async rebalanceColumn() {
        throw new Error("same-column updates must not rebalance");
      },
    };

    await expect(
      prepareTaskRelocation({
        taskId: "task-1",
        expectedProjectId: "project-1",
        toColumnId: "column-1",
        port,
        ranks,
      }),
    ).resolves.toEqual({
      columnId: "column-1",
      status: "IN_REVIEW",
    });
  });

  it("reports missing tasks and columns with stable error codes", async () => {
    const missingTaskPort: TaskRelocationPort = {
      async assertLegacyMoveAllowed() {},
      async lockTask() {
        return null;
      },
      async getColumnIdentity() {
        return {
          id: "column-1",
          projectId: "project-1",
          name: "Триаж",
          workflowKey: "TODO",
        };
      },
      async getLastPosition() {
        throw new Error("missing tasks must stop");
      },
      async lockColumn() {},
      async getLastRank() {
        return null;
      },
      async rebalanceColumn() {
        return [];
      },
    };
    await expect(
      prepareTaskRelocation({
        taskId: "missing",
        expectedProjectId: "project-1",
        toColumnId: "column-1",
        port: missingTaskPort,
        ranks,
      }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });

    const missingColumnPort: TaskRelocationPort = {
      ...missingTaskPort,
      async lockTask() {
        return {
          id: "task-1",
          projectId: "project-1",
          columnId: "column-1",
          status: "TODO",
          version: 4,
        };
      },
      async getColumnIdentity() {
        return null;
      },
    };
    await expect(
      prepareTaskRelocation({
        taskId: "task-1",
        expectedProjectId: "project-1",
        toColumnId: "missing",
        port: missingColumnPort,
        ranks,
      }),
    ).rejects.toMatchObject({ code: "COLUMN_NOT_FOUND" });
  });

  it("adapts a Prisma transaction to locked task relocation reads", async () => {
    const client = {
      async $queryRaw(query: TemplateStringsArray, value: string) {
        const sql = query.join("?");
        if (sql.includes('FROM "Task"')) {
          return [
            {
              id: value,
              projectId: "project-1",
              columnId: "column-1",
            },
          ];
        }
        if (sql.includes('FROM "ProjectColumn"')) {
          return [
            {
              id: value,
              projectId: "project-1",
              workflowKey: "DONE",
            },
          ];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      task: {
        async findFirst(input: {
          orderBy: { rank?: "desc"; position?: "desc" };
        }) {
          if ("position" in input.orderBy) {
            return { position: 2048 };
          }
          return { rank: "0|HZZZZZZZZZZZZZZZZZZZ" };
        },
        async findMany() {
          return [];
        },
        async update() {
          return {};
        },
      },
    };
    const port = createTaskRelocationPort(client as never, ranks, "actor");

    await expect(port.lockTask("task-1", "project-1")).resolves.toEqual({
      id: "task-1",
      projectId: "project-1",
      columnId: "column-1",
    });
    await expect(port.getColumnIdentity("column-2")).resolves.toEqual({
      id: "column-2",
      projectId: "project-1",
      workflowKey: "DONE",
    });
    await expect(port.getLastPosition("column-2")).resolves.toBe(2048);
  });

  it("locks column through its project before locking the task and reading ranks", async () => {
    const events: string[] = [];
    const port = {
      async assertLegacyMoveAllowed() { events.push("preflight"); },
      async getColumnIdentity(columnId: string) {
        if (columnId === "column-1") {
          return { id: columnId, projectId: "project-1", workflowKey: "IN_PROGRESS", position: 10 };
        }
        events.push("column:read");
        return { id: columnId, projectId: "project-1", workflowKey: "DONE", position: 30, precedingColumnId: "column-1" };
      },
      async lockColumn() {
        events.push("project-column:lock");
      },
      async lockTask() {
        events.push("task:lock");
        return { projectId: "project-1", columnId: "column-1" };
      },
      async getLastRank() {
        events.push("rank:read");
        return null;
      },
      async rebalanceColumn() {
        return [];
      },
      async getLastPosition() {
        events.push("position:read");
        return null;
      },
    };

    await prepareTaskRelocation({
      taskId: "task-1",
      expectedProjectId: "project-1",
      toColumnId: "column-2",
      port: port as never,
      ranks,
    });

    expect(events).toEqual([
      "column:read",
      "project-column:lock",
      "task:lock",
      "preflight",
      "column:read",
      "rank:read",
      "position:read",
    ]);
  });

  it("does not advance versions or board revision for a same-column no-op", async () => {
    expect(relocationModule).toHaveProperty("relocateTaskToColumn");
    if (!("relocateTaskToColumn" in relocationModule)) return;

    const updateRelocatedTask = vi.fn();
    const incrementBoardRevision = vi.fn();
    const writeMoveActivity = vi.fn();
    const port = {
      async assertLegacyMoveAllowed() {},
      async getColumnIdentity() {
        return {
          id: "column-1",
          projectId: "project-1",
          name: "Триаж",
          workflowKey: "COLUMN_column-1",
        };
      },
      async lockColumn() {},
      async lockTask() {
        return {
          id: "task-1",
          projectId: "project-1",
          columnId: "column-1",
          status: "COLUMN_column-1",
          version: 4,
        };
      },
      async getLastRank() {
        throw new Error("no-op must not allocate rank");
      },
      async rebalanceColumn() {
        throw new Error("no-op must not rebalance");
      },
      async getLastPosition() {
        throw new Error("no-op must not allocate position");
      },
      updateRelocatedTask,
      incrementBoardRevision,
      writeMoveActivity,
    };

    const result = await (
      relocationModule.relocateTaskToColumn as (
        input: Record<string, unknown>,
      ) => Promise<unknown>
    )({
      taskId: "task-1",
      expectedProjectId: "project-1",
      toColumnId: "column-1",
      expectedVersion: 4,
      operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11",
      port,
      ranks,
    });

    expect(result).toBeNull();
    expect(updateRelocatedTask).not.toHaveBeenCalled();
    expect(incrementBoardRevision).not.toHaveBeenCalled();
    expect(writeMoveActivity).not.toHaveBeenCalled();
  });

  it("records canonical source and destination column names for an append relocation", async () => {
    const writeMoveActivity = vi.fn().mockResolvedValue(undefined);
    const port = {
      async assertLegacyMoveAllowed() {},
      async getColumnIdentity(columnId: string) {
        return columnId === "column-1"
          ? {
              id: "column-1",
              projectId: "project-1",
              name: "Триаж",
              workflowKey: "COLUMN_column-1",
            }
          : {
              id: "column-2",
              projectId: "project-1",
              name: "Доставка",
              workflowKey: "COLUMN_column-2",
            };
      },
      async lockColumn() {},
      async lockTask() {
        return {
          id: "task-1",
          projectId: "project-1",
          columnId: "column-1",
          status: "COLUMN_column-1",
          version: 4,
        };
      },
      async getLastRank() {
        return "0|HZZZZZZZZZZZZZZZZZZZ";
      },
      async rebalanceColumn() {
        return [];
      },
      async getLastPosition() {
        return 2048;
      },
      async updateRelocatedTask() {
        return {
          id: "task-1",
          columnId: "column-2",
          status: "COLUMN_column-2",
          version: 5,
        };
      },
      async incrementBoardRevision() {
        return 8;
      },
      writeMoveActivity,
    };

    await relocationModule.relocateTaskToColumn({
      taskId: "task-1",
      expectedProjectId: "project-1",
      toColumnId: "column-2",
      expectedVersion: 4,
      operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11",
      port,
      ranks,
    });

    expect(writeMoveActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        fromColumnId: "column-1",
        fromColumnName: "Триаж",
        toColumnId: "column-2",
        toColumnName: "Доставка",
      }),
    );
  });
});
