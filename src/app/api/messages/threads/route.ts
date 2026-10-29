import { NextResponse } from "next/server";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { apiLogger } from "@/lib/logger";

type ReadBy = Record<string, string> | null;

type ThreadItem = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  lastMessage: {
    contentText: string;
    createdAt: string;
    authorName: string;
  } | null;
  unreadCount: number;
};

/**
 * GET /api/messages/threads
 * Returns one row per task the caller may read that still has unread messages:
 * the task title, its project and the newest visible message. It replaces the
 * per-task `/api/tasks/:id` + `/api/tasks/:id/messages?limit=1` pair the
 * messages page used to issue for every unread task (2N requests).
 *
 * Visibility is the same boundary as `/api/messages/unread`: the shared
 * `getTaskReadWhere` predicate is applied to the message's task, so project
 * membership alone cannot expose an OWN task. Internal messages are excluded
 * with the counter's rule (#66): the ordinary list never reveals them, and the
 * last visible message is chosen among the remaining rows.
 *
 * One query is issued regardless of how many tasks are unread. The projection
 * stays limited to fields the list renders; message bodies are never logged.
 */
export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const taskWhere = await getTaskReadWhere(user);

    // Newest first: the first row of each task is its last visible message.
    const messages = await prisma.chatMessage.findMany({
      where: { isInternal: false, deletedAt: null, task: taskWhere },
      select: {
        taskId: true,
        contentText: true,
        createdAt: true,
        readBy: true,
        author: { select: { name: true, email: true } },
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            project: { select: { name: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const threads = new Map<string, ThreadItem>();
    const lastMessageAt = new Map<string, number>();

    for (const message of messages) {
      const readBy = (message.readBy as ReadBy) ?? {};
      const unread = !readBy[user.id];
      const createdAt = new Date(message.createdAt).getTime();
      const existing = threads.get(message.taskId);

      if (!existing) {
        threads.set(message.taskId, {
          id: message.task.id,
          title: message.task.title,
          projectId: message.task.projectId,
          projectName: message.task.project.name,
          lastMessage: {
            contentText: message.contentText,
            createdAt: new Date(createdAt).toISOString(),
            authorName: message.author.name ?? message.author.email,
          },
          unreadCount: unread ? 1 : 0,
        });
        lastMessageAt.set(message.taskId, createdAt);
        continue;
      }

      if (unread) existing.unreadCount += 1;
      // Rows are ordered by the database; compare explicitly so a different
      // order in another storage still yields the newest message.
      if (createdAt > (lastMessageAt.get(message.taskId) ?? 0)) {
        existing.lastMessage = {
          contentText: message.contentText,
          createdAt: new Date(createdAt).toISOString(),
          authorName: message.author.name ?? message.author.email,
        };
        lastMessageAt.set(message.taskId, createdAt);
      }
    }

    const items = [...threads.values()].filter((thread) => thread.unreadCount > 0);
    const total = items.reduce((sum, thread) => sum + thread.unreadCount, 0);

    return NextResponse.json({ items, total });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try { apiLogger.error({ event: "messages.threads.failed", err: error }, "Failed to fetch message threads"); }
    catch { /* Diagnostics cannot replace the safe response. */ }
    return NextResponse.json(
      { error: "Failed to fetch message threads" },
      { status: 500 }
    );
  }
}
