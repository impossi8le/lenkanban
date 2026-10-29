import { Prisma } from "@prisma/client";
import { canActorReadInternal, loadProjectDiscussionFacts, type DiscussionDb } from "@/app/api/tasks/[id]/messages/discussion-access";
import { TASK_VISIBLE_WORK_ACTIONS } from "./task-change-contract";

type Actor = { id: string; globalRole: "USER" | "ADMIN" };
export type VisibleWorkPageRow = { id: string; lastVisibleWorkAt: string };

/** The ACL selects the full eligible ID set first. SQL computes visible work
 * and applies the page BEFORE loading cards. Creation is the only fallback;
 * updatedAt, receipts, notification reads and downloads are never work.
 */
export async function readTaskVisibleWorkPage({ db, actor, projectId, where, offset, pageSize }: {
  db: DiscussionDb;
  actor: Actor;
  projectId: string;
  where: Prisma.TaskWhereInput;
  offset: number;
  pageSize: number;
}): Promise<VisibleWorkPageRow[]> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("INVALID_VISIBLE_WORK_PAGE");
  // No take/limit here: restricting this set would break ordering on large boards.
  const authorized = await db.task.findMany({ where, select: { id: true } });
  const ids = [...new Set(authorized.map(task => task.id))];
  if (!ids.length) return [];
  const internal = await canActorReadInternal(db, actor, await loadProjectDiscussionFacts(db, projectId));
  const rows = await db.$queryRaw<{ id: string; lastVisibleWorkAt: Date }[]>(Prisma.sql`
    WITH allowed AS (
      SELECT "id", "createdAt", "attachments" FROM "Task"
      WHERE "projectId" = ${projectId} AND "id" = ANY(${ids}::text[])
    ), valid_files AS (
      SELECT t."id" AS "taskId", f AS file FROM allowed t
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t."attachments") = 'array' THEN t."attachments" ELSE '[]'::jsonb END) f
      WHERE jsonb_typeof(f->'url') = 'string' AND jsonb_typeof(f->'name') = 'string'
        AND jsonb_typeof(f->'size') = 'number' AND jsonb_typeof(f->'mime') = 'string'
    ), visible_urls AS (
      SELECT DISTINCT f."taskId", f.file->>'url' AS url FROM valid_files f
      WHERE NOT EXISTS (
        SELECT 1 FROM valid_files pending WHERE pending."taskId" = f."taskId"
          AND pending.file->>'url' = f.file->>'url' AND pending.file ? 'pendingMessageAuthorId'
      ) AND (${internal} OR NOT EXISTS (
        SELECT 1 FROM valid_files restricted WHERE restricted."taskId" = f."taskId"
          AND restricted.file->>'url' = f.file->>'url'
          AND restricted.file ? 'isInternal' AND restricted.file->'isInternal' IS DISTINCT FROM 'false'::jsonb
      ))
    ), work AS (
      SELECT "id" AS "taskId", "createdAt" AS at FROM allowed
      UNION ALL
      SELECT m."taskId", GREATEST(m."createdAt", m."editedAt", m."deletedAt") FROM "ChatMessage" m
      JOIN allowed t ON t."id" = m."taskId" WHERE ${internal} OR m."isInternal" = false
      UNION ALL
      SELECT a."taskId", a."createdAt" FROM "Activity" a JOIN allowed t ON t."id" = a."taskId"
      WHERE a."action" = ANY(${[...TASK_VISIBLE_WORK_ACTIONS]}::text[])
      UNION ALL
      SELECT a."taskId", a."createdAt" FROM "Activity" a JOIN allowed t ON t."id" = a."taskId"
      WHERE a."action" = 'attachment_added'
        AND a."newValue"->'discussionDraft' IS DISTINCT FROM 'true'::jsonb
        AND jsonb_typeof(a."newValue"->'files') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(a."newValue"->'files') = 'array' THEN a."newValue"->'files' ELSE '[]'::jsonb END) BETWEEN 1 AND 100
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a."newValue"->'files') = 'array' THEN a."newValue"->'files' ELSE '[]'::jsonb END) ref
          WHERE jsonb_typeof(ref) IS DISTINCT FROM 'object'
            OR jsonb_typeof(ref->'url') IS DISTINCT FROM 'string'
            OR jsonb_typeof(ref->'isInternal') IS DISTINCT FROM 'boolean'
        )
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a."newValue"->'files') = 'array' THEN a."newValue"->'files' ELSE '[]'::jsonb END) ref
          JOIN visible_urls visible ON visible."taskId" = a."taskId" AND visible.url = ref->>'url'
        )
    )
    SELECT "taskId" AS id, MAX(at) AS "lastVisibleWorkAt" FROM work
    GROUP BY "taskId" ORDER BY MAX(at) DESC, "taskId" DESC
    OFFSET ${offset} LIMIT ${pageSize + 1}
  `);
  const permitted = new Set(ids);
  return rows.map(row => {
    if (!permitted.has(row.id) || !(row.lastVisibleWorkAt instanceof Date) || !Number.isFinite(row.lastVisibleWorkAt.getTime())) throw new Error("INVALID_VISIBLE_WORK_RESULT");
    return { id: row.id, lastVisibleWorkAt: row.lastVisibleWorkAt.toISOString() };
  });
}
