import type { Prisma } from "@prisma/client";
import { decodeLifecycleColumnMap, lifecycleColumnFields, lifecycleColumnId, LifecycleColumnConfigurationError, validateLifecycleColumnTargets, type LifecycleColumnMap } from "@/lib/task-request-columns";
import type { TaskRequestState } from "@/lib/task-request-policy";
import { readTaskRequestBatchDecision } from "@/lib/task-request-guard";
import { createBase36RankService } from "../rank/rank-service";
import { allocateAppendRankAfterLock, createAppendTaskRankPort, type TaskRankClient } from "./append-task-rank";
import { derivedTaskStatus } from "./move-contract";

type Column = { id: string; projectId: string; workflowKey: string };
export interface LifecyclePlacementContext { map: LifecycleColumnMap | null; columns: Column[]; lockedTaskIds: Set<string>; configurationError?: "LIFECYCLE_COLUMNS_REQUIRED" | "INVALID_LIFECYCLE_COLUMNS" }

/** Caller already holds Project. Lock every configured resource before actor SHARE.
 * Project serialization also protects this configuration from concurrent edits. */
export async function lockLifecyclePlacement(tx: Prisma.TransactionClient, projectId: string, sourceColumnId: string): Promise<LifecyclePlacementContext> {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { lifecycleColumnMap: true } });
  let map: LifecycleColumnMap | null = null;
  let configurationError: LifecyclePlacementContext["configurationError"];
  try { map = decodeLifecycleColumnMap(project?.lifecycleColumnMap ?? null); }
  catch (error) {
    if (!(error instanceof LifecycleColumnConfigurationError)) throw error;
    configurationError = error.code;
  }
  const ids = [...new Set([sourceColumnId, ...(map ? lifecycleColumnFields.map(key => map[key]) : [])])].sort();
  const columns: Column[] = [];
  for (const id of ids) {
    const rows = await tx.$queryRaw<Column[]>`SELECT "id", "projectId", "workflowKey" FROM "ProjectColumn" WHERE "id" = ${id} AND "projectId" = ${projectId} FOR UPDATE`;
    columns.push(...rows);
  }
  if (map) {
    try { validateLifecycleColumnTargets(map, columns, projectId); }
    catch (error) {
      if (!(error instanceof LifecycleColumnConfigurationError)) throw error;
      configurationError = error.code;
    }
  }
  const lockedTaskIds = new Set<string>();
  if (map) {
    // A rank rebalance may touch any configured column. Lock potential siblings
    // once in ID order before User SHARE; only actual writes get marker guards.
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Task" WHERE "projectId" = ${projectId} ORDER BY "id" FOR UPDATE`;
    for (const row of rows) lockedTaskIds.add(row.id);
  }
  return { map, columns, lockedTaskIds, ...(configurationError ? { configurationError } : {}) };
}

/** Low-level placement only. Authorization/planning/CAS/Activity/receipt belong
 * to the enclosing lifecycle transaction; public legacy move guards stay closed. */
export async function prepareLifecyclePlacement(tx: Prisma.TransactionClient, context: LifecyclePlacementContext, task: { id: string; columnId: string }, nextState: TaskRequestState): Promise<Prisma.TaskUncheckedUpdateManyInput> {
  if (nextState === "DRAFT" || nextState === "CANCELLED") return {};
  if (!context.map) throw new LifecycleColumnConfigurationError("LIFECYCLE_COLUMNS_REQUIRED");
  const columnId = lifecycleColumnId(context.map, nextState)!;
  const column = context.columns.find(row => row.id === columnId);
  if (!column) throw new LifecycleColumnConfigurationError("INVALID_LIFECYCLE_COLUMNS");
  const update: Prisma.TaskUncheckedUpdateManyInput = { columnId, status: derivedTaskStatus(column.workflowKey) };
  if (columnId === task.columnId) return update;
  const ranks = createBase36RankService();
  const rankClient: TaskRankClient = {
    $queryRaw: (query, ...values) => tx.$queryRaw(query, ...values),
    task: {
      findFirst: input => tx.task.findFirst(input),
      findMany: async input => {
        const rows = await tx.task.findMany(input);
        if (rows.some(row => !context.lockedTaskIds.has(row.id))) throw new Error("Unlocked lifecycle rank write set");
        const decision = await readTaskRequestBatchDecision(tx, rows.map(row => row.id));
        if (!decision.allowed) throw new LifecycleColumnConfigurationError("INVALID_LIFECYCLE_COLUMNS");
        return rows;
      },
      update: input => tx.task.update(input),
    },
  };
  update.rank = await allocateAppendRankAfterLock({ columnId, port: createAppendTaskRankPort(rankClient, ranks), ranks });
  const last = await tx.task.findFirst({ where: { columnId }, orderBy: { position: "desc" }, select: { position: true } });
  const position = (last?.position ?? 0) + 1024;
  if (!Number.isSafeInteger(position) || position > 2147483647) throw new LifecycleColumnConfigurationError("INVALID_LIFECYCLE_COLUMNS");
  update.position = position;
  return update;
}
