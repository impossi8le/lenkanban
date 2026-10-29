import { describe, expect, it, vi } from "vitest";
import { createBase36RankService } from "../rank/rank-service";
import type { MoveTaskResponse } from "./move-contract";
import { MoveTaskError } from "./move-errors";
import { moveTask } from "./move-task-service";
import {
  isRetryableMoveConflict,
  PrismaMoveRepository,
} from "./prisma-move-repository";

const operationId = "b1e62929-6741-4860-a6a3-5f90b82d5a11";
const requestHash =
  "d48206f7185da9ca76ffbc712667c28c4996ceb9c7ffacc92cca74c49b4c26f1";
const storedResponse: MoveTaskResponse = {
  operationId,
  boardRevision: 8,
  task: {
    id: "task-1",
    columnId: "doing",
    version: 3,
    status: "IN_PROGRESS",
  },
};

function operationConflict() {
  return {
    code: "P2002",
    meta: {
      modelName: "TaskMoveOperation",
      target: ["operationId"],
    },
  };
}

function lockedTransaction(storedHash: string) {
  return {
    task: { async findUnique() { return { id: "task-1", projectId: "project-1", columnId: "todo" }; } },
    // Replay still passes real common authorization; OWN denies legacy USER writers.
    user: { async findUnique() { return { id: "user-1", globalRole: "ADMIN" }; } },
    project: { async findUnique() { return { id: "project-1", ownerId: "user-1", members: [] }; } },
    taskRequest: { async findUnique() { return null; }, async findMany() { return []; } },
    async $queryRaw(query: TemplateStringsArray) {
      const sql = query.join("?");
      if (
        sql.includes('FROM "Task"') &&
        !sql.includes("FOR UPDATE")
      ) {
        return [
          {
            id: "task-1",
            projectId: "project-1",
            columnId: "todo",
          },
        ];
      }
      if (
        sql.includes('FROM "ProjectColumn"') &&
        !sql.includes("FOR UPDATE")
      ) {
        return [{ id: "doing", projectId: "project-1" }];
      }
      return [{ id: "locked" }];
    },
    taskMoveOperation: {
      async findUnique() {
        return {
          operationId,
          requestHash: storedHash,
          response: storedResponse,
        };
      },
    },
  };
}

function repositoryWithClient(client: unknown): PrismaMoveRepository {
  return new PrismaMoveRepository(client as never, {
    taskId: "task-1",
    toColumnId: "doing",
    operationId,
    actorId: "user-1",
  });
}

function replayMove(repository: PrismaMoveRepository) {
  return moveTask({
    taskId: "task-1",
    request: {
      toColumnId: "doing",
      beforeTaskId: "task-2",
      afterTaskId: null,
      operationId,
      expectedVersion: 2,
    },
    repository,
    ranks: createBase36RankService(),
  });
}

