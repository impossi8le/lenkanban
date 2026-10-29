"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useUnreadCounts } from "@/hooks/useUnreadCounts";
import Link from "next/link";
import { MessageSquare, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

type TaskWithUnread = {
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

export default function MessagesPage() {
  const { byTask, total, isLoading: unreadLoading } = useUnreadCounts();

  // The unread counters stay the live signal (socket events + polling in the
  // shared hook); the rows come from one batch request. The task ids and the
  // total are part of the key, so a changed unread set refetches the batch
  // instead of leaving stale rows behind.
  const taskIds = Object.keys(byTask);

  const { data: threads, isLoading: tasksLoading } = useQuery({
    queryKey: ["message-threads", total, taskIds],
    queryFn: async () => {
      const response = await apiFetch<{ items: TaskWithUnread[] }>("/api/messages/threads");
      return response.items;
    },
    enabled: taskIds.length > 0,
  });

  const tasksWithUnread = threads;

  // Group by project
  const groupedByProject = tasksWithUnread?.reduce((acc, task) => {
    if (!acc[task.projectId]) {
      acc[task.projectId] = {
        projectName: task.projectName,
        tasks: [],
      };
    }
    acc[task.projectId].tasks.push(task);
    return acc;
  }, {} as Record<string, { projectName: string; tasks: TaskWithUnread[] }>);

  const isLoading = unreadLoading || tasksLoading;
  const hasResults = groupedByProject && Object.keys(groupedByProject).length > 0;

  return (
    <div className="container min-w-0 max-w-4xl py-8 px-4 sm:px-6 ml-0">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Сообщения</h1>
        <p className="text-muted-foreground">
          {total > 0 ? `${total} непрочитанных сообщений` : "Нет непрочитанных сообщений"}
        </p>
      </div>

      {isLoading && (
        <div role="status" aria-live="polite" className="text-center py-12 text-muted-foreground">
          Загрузка сообщений...
        </div>
      )}

      {!isLoading && total === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <MessageSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">Нет непрочитанных сообщений</p>
          </CardContent>
        </Card>
      )}

      {!isLoading && total > 0 && !hasResults && (
        <Card>
          <CardContent className="py-12 text-center">
            <MessageSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">
              Не удалось загрузить сообщения. Попробуйте обновить страницу.
            </p>
          </CardContent>
        </Card>
      )}

      {hasResults && (
        <div className="space-y-6">
          {Object.entries(groupedByProject).map(([projectId, { projectName, tasks }]) => (
            <Card key={projectId}>
              <CardHeader>
                <h2 className="text-lg font-semibold leading-none tracking-tight">{projectName}</h2>
                <CardDescription>
                  {tasks.reduce((sum, t) => sum + t.unreadCount, 0)} непрочитанных сообщений
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {tasks.map((task) => (
                  <Link
                    key={task.id}
                    href={`/projects/${task.projectId}/board?task=${task.id}`}
                    className="block rounded-lg border p-4 hover:bg-accent transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex min-w-0 items-center gap-2 mb-1">
                          <h3 className="min-w-0 font-medium truncate">{task.title}</h3>
                          <Badge variant="default" className="h-5 min-w-5 px-1.5 text-xs">
                            {task.unreadCount}
                          </Badge>
                        </div>
                        {task.lastMessage && (
                          <>
                            <p className="text-sm text-muted-foreground truncate">
                              <span className="font-medium">{task.lastMessage.authorName}:</span>{" "}
                              {task.lastMessage.contentText}
                            </p>
                            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              {formatDistanceToNow(new Date(task.lastMessage.createdAt), {
                                addSuffix: true,
                                locale: ru,
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
