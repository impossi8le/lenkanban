import { NextResponse } from "next/server";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { apiLogger } from "@/lib/logger";

/**
 * GET /api/messages/unread
 * Returns unread message counts grouped by project and task.
 *
 * A counter is a read channel: it must not reveal that a hidden task exists.
 * The same task predicate used by boards and chat reads is applied to the
 * message's task, so project membership alone cannot expose an OWN task.
 * Internal comments are excluded until the shared internal-reader capability
 * exists (#66); counting them would disclose their volume to every member.
 * Cookie and bearer callers share one authentication boundary.
 */
export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const taskWhere = await getTaskReadWhere(user);

    // Collapse identical receipt distributions per task in the database. The
    // application still applies the existing falsey-value read semantics.
    const groups = await prisma.chatMessage.groupBy({
      by: ["taskId", "readBy"],
      where: { isInternal: false, deletedAt: null, task: taskWhere },
      _count: { _all: true },
    });
    const unreadByTask = new Map<string, number>();
    for (const group of groups) {
      const readBy = (group.readBy as Record<string, unknown> | null) ?? {};
      if (!readBy[user.id]) {
        unreadByTask.set(group.taskId, (unreadByTask.get(group.taskId) ?? 0) + group._count._all);
      }
    }

    // Reapply the common read boundary when resolving destinations. A grouped
    // row alone must never authorize a task or reveal its project.
    const tasks = unreadByTask.size === 0 ? [] : await prisma.task.findMany({
      where: { AND: [taskWhere, { id: { in: [...unreadByTask.keys()] } }] },
      select: { id: true, projectId: true },
    });
    const byProject: Record<string, number> = {};
    const byTask: Record<string, number> = {};
    let total = 0;
    for (const task of tasks) {
      const count = unreadByTask.get(task.id) ?? 0;
      if (count === 0) continue;
      byTask[task.id] = count;
      byProject[task.projectId] = (byProject[task.projectId] ?? 0) + count;
      total += count;
    }

    return NextResponse.json({
      byProject,
      byTask,
      total,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try { apiLogger.error({ event: "messages.unread.failed", err: error }, "Failed to fetch unread counts"); }
    catch { /* Diagnostics cannot replace the safe response. */ }
    return NextResponse.json(
      { error: "Failed to fetch unread counts" },
      { status: 500 }
    );
  }
}
