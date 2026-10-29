import { Prisma } from "@prisma/client";
import { getTaskReadWhere } from "./project-access";
import { BadRequestError } from "./errors";
import { canActorReadInternal, loadProjectDiscussionFacts } from "@/app/api/tasks/[id]/messages/discussion-access";

/** Counts obey the same current task and discussion visibility as message bodies. */
export async function readVisibleMessageCounts(database: Prisma.TransactionClient,
  actor: { id: string; globalRole: "USER" | "ADMIN" }, taskIds: readonly string[],
): Promise<Map<string, { total: number; unread: number }>> {
  if (taskIds.length > 1000 || taskIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new BadRequestError("Invalid task identities");
  if (!taskIds.length) return new Map();
  const tasks = await database.task.findMany({ where: await getTaskReadWhere(actor, { id: { in: [...new Set(taskIds)] } }, database), select: { id: true, projectId: true } });
  const result = new Map(tasks.map(task => [task.id, { total: 0, unread: 0 }]));
  if (!tasks.length) return result;
  const internalProjects = new Set<string>();
  for (const projectId of new Set(tasks.map(task => task.projectId))) {
    if (await canActorReadInternal(database, actor, await loadProjectDiscussionFacts(database, projectId))) internalProjects.add(projectId);
  }
  const internalIds = tasks.filter(task => internalProjects.has(task.projectId)).map(task => task.id);
  const internal = internalIds.length ? Prisma.sql`OR "taskId" IN (${Prisma.join(internalIds)})` : Prisma.empty;
  const rows = await database.$queryRaw<{ taskId: string; total: bigint; unread: bigint }[]>(Prisma.sql`
    SELECT "taskId", count(*) AS "total",
      count(*) FILTER (WHERE "deletedAt" IS NULL AND NOT (COALESCE("readBy", '{}'::jsonb) ? ${actor.id})) AS "unread"
    FROM "ChatMessage" WHERE "taskId" IN (${Prisma.join(tasks.map(task => task.id))})
      AND ("isInternal" = false ${internal}) GROUP BY "taskId"`);
  for (const row of rows) if (result.has(row.taskId)) {
    const total = Number(row.total), unread = Number(row.unread);
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(unread) || total < 0 || unread < 0 || unread > total) throw new Error("INVALID_VISIBLE_MESSAGE_COUNTS");
    result.set(row.taskId, { total, unread });
  }
  return result;
}
