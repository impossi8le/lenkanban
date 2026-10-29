import Link from "next/link";
import { CheckCircle2, Inbox as InboxIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { requireDbUser } from "@/lib/require-user";
import { TASK_LIST_MAX_LIMIT } from "@/lib/task-list-limits";
import { getTaskPriorityPresentation } from "@/lib/task-priority";

import { RelativeTime } from "./relative-time";

/**
 * Server-rendered inbox.
 *
 * The page used to be a client component that fetched `/api/tasks` and removed
 * its React Query cache on unmount, so every visit started cold. The rows are
 * read during the render instead, with the same projection and the same read
 * predicate as `GET /api/tasks?assignedToMe=true&status=TODO`. Nothing here can
 * widen visibility: the shared read policy is applied after the narrowing
 * filters, exactly like the route handler.
 */
export default async function InboxPage() {
  const user = await requireDbUser();

  // Voluntary narrowing on top of the server predicate, never a read grant.
  // "Assigned" is the canonical executor of a marked request or the legacy
  // single assignee; a legacy row with several assignees is deliberately
  // excluded. Kept in step with `assignedToMe` in src/app/api/tasks/route.ts.
  const where = await getTaskReadWhere(user, {
    OR: [
      { request: { is: { contractVersion: 1, executorId: user.id, deletedAt: null } } },
      { request: { is: null }, assignees: { some: { userId: user.id } } },
    ],
    status: "TODO",
  });

  // Same include, ordering and cap as the list endpoint, so the rendered rows
  // carry the fields the API used to deliver.
  const tasks = await prisma.task.findMany({
    where,
    include: {
      assignees: {
        select: {
          id: true,
          userId: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
      project: {
        select: {
          id: true,
          name: true,
        },
      },
      column: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
      tags: {
        select: {
          id: true,
          tag: {
            select: {
              id: true,
              name: true,
              color: true,
            },
          },
        },
      },
      _count: {
        select: { messages: true, checklistItems: true },
      },
    },
    orderBy: { position: "asc" },
    take: TASK_LIST_MAX_LIMIT,
  });

  return (
    <div className="container min-w-0 max-w-4xl py-8 px-4 sm:px-6 ml-0 space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <InboxIcon className="h-8 w-8 shrink-0" />
          Входящие
        </h1>
        <p className="text-muted-foreground mt-2">
          Здесь только новые задачи, назначенные мне.
        </p>
      </div>

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <CheckCircle2 className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium">Нет новых задач</p>
            <p className="text-sm text-muted-foreground mt-1">
              Нет новых задач, назначенных мне. Задачи в других статусах здесь не показаны.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {tasks.map((task) => {
            const priority = getTaskPriorityPresentation(task.priority);
            return (
              <Link
                key={task.id}
                href={`/projects/${task.project.id}/board?task=${task.id}`}
                className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
                  <CardHeader>
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 basis-40">
                        <CardTitle className="break-words text-lg">{task.title}</CardTitle>
                        <CardDescription className="mt-1 break-words">
                          {task.project.name}
                        </CardDescription>
                      </div>
                      <Badge className={`max-w-full whitespace-normal break-words ${priority.color}`}>
                        {priority.label}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm text-muted-foreground">
                      <span>
                        Создано{" "}
                        <RelativeTime value={task.createdAt} />
                      </span>
                      {task.deadline && (
                        <>
                          <span>•</span>
                          <span>
                            Дедлайн{" "}
                            <RelativeTime value={task.deadline.toISOString()} />
                          </span>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