describe("Prisma move conflict classification", () => {
  it("reads the DONE predecessor from database position within the same project", async () => {
    const findUnique = vi.fn(async () => ({ id: "done", projectId: "project-1", name: "Закрыта", workflowKey: "DONE", position: 90 }));
    const findFirst = vi.fn(async () => ({ id: "resolved" }));
    const tx = { ...lockedTransaction(requestHash), projectColumn: { findUnique, findFirst } };
    const repository = repositoryWithClient({ $transaction: (operation: (port: typeof tx) => Promise<unknown>) => operation(tx) });
    await expect(repository.transact(port => port.getColumnForUpdate("done"))).resolves.toMatchObject({ precedingColumnId: "resolved" });
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "done" }, select: { id: true, projectId: true, name: true, workflowKey: true, position: true } });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({ where: { projectId: "project-1", position: { lt: 90 } }, orderBy: [{ position: "desc" }, { id: "desc" }], select: { id: true } });
  });

  it("returns no predecessor when DONE is the first project column", async () => {
    const tx = { ...lockedTransaction(requestHash), projectColumn: {
      findUnique: async () => ({ id: "done", projectId: "project-1", name: "Закрыта", workflowKey: "DONE", position: 10 }),
      findFirst: async () => null,
    } };
    const repository = repositoryWithClient({ $transaction: (operation: (port: typeof tx) => Promise<unknown>) => operation(tx) });
    await expect(repository.transact(port => port.getColumnForUpdate("done"))).resolves.toMatchObject({ precedingColumnId: null });
  });
  it("retries the exact globally unique move operation conflict", () => {
    expect(
      isRetryableMoveConflict({
        code: "P2002",
        meta: {
          modelName: "TaskMoveOperation",
          target: "TaskMoveOperation_operationId_key",
        },
      }),
    ).toBe(true);
  });

  it("retries an operationId field target reported by Prisma", () => {
    expect(
      isRetryableMoveConflict({
        code: "P2002",
        meta: {
          modelName: "TaskMoveOperation",
          target: ["operationId"],
        },
      }),
    ).toBe(true);
  });

  it("keeps task rank unique conflicts retryable", () => {
    expect(
      isRetryableMoveConflict({
        code: "P2002",
        meta: {
          modelName: "Task",
          target: ["projectId", "columnId", "rank"],
        },
      }),
    ).toBe(true);
  });

  it("keeps the exact task rank constraint retryable", () => {
    expect(
      isRetryableMoveConflict({
        code: "P2002",
        meta: {
          modelName: "Task",
          target: "Task_projectId_columnId_rank_key",
        },
      }),
    ).toBe(true);
  });

  it.each([
    {
      code: "P2002",
      meta: {
        modelName: "TaskMoveOperation",
        target: ["requestHash"],
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "User",
        target: ["operationId"],
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "Project",
        target: ["name"],
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "TaskMoveOperation",
        target: "Other_operationId_key",
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "TaskMoveOperation",
        target: ["operationId", "requestHash"],
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "Task",
        target: ["rank"],
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "Task",
        target: ["projectId", "rank"],
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "Task",
        target: ["projectId", "columnId", "rank", "version"],
      },
    },
    {
      code: "P2002",
      meta: {
        modelName: "Task",
        target: ["rank", "columnId", "projectId"],
      },
    },
  ])("does not retry an unrelated P2002: %o", (error) => {
    expect(isRetryableMoveConflict(error)).toBe(false);
  });
});

describe("Prisma move transaction retries", () => {
  it("reruns an exact operation conflict and returns the stored replay", async () => {
    let attempts = 0;
    let operationReads = 0;
    const transaction = lockedTransaction(requestHash);
    const originalFindUnique = transaction.taskMoveOperation.findUnique;
    transaction.taskMoveOperation.findUnique = async () => {
      operationReads += 1;
      return originalFindUnique();
    };
    const client = {
      async $transaction(
        operation: (tx: typeof transaction) => Promise<unknown>,
      ) {
        attempts += 1;
        const result = await operation(transaction);
        if (attempts === 1) {
          throw operationConflict();
        }
        return result;
      },
    };

    await expect(
      replayMove(repositoryWithClient(client)),
    ).resolves.toEqual(storedResponse);
    expect(attempts).toBe(2);
    expect(operationReads).toBe(2);
  });

  it("reruns an exact operation conflict into the typed reuse path", async () => {
    let attempts = 0;
    const transaction = lockedTransaction("different-request-hash");
    const client = {
      async $transaction(
        operation: (tx: typeof transaction) => Promise<unknown>,
      ) {
        attempts += 1;
        if (attempts === 1) {
          throw operationConflict();
        }
        return operation(transaction);
      },
    };

    await expect(
      replayMove(repositoryWithClient(client)),
    ).rejects.toEqual(new MoveTaskError("OPERATION_ID_REUSED"));
    expect(attempts).toBe(2);
  });

  it("does not retry an unrelated P2002", async () => {
    let attempts = 0;
    const unrelatedError = {
      code: "P2002",
      meta: {
        modelName: "TaskMoveOperation",
        target: ["operationId", "requestHash"],
      },
    };
    const client = {
      async $transaction() {
        attempts += 1;
        throw unrelatedError;
      },
    };

    await expect(
      repositoryWithClient(client).transact(async () => "unreachable"),
    ).rejects.toBe(unrelatedError);
    expect(attempts).toBe(1);
  });

  it("stops after three retryable transaction attempts", async () => {
    let attempts = 0;
    const finalError = operationConflict();
    const client = {
      async $transaction() {
        attempts += 1;
        throw finalError;
      },
    };

    await expect(
      repositoryWithClient(client).transact(async () => "unreachable"),
    ).rejects.toBe(finalError);
    expect(attempts).toBe(3);
  });
});
