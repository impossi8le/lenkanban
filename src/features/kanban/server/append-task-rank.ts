import type { Prisma } from "@prisma/client";
import { readTaskRequestBatchDecision } from "@/lib/task-request-guard";
import { formatRank, type RankService } from "../rank/rank-service";

export class TaskRankMaintenanceError extends Error {
  constructor(readonly code: "REQUEST_LIFECYCLE_NOT_ENABLED" | "INVALID_REQUEST_MARKER") {
    super(code);
    this.name = "TaskRankMaintenanceError";
  }
}

export interface AppendTaskRankPort {
  lockColumn(columnId: string): Promise<void>;
  getLastRank(columnId: string): Promise<string | null>;
  rebalanceColumn(columnId: string): Promise<readonly string[]>;
}

export interface TaskRankClient {
  $queryRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly { id: string; projectId?: string }[]>;
  task: {
    findFirst(input: {
      where: { columnId: string };
      orderBy: { rank: "desc" };
      select: { rank: true };
    }): Promise<{ rank: string } | null>;
    findMany(input: {
      where: { columnId: string };
      orderBy: { rank: "asc" };
      select: { id: true };
    }): Promise<readonly { id: string }[]>;
    update(input: {
      where: { id: string };
      data: { rank: string };
    }): Promise<unknown>;
  };
}

export function createAppendTaskRankPort(
  client: TaskRankClient,
  ranks: RankService,
): AppendTaskRankPort {
  return {
    async lockColumn(columnId) {
      const columns = await client.$queryRaw`
        SELECT "id", "projectId"
        FROM "ProjectColumn"
        WHERE "id" = ${columnId}
      `;
      const column = columns[0];
      if (!column?.projectId) {
        throw new Error(`Column ${columnId} not found before rank locking`);
      }

      const lockedProjects = await client.$queryRaw`
        SELECT "id"
        FROM "Project"
        WHERE "id" = ${column.projectId}
        FOR UPDATE
      `;
      if (lockedProjects.length === 0) {
        throw new Error(
          `Project ${column.projectId} not found while acquiring rank lock`,
        );
      }

      const lockedColumns = await client.$queryRaw`
        SELECT "id"
        FROM "ProjectColumn"
        WHERE "id" = ${columnId}
          AND "projectId" = ${column.projectId}
        FOR UPDATE
      `;
      if (lockedColumns.length === 0) {
        throw new Error(`Column ${columnId} not found while acquiring rank lock`);
      }
    },
    async getLastRank(columnId) {
      const lastTask = await client.task.findFirst({
        where: { columnId },
        orderBy: { rank: "desc" },
        select: { rank: true },
      });
      return lastTask?.rank ?? null;
    },
    async rebalanceColumn(columnId) {
      const tasks = await client.task.findMany({
        where: { columnId },
        orderBy: { rank: "asc" },
        select: { id: true },
      });
      const rankByTaskId = ranks.rebalance(tasks.map((task) => task.id));

      for (const [index, task] of tasks.entries()) {
        await client.task.update({
          where: { id: task.id },
          data: {
            rank: `~${formatRank(BigInt(index + 1)).slice(1)}`,
          },
        });
      }

      const rebalancedRanks: string[] = [];
      for (const task of tasks) {
        const rank = rankByTaskId.get(task.id);
        if (rank === undefined) {
          throw new Error(`Missing rebalanced rank for task ${task.id}`);
        }
        await client.task.update({
          where: { id: task.id },
          data: { rank },
        });
        rebalancedRanks.push(rank);
      }

      return rebalancedRanks;
    },
  };
}

/** Generic creation callers hold parent locks through the existing allocator.
 * Only maintenance locks and inspects siblings; an ordinary append is unchanged. */
export function createGuardedAppendTaskRankPort(
  client: Prisma.TransactionClient,
  ranks: RankService,
): AppendTaskRankPort {
  const idsFromRows = (rows: unknown): string[] => {
    if (!Array.isArray(rows)) throw new Error("Invalid rank maintenance write set");
    const seen = new Set<string>();
    return rows.map(row => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("Invalid rank maintenance write set");
      }
      const id = Object.getOwnPropertyDescriptor(row, "id");
      if (!id || !("value" in id) || typeof id.value !== "string" || seen.has(id.value)) {
        throw new Error("Invalid rank maintenance write set");
      }
      seen.add(id.value);
      return id.value;
    });
  };
  const guardedClient: TaskRankClient = {
    $queryRaw: (query, ...values) => client.$queryRaw(query, ...values),
    task: {
      findFirst: input => client.task.findFirst(input),
      findMany: async input => {
        const lockedRows = await client.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Task"
          WHERE "columnId" = ${input.where.columnId}
          ORDER BY "id" FOR UPDATE
        `;
        const heldIds = new Set(idsFromRows(lockedRows));
        const rows = await client.task.findMany(input);
        const actualIds = idsFromRows(rows);
        if (actualIds.some(id => !heldIds.has(id))) {
          throw new Error("Rank maintenance write set was not locked");
        }
        const decision = await readTaskRequestBatchDecision(client, actualIds);
        if (!decision.allowed) throw new TaskRankMaintenanceError(decision.code);
        return actualIds.map(id => ({ id }));
      },
      update: input => client.task.update(input),
    },
  };
  return createAppendTaskRankPort(guardedClient, ranks);
}

export async function allocateAppendRank(input: {
  columnId: string;
  port: AppendTaskRankPort;
  ranks: RankService;
}): Promise<string> {
  if (!input.columnId?.trim()) {
    throw new Error("columnId is required");
  }

  await input.port.lockColumn(input.columnId);
  return allocateAppendRankAfterLock(input);
}

export async function allocateAppendRankAfterLock(input: {
  columnId: string;
  port: AppendTaskRankPort;
  ranks: RankService;
}): Promise<string> {
  const lastRank = await input.port.getLastRank(input.columnId);
  const appendedRank = input.ranks.between(lastRank, null);
  if (appendedRank !== null) {
    return appendedRank;
  }

  const rebalancedRanks = await input.port.rebalanceColumn(input.columnId);
  const rebalancedLastRank = rebalancedRanks.at(-1) ?? null;
  const recalculatedRank = input.ranks.between(rebalancedLastRank, null);
  if (recalculatedRank === null) {
    throw new Error("Unable to allocate task rank after rebalance");
  }

  return recalculatedRank;
}
