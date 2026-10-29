import type { Prisma } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";

/** Caller holds the Task lock; assignment writers hold the same lock. */
export async function requireTaskDeadlineExecutor(
  tx: Pick<Prisma.TransactionClient, "taskAssignee">,
  actorId: string,
  taskId: string,
): Promise<void> {
  const assignees = await tx.taskAssignee.findMany({
    where: { taskId }, select: { userId: true }, take: 2,
  });
  // Ambiguous legacy multi-assignment grants nobody an implicit executor role.
  if (assignees.length !== 1 || assignees[0].userId !== actorId) throw new NotFoundError();
}
