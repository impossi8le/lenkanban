import {
  Prisma,
  type PrismaClient,
  type Task,
} from "@prisma/client";
import { formatRank } from "../rank/rank-service";
import { logActivityWithClient } from "@/lib/activity-logger";
import { getProjectAccess } from "@/lib/project-access";
import { getProjectStatusPolicy, lockProjectStatusAuthority } from "@/lib/project-status-policy";
import { readTaskRequestDecision, readTaskRequestBatchDecision } from "@/lib/task-request-guard";
import { MoveTaskError } from "./move-errors";
import type {
  MovableTask,
  MoveTaskRepository,
  MoveTaskTransaction,
  OrderedTaskUpdate,
} from "./move-task-service";

export interface PrismaMoveRepositoryContext {
  taskId: string;
  toColumnId: string;
  operationId: string;
  actorId: string;
}

interface TaskIdentity {
  id: string;
  projectId: string;
  columnId: string;
}

interface ColumnIdentity {
  id: string;
  projectId: string;
}

class MoveLockIdentityChangedError extends Error {
  readonly code = "40001";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function errorMeta(error: unknown): unknown {
  return typeof error === "object" && error !== null && "meta" in error
    ? error.meta
    : undefined;
}

function errorCause(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error
    ? error.cause
    : undefined;
}

function metaValue(error: unknown, key: string): unknown {
  const meta = errorMeta(error);
  return typeof meta === "object" && meta !== null && key in meta
    ? meta[key as keyof typeof meta]
    : undefined;
}

function uniqueTargetMatches(
  error: unknown,
  fields: readonly string[],
  constraint: string,
): boolean {
  const target = metaValue(error, "target");
  return Array.isArray(target)
    ? target.length === fields.length &&
        target.every((field, index) => field === fields[index])
    : target === constraint;
}

function isSerializationFailure(error: unknown): boolean {
  if (errorCode(error) === "P2034" || errorCode(error) === "40001") {
    return true;
  }
  const meta = errorMeta(error);
  if (
    typeof meta === "object" &&
    meta !== null &&
    "code" in meta &&
    meta.code === "40001"
  ) {
    return true;
  }
  return errorCode(errorCause(error)) === "40001";
}

function isRankUniqueConflict(error: unknown): boolean {
  const serialized = JSON.stringify({
    code: errorCode(error),
    meta: errorMeta(error),
    cause: errorCause(error),
  });
  if (errorCode(error) === "P2002") {
    return (
      metaValue(error, "modelName") === "Task" &&
      uniqueTargetMatches(
        error,
        ["projectId", "columnId", "rank"],
        "Task_projectId_columnId_rank_key",
      )
    );
  }
  return (
    errorCode(error) === "23505" &&
    serialized.includes("Task_projectId_columnId_rank_key")
  );
}

function isOperationUniqueConflict(error: unknown): boolean {
  return (
    errorCode(error) === "P2002" &&
    metaValue(error, "modelName") === "TaskMoveOperation" &&
    uniqueTargetMatches(
      error,
      ["operationId"],
      "TaskMoveOperation_operationId_key",
    )
  );
}

export function isRetryableMoveConflict(error: unknown): boolean {
  return (
    isSerializationFailure(error) ||
    isRankUniqueConflict(error) ||
    isOperationUniqueConflict(error)
  );
}

async function acquireMoveLocks(
  tx: Prisma.TransactionClient,
  context: PrismaMoveRepositoryContext,
): Promise<void> {
  const tasks = await tx.$queryRaw<TaskIdentity[]>`
    SELECT "id", "projectId", "columnId"
    FROM "Task"
    WHERE "id" = ${context.taskId}
  `;
  const task = tasks[0];
  if (!task) {
    return;
  }

  let destinationColumns = await tx.$queryRaw<ColumnIdentity[]>`
    SELECT "id", "projectId"
    FROM "ProjectColumn"
    WHERE "id" = ${context.toColumnId}
  `;
  const destinationColumn = destinationColumns[0];
  const projectIds = [
    ...new Set(
      [task.projectId, destinationColumn?.projectId].filter(
        (projectId): projectId is string => projectId !== undefined,
      ),
    ),
  ].toSorted();
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Project"
    WHERE "id" IN (${Prisma.join(projectIds)})
    ORDER BY "id"
    FOR UPDATE
  `;

  const currentTasks = await tx.$queryRaw<TaskIdentity[]>`
    SELECT "id", "projectId", "columnId"
    FROM "Task"
    WHERE "id" = ${context.taskId}
  `;
  const currentTask = currentTasks[0];
  if (!currentTask) {
    return;
  }
  destinationColumns = await tx.$queryRaw<ColumnIdentity[]>`
    SELECT "id", "projectId"
    FROM "ProjectColumn"
    WHERE "id" = ${context.toColumnId}
  `;
  const currentDestinationColumn = destinationColumns[0];
  if (
    !projectIds.includes(currentTask.projectId) ||
    (currentDestinationColumn &&
      !projectIds.includes(currentDestinationColumn.projectId))
  ) {
    throw new MoveLockIdentityChangedError(
      "Move lock identity changed while acquiring the project lock",
    );
  }
  const columnIds = [
    ...new Set(
      [currentTask.columnId, currentDestinationColumn?.id].filter(
        (columnId): columnId is string => columnId !== undefined,
      ),
    ),
  ].toSorted();
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "ProjectColumn"
    WHERE "id" IN (${Prisma.join(columnIds)})
    ORDER BY "id"
    FOR UPDATE
  `;

  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Task"
    WHERE "columnId" IN (${Prisma.join(columnIds)})
    ORDER BY "id"
    FOR UPDATE
  `;
}

function toMovableTask(
  task: Pick<
    Task,
    "id" | "projectId" | "columnId" | "rank" | "version" | "status"
  >,
): MovableTask {
  return task;
}

function temporaryRank(index: number): string {
  return `~${formatRank(BigInt(index + 1)).slice(1)}`;
}

function createTransactionPort(
  tx: Prisma.TransactionClient,
  context: PrismaMoveRepositoryContext,
): MoveTaskTransaction {
  const actorId = context.actorId;
  return {
    async assertLegacyMoveAllowed(taskId) {
      if (taskId !== context.taskId) throw new MoveTaskError("TASK_NOT_FOUND");
      const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, columnId: true } });
      if (!task) throw new MoveTaskError("TASK_NOT_FOUND");
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true } });
      if (!actor || !(await getProjectAccess(actor, task.projectId, tx)).canWrite) throw new MoveTaskError("TASK_NOT_FOUND");
      if (actor.globalRole !== "ADMIN" && !(await lockProjectStatusAuthority(tx, actor.id, task.projectId))) throw new MoveTaskError("TASK_NOT_FOUND");
      if (!(await getProjectStatusPolicy(actor, task.projectId, tx)).canChangeStatus) throw new MoveTaskError("TASK_NOT_FOUND");
      const decision = await readTaskRequestDecision(tx, task.id);
      if (!decision.allowed) throw new MoveTaskError(decision.code);
    },
    async getOperation(operationId) {
      const operation = await tx.taskMoveOperation.findUnique({
        where: { operationId },
        select: {
          operationId: true,
          requestHash: true,
          response: true,
        },
      });
      return operation
        ? {
            operationId: operation.operationId,
            requestHash: operation.requestHash,
            response: operation.response as never,
          }
        : null;
    },
    async getTaskForUpdate(taskId) {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          projectId: true,
          columnId: true,
          rank: true,
          version: true,
          status: true,
        },
      });
      return task ? toMovableTask(task) : null;
    },
    async getColumnForUpdate(columnId) {
      const column = await tx.projectColumn.findUnique({
        where: { id: columnId },
        select: {
          id: true,
          projectId: true,
          name: true,
          workflowKey: true,
          position: true,
        },
      });
      if (!column || column.workflowKey !== "DONE") return column;
      const preceding = await tx.projectColumn.findFirst({
        where: { projectId: column.projectId, position: { lt: column.position } },
        orderBy: [{ position: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      return { ...column, precedingColumnId: preceding?.id ?? null };
    },
    async getOrderedColumnTasksForUpdate(columnId) {
      const tasks = await tx.task.findMany({
        where: { columnId },
        orderBy: [{ rank: "asc" }, { id: "asc" }],
        select: {
          id: true,
          projectId: true,
          columnId: true,
          rank: true,
          version: true,
          status: true,
        },
      });
      return tasks.map(toMovableTask);
    },
    async writeRanksAndCompatibilityPositions(updates) {
      const decision = await readTaskRequestBatchDecision(tx, updates.map(update => update.taskId));
      if (!decision.allowed) throw new MoveTaskError(decision.code);
      await writeTemporaryRanks(tx, updates);
      for (const update of updates) {
        await tx.task.update({
          where: { id: update.taskId },
          data: { rank: update.rank },
        });
      }
    },
    async updateMovedTask(input) {
      const updateResult = await tx.task.updateMany({
        where: {
          id: input.taskId,
          version: input.expectedVersion,
        },
        data: {
          columnId: input.toColumnId,
          status: input.status,
          version: { increment: 1 },
        },
      });
      if (updateResult.count !== 1) {
        throw new MoveTaskError("STALE_TASK_VERSION");
      }
      const task = await tx.task.findUniqueOrThrow({
        where: { id: input.taskId },
        select: {
          id: true,
          projectId: true,
          columnId: true,
          rank: true,
          version: true,
          status: true,
        },
      });
      return toMovableTask(task);
    },
    async incrementBoardRevision(projectId) {
      const project = await tx.project.update({
        where: { id: projectId },
        data: { boardRevision: { increment: 1 } },
        select: { boardRevision: true },
      });
      return project.boardRevision;
    },
    async storeOperation(input) {
      await tx.taskMoveOperation.create({
        data: {
          operationId: input.operationId,
          taskId: input.taskId,
          projectId: input.projectId,
          requestHash: input.requestHash,
          response: input.response as unknown as Prisma.InputJsonValue,
        },
      });
    },
    async writeMoveActivity(input) {
      await logActivityWithClient(tx, {
        taskId: input.taskId,
        userId: actorId,
        action: "moved",
        oldValue: {
          columnId: input.fromColumnId,
          columnName: input.fromColumnName,
          status: input.oldStatus,
        },
        newValue: {
          columnId: input.toColumnId,
          columnName: input.toColumnName,
          status: input.newStatus,
        },
      });
    },
  };
}

async function writeTemporaryRanks(
  tx: Prisma.TransactionClient,
  updates: readonly OrderedTaskUpdate[],
): Promise<void> {
  for (const [index, update] of updates.entries()) {
    await tx.task.update({
      where: { id: update.taskId },
      data: {
        columnId: update.columnId,
        rank: temporaryRank(index),
        position: update.position,
      },
    });
  }
}

export class PrismaMoveRepository implements MoveTaskRepository {
  constructor(
    private readonly client: PrismaClient,
    private readonly context: PrismaMoveRepositoryContext,
  ) {}

  async transact<T>(
    operation: (tx: MoveTaskTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.$transaction(
          async (tx) => {
            await acquireMoveLocks(tx, this.context);
            return operation(
              createTransactionPort(tx, this.context),
            );
          },
          {
            isolationLevel:
              Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 15_000,
          },
        );
      } catch (error) {
        if (attempt === 3 || !isRetryableMoveConflict(error)) {
          throw error;
        }
      }
    }

    throw new Error(
      `Move operation ${this.context.operationId} exhausted retries`,
    );
  }
}
