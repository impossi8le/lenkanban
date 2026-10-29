"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { Clock } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useSession } from "next-auth/react";
import { getActivityDescription } from "@/lib/activity-description";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type ActivityDescriptionInput = Parameters<typeof getActivityDescription>[0];

interface Activity {
  id: string;
  action: string;
  oldValue: ActivityDescriptionInput["oldValue"];
  newValue: ActivityDescriptionInput["newValue"];
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  };
}

interface ActivityTimelineProps {
  taskId: string;
}

export function ActivityTimeline({ taskId }: ActivityTimelineProps) {
  const { data: session } = useSession();
  const actorId = session?.user?.id;
  const { data: rawActivities = [], isLoading, isError, isFetching, isFetchedAfterMount, refetch } = useQuery({
    queryKey: ["activities", taskId, actorId],
    enabled: Boolean(actorId), staleTime: 0, refetchOnMount: "always",
    queryFn: ({ signal }) => apiFetch<Activity[]>(`/api/activities?taskId=${taskId}`, { signal }),
  });

  // Deduplicate activities by ID to prevent React key warnings
  const activities = useMemo(() => {
    const seen = new Set<string>();
    return (Array.isArray(rawActivities) ? rawActivities : []).filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
  }, [rawActivities]);

  if (isError) return <div role="alert" className="space-y-3 text-base"><p>Не удалось загрузить историю действий.</p><button type="button" className="min-h-12 rounded-md border px-3" disabled={isFetching} onClick={() => void refetch()}>Повторить загрузку истории</button></div>;

  if (!actorId || isLoading || !isFetchedAfterMount || isFetching) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-base text-muted-foreground">Загрузка истории действий…</div>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Clock className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-base text-muted-foreground">Пока нет действий</p>
      </div>
    );
  }

  return (
      <div className="min-w-0 space-y-6" aria-label="События истории действий">
        {activities.map((activity, index) => {
          const messageChange = activity.action === "message_edited" || activity.action === "message_deleted";
          const text = (value: unknown) => value && typeof value === "object" && "contentText" in value && typeof value.contentText === "string" ? value.contentText : "";
          const countValue = activity.newValue && typeof activity.newValue === "object" && "count" in activity.newValue ? activity.newValue.count : undefined;
          const count = typeof countValue === "number" && Number.isInteger(countValue) && countValue > 0 ? ` (${countValue})` : "";
          const actorName = activity.user.name || activity.user.email;
          const description = messageChange ? `${actorName} ${activity.action === "message_deleted" ? "удалил сообщение" : "изменил сообщение"}`
            : activity.action === "request_assigned" && activity.newValue && typeof activity.newValue === "object" && "takenOver" in activity.newValue && activity.newValue.takenOver === true ? `${actorName} взял обращение на себя вместо другого исполнителя`
            : activity.action === "related_request_added" ? `${actorName} добавил связь с другим обращением`
              : activity.action === "related_request_removed" ? `${actorName} убрал связь с другим обращением`
            : activity.action === "attachment_removed" ? `${actorName} убрал вложение из обращения${count}`
              : activity.action === "attachment_added" ? `${actorName} добавил вложения в обращение${count}` : getActivityDescription(activity);
          const isFirst = index === 0;

          return (
            <div key={activity.id} className="flex gap-3 relative">
              {!isFirst && (
                <div className="absolute left-4 top-0 bottom-0 w-px bg-border -translate-y-4" />
              )}

              <Avatar className="h-8 w-8 relative z-10">
                <AvatarFallback className="text-xs">
                  {(activity.user.name || activity.user.email)[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>

              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-base leading-relaxed [overflow-wrap:anywhere]">{description}</p>
                <p className="text-sm text-muted-foreground">{Number.isFinite(Date.parse(activity.createdAt)) ? format(new Date(activity.createdAt), "d MMM yyyy, HH:mm", { locale: ru }) : "Время не указано"}</p>
                {messageChange && <dl className="space-y-3 rounded-lg border bg-background p-3 text-base leading-relaxed">
                  <div><dt className="font-semibold">Было</dt><dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{text(activity.oldValue) || "Пустое сообщение"}</dd></div>
                  <div><dt className="font-semibold">Стало</dt><dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{activity.action === "message_deleted" ? "Сообщение удалено" : text(activity.newValue) || "Пустое сообщение"}</dd></div>
                </dl>}
              </div>
            </div>
          );
        })}
      </div>
  );
}
