import { NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "@/lib/require-api-user";
import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { lockProjectStatusAuthority } from "@/lib/project-status-policy";
import { NotFoundError, UnauthorizedError, ForbiddenError } from "@/lib/errors";
import { apiLogger } from "@/lib/logger";
import { TaskCommandError } from "@/lib/task-command";
import { decodeStoredTaskRequest } from "@/lib/task-request-marker-lifecycle";
import { canActorReadInternal, loadProjectDiscussionFacts } from "../discussion-access";
import { z } from "zod";
import { Prisma } from "@prisma/client";

const readSchema = z.object({
  messageIds: z.array(z.string().min(1).max(200)).max(1000).optional(),
});

/**
 * POST /api/tasks/[id]/messages/read
 * Mark visible messages in a readable task as read by current user.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(req);
    const actorId = user.id;
    const { id: taskId } = await params;

    const task = await prisma.task.findFirst({
      where: await getTaskReadWhere(user, { id: taskId }),
      select: { id: true, projectId: true },
    });
    if (!task) return NextResponse.json({ error: "TaskNotFound" }, { status: 404 });

    const body = await req.json().catch(() => null);
    const parsed = readSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "InvalidMessageIds" }, { status: 400 });
    const { messageIds } = parsed.data;
    const markedRead = await prisma.$transaction(async (tx) => {
      // Serialize with project policy and task membership/content writers, in
      // their shared Project -> Task order. A read receipt is not a task write.
      const projects = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Project" WHERE "id" = ${task.projectId} FOR UPDATE
      `;
      if (projects.length !== 1) throw new NotFoundError();
      const tasks = await tx.$queryRaw<Array<{ id: string; projectId: string }>>`
        SELECT "id", "projectId" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
      `;
      if (tasks.length !== 1) throw new NotFoundError();
      if (tasks[0].projectId !== task.projectId) throw new TaskCommandError("IDENTITY_CHANGED");
      // Acquire the existing active group/member SHARE locks only. Status
      // capability is deliberately ignored: common read remains the authority.
      await lockProjectStatusAuthority(tx, actorId, task.projectId);
      // Stabilize an existing watcher grant against direct removal. This row
      // never grants access by itself; the common predicate still decides.
      await tx.$queryRaw`SELECT "userId" FROM "TaskWatcher" WHERE "taskId" = ${taskId} AND "userId" = ${actorId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
      const actor = await tx.user.findUnique({
        where: { id: actorId },
        select: { id: true, globalRole: true, isBlocked: true, blockedAt: true },
      });
      if (!actor || actor.isBlocked !== false || actor.blockedAt !== null) throw new NotFoundError();
      const readable = await tx.task.findFirst({
        where: await getTaskReadWhere(actor, { id: taskId, projectId: task.projectId }, tx),
        select: { id: true, request: { select: {
          taskId: true, contractVersion: true, state: true, authorId: true,
          executorId: true, needsInfoSince: true, pausedTotalMs: true, deletedAt: true,
        } } },
      });
      if (!readable) throw new NotFoundError();
      if (readable.request !== null) {
        const { deletedAt, ...fields } = readable.request;
        const decoded = decodeStoredTaskRequest(fields, taskId);
        if (!decoded.valid || decoded.marker === null) throw new TaskCommandError("INVALID_REQUEST_MARKER");
        if (deletedAt !== null) throw new NotFoundError();
      }
      if (messageIds?.length === 0) return 0;
      const canReadInternal = await canActorReadInternal(tx, actor, await loadProjectDiscussionFacts(tx, task.projectId));
      const visibilityFilter = canReadInternal ? Prisma.empty : Prisma.sql`AND "isInternal" = false`;

      // Merge against the current locked row, never a previously read JSON
      // snapshot. Concurrent readers preserve one another; retries keep the first
      // timestamp. Older clients send {}, so their update covers every visible
      // message in the task.
      const now = new Date().toISOString();
      const idsFilter = messageIds
        ? Prisma.sql`AND "id" IN (${Prisma.join(messageIds)})`
        : Prisma.empty;
      return tx.$executeRaw`
        UPDATE "ChatMessage"
        SET "readBy" = COALESCE(NULLIF("readBy", 'null'::jsonb), '{}'::jsonb)
          || jsonb_build_object(${actorId}::text, ${now}::text)
        WHERE "taskId" = ${taskId}
          ${idsFilter}
          ${visibilityFilter}
          AND NOT (COALESCE(NULLIF("readBy", 'null'::jsonb), '{}'::jsonb) ? ${actorId}::text)
      `;
    });

    return NextResponse.json({ ok: true, markedRead });
  } catch (error) {
    if (error instanceof ForbiddenError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof NotFoundError) {
      return NextResponse.json({ error: "TaskNotFound" }, { status: 404 });
    }
    if (error instanceof TaskCommandError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    try {
      await apiLogger.error({ event: "task.messages.read.failed", route: "/api/tasks/:id/messages/read" });
    } catch { /* Diagnostics must not replace the fixed failure response. */ }
    return NextResponse.json(
      { error: "Failed to mark messages as read" },
      { status: 500 }
    );
  }
}
