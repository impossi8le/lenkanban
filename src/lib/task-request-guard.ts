import type { Prisma } from "@prisma/client";
import { evaluateTaskRequestMutation, type TaskRequestDecision } from "./task-request-policy";

export const TASK_REQUEST_GUARD_BATCH_SIZE = 200;
const markerSelection = { taskId: true, contractVersion: true, state: true, authorId: true, executorId: true } as const;

/** Caller holds the parent Task lock and has already checked fresh authorization.
 * No delegate/query exception is converted into an absent marker. */
export async function readTaskRequestDecision(
  database: Pick<Prisma.TransactionClient, "taskRequest">,
  taskId: string,
): Promise<TaskRequestDecision> {
  const marker = await database.taskRequest.findUnique({ where: { taskId }, select: markerSelection });
  return evaluateTaskRequestMutation(marker, taskId);
}

function returnedBatchDecision(value: unknown, chunk: readonly string[]): TaskRequestDecision {
  try {
    if (!Array.isArray(value) || value.length > chunk.length) return { allowed: false, code: "INVALID_REQUEST_MARKER" };
    const expected = new Set(chunk), seen = new Set<string>();
    let decision: TaskRequestDecision = { allowed: true, mode: "legacy" };
    for (const row of value) {
      if (row === null || typeof row !== "object") return { allowed: false, code: "INVALID_REQUEST_MARKER" };
      const descriptor = Object.getOwnPropertyDescriptor(row, "taskId");
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
        || !expected.has(descriptor.value) || seen.has(descriptor.value)) return { allowed: false, code: "INVALID_REQUEST_MARKER" };
      const taskId: string = descriptor.value;
      seen.add(taskId);
      const rowDecision = evaluateTaskRequestMutation(row, taskId);
      if (!rowDecision.allowed) {
        if (rowDecision.code === "INVALID_REQUEST_MARKER") return rowDecision;
        decision = rowDecision;
      }
    }
    return decision;
  } catch { return { allowed: false, code: "INVALID_REQUEST_MARKER" }; }
}

/** All supplied IDs are already locked by the caller. Batch size is a query
 * bound, never a maximum board size or a new legacy identifier restriction. */
export async function readTaskRequestBatchDecision(
  database: Pick<Prisma.TransactionClient, "taskRequest">,
  taskIds: readonly string[],
): Promise<TaskRequestDecision> {
  let ids: string[];
  try {
    if (!Array.isArray(taskIds)) return { allowed: false, code: "INVALID_REQUEST_MARKER" };
    ids = [...new Set(Array.from(taskIds, id => {
      if (typeof id !== "string") throw new Error();
      return id;
    }))];
  } catch { return { allowed: false, code: "INVALID_REQUEST_MARKER" }; }
  let decision: TaskRequestDecision = { allowed: true, mode: "legacy" };
  for (let offset = 0; offset < ids.length; offset += TASK_REQUEST_GUARD_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + TASK_REQUEST_GUARD_BATCH_SIZE);
    // Delegate/query errors deliberately propagate instead of becoming absence.
    const rows = await database.taskRequest.findMany({ where: { taskId: { in: chunk } },
      select: markerSelection, orderBy: { taskId: "asc" } });
    const result = returnedBatchDecision(rows, chunk);
    if (!result.allowed) {
      if (result.code === "INVALID_REQUEST_MARKER") return result;
      decision = result;
    }
  }
  return decision;
}
