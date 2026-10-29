import type { Prisma } from "@prisma/client";
import { authorizeTaskRequestContentWrite } from "@/features/kanban/server/task-lifecycle-service";
import { prepareLegacyTaskScalarBatch, TaskCommandError } from "@/lib/task-command";
import { NotFoundError } from "@/lib/errors";

/** Dispatch is not admission: both branches recheck identity/ACL/marker under locks. */
export async function prepareTaskAttachmentWrite({ tx, actorId, taskId, expectedProjectId }: {
  tx: Prisma.TransactionClient;
  actorId: string;
  taskId: string;
  expectedProjectId: string;
}): Promise<{ projectId: string; marked: boolean; beznal?: boolean }> {
  const presence = await tx.taskRequest.findUnique({ where: { taskId }, select: { taskId: true } });
  if (presence !== null) {
    const decision = await authorizeTaskRequestContentWrite({ tx, actorId, taskId, expectedProjectId, kind: "attachment" });
    if (!decision.allowed) throw new TaskCommandError(decision.code);
    if (decision.marked) return { projectId: expectedProjectId, marked: true, ...(decision.beznal?{beznal:true}:{}) };
  }
  // A marker introduced after the dispatch read still fails the existing guard.
  // A marker removed before canonical admission cannot grant legacy write rights.
  const [locked] = await prepareLegacyTaskScalarBatch({ tx, actorId, expectedTasks: [{ id: taskId, projectId: expectedProjectId }] });
  if (!locked) throw new NotFoundError();
  return { projectId: locked.projectId, marked: false };
}
