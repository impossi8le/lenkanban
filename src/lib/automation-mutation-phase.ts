import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AutomationAction } from "./automation-actions";
import { createTaskCommandService } from "./task-command";
import { replaceTaskAssigneesWithClient } from "./task-assignees";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import { moveTask } from "@/features/kanban/server/move-task-service";
import { PrismaMoveRepository } from "@/features/kanban/server/prisma-move-repository";
import type { MoveTaskResponse } from "@/features/kanban/server/move-contract";
import type { TaskEvent } from "./automation-processor";

/** Stable, domain-separated UUID accepted by the existing command validators. */
export function automationActionOperationId(ruleKey: string, index: number): string {
  const hex = createHash("sha256").update(JSON.stringify(["automation-action-v1", ruleKey, index])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface AutomationMutationEffects {
  moves: MoveTaskResponse[];
  updated: boolean;
  events: TaskEvent[];
}

/**
 * The rule owns the only real transaction. Existing services receive a
 * transaction runner that joins it: no nested commit, no partial Task write.
 * Services retain all authorization, marker, Activity and receipt checks.
 */
export async function executeAutomationMutations(input: {
  tx: Prisma.TransactionClient;
  actions: readonly AutomationAction[];
  event: TaskEvent;
  ruleKey: string;
}): Promise<AutomationMutationEffects> {
  const { tx, actions, event, ruleKey } = input;
  // Prisma's overloaded public runner also accepts array transactions; these
  // two services exclusively use its interactive callback overload.
  const joined = { $transaction: async <T>(run: (client: Prisma.TransactionClient) => Promise<T>) => run(tx) } as Pick<PrismaClient, "$transaction">;
  const effects: AutomationMutationEffects = { moves: [], updated: false, events: [] };
  for (const [index, action] of actions.entries()) {
    if (action.type === "notify_assignees" || action.type === "notify_creator") continue;
    const operationId = automationActionOperationId(ruleKey, index);
    const task = await tx.task.findUniqueOrThrow({ where: { id: event.taskId } });
    const generated = (trigger: string, oldValue: unknown, newValue: unknown): TaskEvent => ({
      trigger, taskId: task.id, projectId: task.projectId, userId: event.userId,
      operationId, origin: "automation", oldValue, newValue,
    });
    if (action.type === "change_priority") {
      const result = await createTaskCommandService(joined).saveDetails({
        taskId: task.id, actorId: event.userId, operationId,
        expectedVersion: task.version, changes: { priority: action.params.priority },
      });
      if (result.ack.changed && !result.ack.replayed) {
        effects.updated = true;
        effects.events.push(generated("priority_changed", task.priority, action.params.priority));
      }
    } else if (action.type === "assign_user") {
      const existing = await tx.taskAssignee.findMany({ where: { taskId: task.id }, select: { userId: true } });
      const result = await replaceTaskAssigneesWithClient({ tx, actorId: event.userId,
        taskId: task.id, projectId: task.projectId,
        userIds: [...new Set([...existing.map(row => row.userId), action.params.userId])],
      });
      if (result.added.length > 0) {
        effects.updated = true;
        effects.events.push(generated("assignee_added", undefined, action.params.userId));
      }
    } else if (action.type === "move_to_column") {
      const last = await tx.task.findFirst({
        where: { columnId: action.params.columnId, projectId: task.projectId, id: { not: task.id } },
        orderBy: [{ rank: "desc" }, { id: "desc" }], select: { id: true },
      });
      const result = await moveTask({ taskId: task.id, request: {
        toColumnId: action.params.columnId, beforeTaskId: last?.id ?? null,
        afterTaskId: null, operationId, expectedVersion: task.version,
      }, repository: new PrismaMoveRepository(joined as PrismaClient, {
        taskId: task.id, toColumnId: action.params.columnId, operationId, actorId: event.userId,
      }), ranks: createBase36RankService() });
      effects.moves.push(result);
      if (result.task.status !== task.status) effects.events.push(generated("status_changed", task.status, result.task.status));
    }
  }
  return effects;
}
