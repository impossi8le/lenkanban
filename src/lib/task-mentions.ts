import { z } from "zod";
import type { Notification, Prisma } from "@prisma/client";
import { getTaskReadWhere } from "./project-access";
import { persistNotificationsWithClient } from "./notifications";

export const mentionUserIdsSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(20)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate mention recipient")
  .transform(ids => [...ids].sort()).optional().default([]);

export class TaskMentionError extends Error {
  constructor(readonly code: "MENTION_RECIPIENT_UNAVAILABLE" | "MENTIONS_INTERNAL_UNSUPPORTED") {
    super(code === "MENTIONS_INTERNAL_UNSUPPORTED" ? "Упоминания во внутреннем сообщении пока недоступны. Уберите выбранные упоминания."
      : "Не удалось отправить сообщение: доступ одного из выбранных сотрудников изменился. Уберите его из упоминаний или выберите заново. Текст сообщения сохранён");
    this.name = "TaskMentionError";
  }
}

type MentionDb = Pick<Prisma.TransactionClient, "user" | "project" | "task" | "scopedPrivilegeAssignment">;
type MentionActor = { id: string; globalRole: "USER" | "ADMIN"; isBlocked: boolean; blockedAt: Date | null };

/** Fixed batches keep fresh common ACL checks bounded; no alternate audience policy. */
export async function filterMentionReaders(db: MentionDb, taskId: string, projectId: string, actors: readonly MentionActor[]): Promise<string[]> {
  const result: string[] = [];
  for (let start = 0; start < actors.length; start += 5) {
    const batch = await Promise.all(actors.slice(start, start + 5).map(async actor => {
      if (actor.isBlocked !== false || actor.blockedAt !== null) return null;
      const row = await db.task.findFirst({ where: await getTaskReadWhere(actor, { id: taskId, projectId }, db, { projectId }), select: { id: true } });
      return row ? actor.id : null;
    }));
    result.push(...batch.filter((id): id is string => id !== null));
  }
  return result;
}

/** Caller holds the common Project/Task content locks. No access expansion. */
export async function validateTaskMentions(db: MentionDb & Pick<Prisma.TransactionClient, "$queryRaw">,
  taskId: string, projectId: string, ids: readonly string[], visibility: "PUBLIC" | "INTERNAL",
): Promise<void> {
  if (!ids.length) return;
  if (ids.length > 20 || new Set(ids).size !== ids.length) throw new TaskMentionError("MENTION_RECIPIENT_UNAVAILABLE");
  if (visibility === "INTERNAL") throw new TaskMentionError("MENTIONS_INTERNAL_UNSUPPORTED");
  await db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(${[...ids]}::text[]) ORDER BY "id" FOR SHARE`;
  const actors = await db.user.findMany({ where: { id: { in: [...ids] }, isBlocked: false, blockedAt: null },
    select: { id: true, globalRole: true, isBlocked: true, blockedAt: true } });
  if (actors.length !== ids.length || (await filterMentionReaders(db, taskId, projectId, actors)).length !== ids.length) {
    throw new TaskMentionError("MENTION_RECIPIENT_UNAVAILABLE");
  }
}

/** Existing pipeline, in the message transaction; caller delivers only after commit. */
export async function persistTaskMentions(db: MentionDb & Pick<Prisma.TransactionClient, "notification">,
  input: { taskId: string; projectId: string; actorId: string; messageId: string; mentionUserIds: readonly string[] },
): Promise<Notification[]> {
  const recipients = input.mentionUserIds.filter(id => id !== input.actorId);
  if (!recipients.length) return [];
  const notifications = await persistNotificationsWithClient(db, recipients.map(userId => ({
    userId, type: "task_mentioned", title: "Вас упомянули в обращении", message: "Откройте обращение, чтобы прочитать сообщение",
    actionUrl: `/projects/${input.projectId}/board?task=${input.taskId}`,
    metadata: { taskId: input.taskId, projectId: input.projectId, authorId: input.actorId, messageId: input.messageId, visibility: "PUBLIC" },
  })));
  if (notifications.length !== recipients.length) throw new TaskMentionError("MENTION_RECIPIENT_UNAVAILABLE");
  return notifications;
}

/** Explicit recipient intent is part of clientId replay identity, never body parsing. */
export function sameMentionIds(stored: unknown, requested: readonly string[]): boolean {
  const parsed = mentionUserIdsSchema.safeParse(stored ?? []);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(requested);
}
