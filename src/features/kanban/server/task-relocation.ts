import type { Prisma } from "@prisma/client";
import type { RankService } from "../rank/rank-service";
import type { MoveTaskResponse } from "./move-contract";
import { logActivityWithClient } from "@/lib/activity-logger";
import { getProjectAccess } from "@/lib/project-access";
import { getProjectStatusPolicy, lockProjectStatusAuthority } from "@/lib/project-status-policy";
import { readTaskRequestDecision, readTaskRequestBatchDecision } from "@/lib/task-request-guard";
import {
  allocateAppendRankAfterLock,
  createAppendTaskRankPort,
  type AppendTaskRankPort,
  type TaskRankClient,
} from "./append-task-rank";
import { derivedTaskStatus, isPlainMoveRouteAllowed, type WorkflowMoveColumn } from "./move-contract";

export type TaskRelocationErrorCode =
  | "STATUS_REQUIRES_COLUMN"
  | "TASK_NOT_FOUND"
  | "COLUMN_NOT_FOUND"
  | "COLUMN_PROJECT_MISMATCH"
  | "STALE_TASK_VERSION"
  | "INVALID_MOVE_ROUTE"
  | "REQUEST_LIFECYCLE_NOT_ENABLED"
  | "INVALID_REQUEST_MARKER";

export class TaskRelocationError extends Error {
  constructor(readonly code: TaskRelocationErrorCode) {
    super(code);
    this.name = "TaskRelocationError";
  }
}

export interface TaskRelocationPort extends AppendTaskRankPort {
  assertLegacyMoveAllowed(taskId: string, projectId: string, toColumnId: string): Promise<void>;
  lockTask(
    taskId: string,
    expectedProjectId: string,
  ): Promise<{
    id: string;
    projectId: string;
    columnId: string;
    status: string;
    version: number;
  } | null>;
  getColumnIdentity(
    columnId: string,
  ): Promise<WorkflowMoveColumn & {
    name: string;
  } | null>;
  getLastPosition(columnId: string): Promise<number | null>;
}

export interface CanonicalTaskRelocationPort
  extends TaskRelocationPort {
  updateRelocatedTask(input: {
    taskId: string;
    expectedVersion: number;
    update: TaskRelocationUpdate;
  }): Promise<{
    id: string;
    columnId: string;
    version: number;
    status: string;
  } | null>;
  incrementBoardRevision(projectId: string): Promise<number>;
  writeMoveActivity(input: {
    taskId: string;
    fromColumnId: string;
    fromColumnName: string;
    toColumnId: string;
    toColumnName: string;
    oldStatus: string;
    newStatus: string;
  }): Promise<void>;
}

export interface TaskRelocationUpdate {
  columnId: string;
  status: string;
  rank?: string;
  position?: number;
}

