"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, Repeat, Calendar, Clock, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { getTaskPriorityPresentation } from "@/lib/task-priority";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { ru } from "date-fns/locale";

interface RecurringTask {
  id: string;
  name: string;
  description: string | null;
  taskTitle: string;
  taskDescription: string | null;
  priority: string;
  frequency: string;
  interval: number;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
  nextRunAt: string;
  active: boolean;
  lastRunAt: string | null;
  createdBy: {
    id: string;
    name: string | null;
    email: string;
  };
  createdAt: string;
}

interface RecurringTaskListProps {
  projectId: string;
}

const frequencyLabels: Record<string, string> = {
  daily: "Ежедневно",
  weekly: "Еженедельно",
  monthly: "Ежемесячно",
  yearly: "Ежегодно",
};

const daysOfWeekLabels = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export function RecurringTaskList({ projectId }: RecurringTaskListProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: recurringTasks, isLoading } = useQuery({
    queryKey: ["recurring-tasks", projectId],
    queryFn: ({ signal }) => apiFetch<RecurringTask[]>(`/api/recurring-tasks?projectId=${projectId}`, { signal }),
  });

  const deleteRecurringTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiFetch(`/api/recurring-tasks/${id}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring-tasks", projectId] });
      toast({
        title: "Повторяющаяся задача удалена",
        description: "Задачи больше не будут создаваться автоматически",
      });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось удалить повторяющуюся задачу",
        variant: "destructive",
      });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      return apiFetch(`/api/recurring-tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring-tasks", projectId] });
      toast({
        title: "Статус изменен",
        description: "Повторяющаяся задача обновлена",
      });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось изменить статус",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 role="status" aria-live="polite" className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!recurringTasks || recurringTasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Repeat className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">Нет повторяющихся задач</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Создайте повторяющуюся задачу, чтобы автоматически создавать задачи по расписанию
        </p>
      </div>
    );
  }

  const formatSchedule = (task: RecurringTask) => {
    let schedule = `${frequencyLabels[task.frequency]}`;

    if (task.interval > 1) {
      schedule += ` (каждые ${task.interval})`;
    }

    if (task.frequency === "weekly" && task.daysOfWeek.length > 0) {
      const days = task.daysOfWeek.map(d => daysOfWeekLabels[d]).join(", ");
      schedule += ` - ${days}`;
    }

    if (task.frequency === "monthly" && task.dayOfMonth) {
      schedule += ` - ${task.dayOfMonth} число`;
    }

    return schedule;
  };

  return (
    <div className="space-y-4">
      {recurringTasks.map((task) => (
        <Card key={task.id} className={!task.active ? "opacity-60" : ""}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1 min-w-0 flex-1 break-words">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base break-words [overflow-wrap:anywhere] min-w-0">{task.name}</CardTitle>
                  {task.active ? (
                    <Badge variant="outline" className="gap-1">
                      <Power className="h-3 w-3" />
                      Активно
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 opacity-50">
                      <PowerOff className="h-3 w-3" />
                      Неактивно
                    </Badge>
                  )}
                </div>
                {task.description && (
                  <CardDescription className="text-sm break-words [overflow-wrap:anywhere]">
                    {task.description}
                  </CardDescription>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Switch
                  aria-label={`Активность: ${task.name}`}
                checked={task.active}
                  onCheckedChange={(checked) =>
                    toggleActiveMutation.mutate({ id: task.id, active: checked })
                  }
                  disabled={toggleActiveMutation.isPending}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Удалить повторяющуюся задачу: ${task.name}`}
                onClick={() => {
                  if (window.confirm(`Удалить повторяющуюся задачу «${task.name}»? Это действие нельзя отменить.`)) {
                    deleteRecurringTaskMutation.mutate(task.id);
                  }
                }}
                  disabled={deleteRecurringTaskMutation.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm min-w-0">
                <span className="text-muted-foreground shrink-0">Создаваемая задача:</span>
                <span className="font-medium break-words [overflow-wrap:anywhere] min-w-0">{task.taskTitle}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={getTaskPriorityPresentation(task.priority).color}>
                  {getTaskPriorityPresentation(task.priority).label}
                </Badge>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm min-w-0">
              <Repeat className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground break-words [overflow-wrap:anywhere] min-w-0">{formatSchedule(task)}</span>
            </div>

            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div className="flex items-center gap-2 min-w-0">
                <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground break-words [overflow-wrap:anywhere] min-w-0">
                  Начало: {format(new Date(task.startDate), "d MMM yyyy", { locale: ru })}
                </span>
              </div>
              {task.endDate && (
                <div className="flex items-center gap-2 min-w-0">
                  <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground break-words [overflow-wrap:anywhere] min-w-0">
                    Конец: {format(new Date(task.endDate), "d MMM yyyy", { locale: ru })}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm border-t pt-2 min-w-0">
              <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground break-words [overflow-wrap:anywhere] min-w-0">
                Следующий запуск: {format(new Date(task.nextRunAt), "d MMM yyyy, HH:mm", { locale: ru })}
              </span>
            </div>

            {task.lastRunAt && (
              <div className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                Последний запуск: {format(new Date(task.lastRunAt), "d MMM yyyy, HH:mm", { locale: ru })}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground">
              <span className="break-words [overflow-wrap:anywhere]">Создал: {task.createdBy.name || task.createdBy.email}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
