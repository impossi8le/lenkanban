import type { Prisma } from "@prisma/client";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { getProjectCreationPolicy, isCreationColumnAllowed } from "@/lib/project-creation-policy";
import { lockProjectCreationDepartment } from "@/lib/project-create-department-lock";
import { readTaskRequestBatchDecision } from "@/lib/task-request-guard";
import type { RankService } from "../rank/rank-service";
import {
  allocateAppendRankAfterLock,
  createAppendTaskRankPort,
  TaskRankMaintenanceError,
  type TaskRankClient,
} from "./append-task-rank";

function records(value: unknown, keys: readonly string[]): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid creation lock result");
  return value.map(row => {
    if (row === null || typeof row !== "object" || Array.isArray(row)
      || Reflect.ownKeys(row).length !== keys.length) throw new Error("Invalid creation lock result");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Invalid creation lock result");
      result[key] = descriptor.value;
    }
    return result;
  });
}

function taskIds(value: unknown): string[] {
  const seen = new Set<string>();
  return records(value, ["id"]).map(({ id }) => {
    if (typeof id !== "string" || seen.has(id)) throw new Error("Invalid creation maintenance set");
    seen.add(id);
    return id;
  });
}

/** Prepare only inside the transaction that will create the legacy Task.
 * All potentially mutated resources are locked before actor authority is read. */
export async function prepareLegacyTaskCreation(
  tx: Prisma.TransactionClient,
  ranks: RankService,
  input: { actorId: string; projectId: string; columnId: string },
): Promise<{ column: { id: string; workflowKey: string }; rank: string }> {
  const { actorId, projectId, columnId } = input;
  const projects = records(await tx.$queryRaw<unknown>`
    SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE
  `, ["id"]);
  if (projects.length === 0) throw new NotFoundError();
  if (projects.length !== 1 || projects[0].id !== projectId) throw new Error("Invalid creation project lock");

  const columns = records(await tx.$queryRaw<unknown>`
    SELECT "id", "projectId", "workflowKey" FROM "ProjectColumn"
    WHERE "id" = ${columnId} AND "projectId" = ${projectId} FOR UPDATE
  `, ["id", "projectId", "workflowKey"]);
  if (columns.length === 0) throw new BadRequestError();
  if (columns.length !== 1 || typeof columns[0].workflowKey !== "string") {
    throw new Error("Invalid creation column lock");
  }
  if (columns[0].id !== columnId || columns[0].projectId !== projectId) throw new BadRequestError();
  const column = { id: columnId, workflowKey: columns[0].workflowKey };

  let heldTaskIds: Set<string> | null = null;
  const rankClient: TaskRankClient = {
    $queryRaw: (query, ...values) => tx.$queryRaw(query, ...values),
    task: {
      findFirst: query => tx.task.findFirst(query),
      findMany: async query => {
        // Never acquire Task locks after actor SHARE. Unexpected maintenance
        // or a changed write set is rejected before the allocator's TEMP writes.
        const held = heldTaskIds;
        if (query.where.columnId !== columnId || held === null) {
          throw new Error("Creation maintenance was not prepared");
        }
        const ids = taskIds(await tx.task.findMany(query));
        if (ids.some(id => !held.has(id))) throw new Error("Creation maintenance set was not locked");
        const decision = await readTaskRequestBatchDecision(tx, ids);
        if (!decision.allowed) throw new TaskRankMaintenanceError(decision.code);
        return ids.map(id => ({ id }));
      },
      update: query => tx.task.update(query),
    },
  };
  const basePort = createAppendTaskRankPort(rankClient, ranks);
  const lastRank = await basePort.getLastRank(columnId);
  if (ranks.between(lastRank, null) === null) {
    heldTaskIds = new Set(taskIds(await tx.$queryRaw<unknown>`
      SELECT "id" FROM "Task" WHERE "columnId" = ${columnId} ORDER BY "id" FOR UPDATE
    `));
  }

  const actors = records(await tx.$queryRaw<unknown>`
    SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE
  `, ["id"]);
  if (actors.length === 0) throw new NotFoundError();
  if (actors.length !== 1 || actors[0].id !== actorId) throw new Error("Invalid creation actor lock");
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true } });
  if (!actor || actor.id !== actorId || (actor.globalRole !== "USER" && actor.globalRole !== "ADMIN")) {
    throw new NotFoundError();
  }
  const departmentBoard = await lockProjectCreationDepartment(tx, projectId);
  if (actor.globalRole !== "ADMIN" || departmentBoard) {
    const policy = await getProjectCreationPolicy(actor, projectId, tx);
    if (!policy.canCreate) throw new NotFoundError();
    if (!isCreationColumnAllowed(policy, columnId)) throw new ForbiddenError();
  }

  const port = {
    ...basePort,
    async lockColumn(id: string) {
      if (id !== columnId) throw new Error("Creation column was not prepared");
    },
  };
  const rank = await allocateAppendRankAfterLock({ columnId, port, ranks });
  return { column, rank };
}