export function createTaskRelocationPort(
  client: Prisma.TransactionClient,
  ranks: RankService,
  actorId: string,
): TaskRelocationPort {
  const lockedTasks = new Map<string, { id: string; projectId: string; columnId: string }>();
  const lockedDestinationTasks = new Map<string, Set<string>>();
  // The existing rank helper calls findMany immediately before its temporary
  // writes. Guard that exact returned set, without copying the rank algorithm.
  const rankClient: TaskRankClient = {
    $queryRaw: (query, ...values) => client.$queryRaw(query, ...values),
    task: {
      findFirst: input => client.task.findFirst(input),
      findMany: async input => {
        const tasks = await client.task.findMany(input);
        const locked = lockedDestinationTasks.get(input.where.columnId);
        if (!locked || tasks.some(task => !locked.has(task.id))) throw new TaskRelocationError("STALE_TASK_VERSION");
        const decision = await readTaskRequestBatchDecision(client, tasks.map(task => task.id));
        if (!decision.allowed) throw new TaskRelocationError(decision.code);
        return tasks;
      },
      update: input => client.task.update(input),
    },
  };
  const rankPort = createAppendTaskRankPort(rankClient, ranks);

  return {
    ...rankPort,
    async assertLegacyMoveAllowed(taskId, projectId, toColumnId) {
      const task = lockedTasks.get(taskId);
      if (!task || task.projectId !== projectId) throw new TaskRelocationError("TASK_NOT_FOUND");
      if (task.columnId !== toColumnId) {
        // Potential rebalance resources are locked before actor SHARE. The
        // later helper reuses these locks and checks its actual write set.
        const destinationTasks = await client.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Task" WHERE "columnId" = ${toColumnId} ORDER BY "id" FOR UPDATE
        `;
        lockedDestinationTasks.set(toColumnId, new Set(destinationTasks.map(row => row.id)));
      }
      await client.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      const actor = await client.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true } });
      if (!actor || !(await getProjectAccess(actor, projectId, client)).canWrite) throw new TaskRelocationError("TASK_NOT_FOUND");
      if (actor.globalRole !== "ADMIN" && !(await lockProjectStatusAuthority(client, actor.id, projectId))) throw new TaskRelocationError("TASK_NOT_FOUND");
      if (!(await getProjectStatusPolicy(actor, projectId, client)).canChangeStatus) throw new TaskRelocationError("TASK_NOT_FOUND");
      const decision = await readTaskRequestDecision(client, taskId);
      if (!decision.allowed) throw new TaskRelocationError(decision.code);
    },
    async lockTask(taskId, expectedProjectId) {
      const tasks = await client.$queryRaw<
        Array<{
          id: string;
          projectId: string;
          columnId: string;
          status: string;
          version: number;
        }>
      >`
        SELECT "id", "projectId", "columnId", "status", "version"
        FROM "Task"
        WHERE "id" = ${taskId}
          AND "projectId" = ${expectedProjectId}
        FOR UPDATE
      `;
      const task = tasks[0] ?? null;
      if (task) lockedTasks.set(taskId, task);
      return task;
    },
    async getColumnIdentity(columnId) {
      const columns = await client.$queryRaw<
        Array<{
          id: string;
          projectId: string;
          name: string;
          workflowKey: string;
          precedingColumnId: string | null;
        }>
      >`
        SELECT c."id", c."projectId", c."name", c."workflowKey",
          (SELECT previous."id" FROM "ProjectColumn" previous
           WHERE previous."projectId" = c."projectId" AND previous."position" < c."position"
           ORDER BY previous."position" DESC, previous."id" DESC LIMIT 1) AS "precedingColumnId"
        FROM "ProjectColumn" c
        WHERE c."id" = ${columnId}
      `;
      return columns[0] ?? null;
    },
    async getLastPosition(columnId) {
      const lastTask = await client.task.findFirst({
        where: { columnId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      return lastTask?.position ?? null;
    },
  };
}

export function createCanonicalTaskRelocationPort(
  client: Prisma.TransactionClient,
  ranks: RankService,
  actorId: string,
): CanonicalTaskRelocationPort {
  return {
    ...createTaskRelocationPort(client, ranks, actorId),
    async updateRelocatedTask(input) {
      const result = await client.task.updateMany({
        where: {
          id: input.taskId,
          version: input.expectedVersion,
        },
        data: {
          ...input.update,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        return null;
      }
      return client.task.findUniqueOrThrow({
        where: { id: input.taskId },
        select: {
          id: true,
          columnId: true,
          version: true,
          status: true,
        },
      });
    },
    async incrementBoardRevision(projectId) {
      const project = await client.project.update({
        where: { id: projectId },
        data: { boardRevision: { increment: 1 } },
        select: { boardRevision: true },
      });
      return project.boardRevision;
    },
    async writeMoveActivity(input) {
      await logActivityWithClient(client, {
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

export function validateColumnDerivedStatusUpdate(input: {
  status?: unknown;
  columnId?: unknown;
  [key: string]: unknown;
}): void {
  if (input.status !== undefined && input.columnId === undefined) {
    throw new TaskRelocationError("STATUS_REQUIRES_COLUMN");
  }
}

export async function prepareTaskRelocation(input: {
  taskId: string;
  expectedProjectId: string;
  toColumnId: string;
  port: TaskRelocationPort;
  ranks: RankService;
}): Promise<TaskRelocationUpdate> {
  const plan = await prepareTaskRelocationPlan(input);
  return plan.update;
}

async function prepareTaskRelocationPlan(input: {
  taskId: string;
  expectedProjectId: string;
  toColumnId: string;
  port: TaskRelocationPort;
  ranks: RankService;
}) {
  let column = await input.port.getColumnIdentity(input.toColumnId);
  if (!column) {
    throw new TaskRelocationError("COLUMN_NOT_FOUND");
  }
  if (column.projectId !== input.expectedProjectId) {
    throw new TaskRelocationError("COLUMN_PROJECT_MISMATCH");
  }

  await input.port.lockColumn(input.toColumnId);
  const task = await input.port.lockTask(
    input.taskId,
    input.expectedProjectId,
  );
  if (!task) {
    throw new TaskRelocationError("TASK_NOT_FOUND");
  }
  await input.port.assertLegacyMoveAllowed(task.id, task.projectId, column.id);

  // Re-read after the project/column lock: the first read only identifies locks.
  column = await input.port.getColumnIdentity(input.toColumnId);
  if (!column || column.projectId !== input.expectedProjectId) {
    throw new TaskRelocationError("COLUMN_PROJECT_MISMATCH");
  }
  const sourceColumn = task.columnId === column.id
    ? column
    : await input.port.getColumnIdentity(task.columnId);
  if (!sourceColumn || sourceColumn.projectId !== input.expectedProjectId) {
    throw new TaskRelocationError("COLUMN_PROJECT_MISMATCH");
  }
  if (!isPlainMoveRouteAllowed(sourceColumn, column)) {
    throw new TaskRelocationError("INVALID_MOVE_ROUTE");
  }

  const update: TaskRelocationUpdate = {
    columnId: input.toColumnId,
    status: derivedTaskStatus(column.workflowKey),
  };
  if (task.columnId === input.toColumnId) {
    return { task, column, sourceColumn, update, isRelocation: false };
  }

  update.rank = await allocateAppendRankAfterLock({
    columnId: input.toColumnId,
    port: input.port,
    ranks: input.ranks,
  });
  const lastPosition = await input.port.getLastPosition(input.toColumnId);
  update.position =
    lastPosition === null ? 1024 : lastPosition + 1024;

  return { task, column, sourceColumn, update, isRelocation: true };
}

export async function relocateTaskToColumn(input: {
  taskId: string;
  expectedProjectId: string;
  toColumnId: string;
  expectedVersion?: number;
  operationId: string;
  port: CanonicalTaskRelocationPort;
  ranks: RankService;
}): Promise<MoveTaskResponse | null> {
  const plan = await prepareTaskRelocationPlan(input);
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== plan.task.version
  ) {
    throw new TaskRelocationError("STALE_TASK_VERSION");
  }
  if (!plan.isRelocation) {
    return null;
  }
  const sourceColumn = plan.sourceColumn;
  if (
    !sourceColumn ||
    sourceColumn.projectId !== input.expectedProjectId
  ) {
    throw new TaskRelocationError("COLUMN_PROJECT_MISMATCH");
  }

  const movedTask = await input.port.updateRelocatedTask({
    taskId: input.taskId,
    expectedVersion: plan.task.version,
    update: plan.update,
  });
  if (!movedTask) {
    throw new TaskRelocationError("STALE_TASK_VERSION");
  }

  await input.port.writeMoveActivity({
    taskId: input.taskId,
    fromColumnId: plan.task.columnId,
    fromColumnName: sourceColumn.name,
    toColumnId: plan.column.id,
    toColumnName: plan.column.name,
    oldStatus: plan.task.status,
    newStatus: plan.update.status,
  });
  const boardRevision = await input.port.incrementBoardRevision(
    input.expectedProjectId,
  );
  return {
    operationId: input.operationId,
    boardRevision,
    task: movedTask,
  };
}
