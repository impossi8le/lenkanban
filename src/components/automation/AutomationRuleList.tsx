"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Trash2, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api";

interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  trigger: string;
  conditions: unknown[];
  actions: Array<{ type: string; params?: Record<string, unknown> }>;
  createdAt: string;
  createdBy: {
    id: string;
    name: string | null;
    email: string;
  };
}

interface AutomationRuleListProps {
  projectId: string;
}

const triggerLabels: Record<string, string> = {
  task_created: "Задача создана",
  status_changed: "Статус изменен",
  priority_changed: "Приоритет изменен",
  assignee_added: "Исполнитель добавлен",
  deadline_set: "Дедлайн установлен",
  tag_added: "Тег добавлен",
};

const actionLabels: Record<string, string> = {
  notify_assignees: "Уведомить исполнителей",
  notify_creator: "Уведомить создателя",
  add_tag: "Добавить тег",
  remove_tag: "Удалить тег",
  change_priority: "Изменить приоритет",
  assign_user: "Назначить пользователя",
  move_to_column: "Переместить в колонку",
  add_comment: "Добавить комментарий",
};

export function AutomationRuleList({ projectId }: AutomationRuleListProps) {
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useQuery<AutomationRule[]>({
    queryKey: ["automation-rules", projectId],
    queryFn: ({ signal }) => apiFetch<AutomationRule[]>(`/api/automation-rules?projectId=${projectId}`, { signal }),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const res = await fetch(`/api/automation-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error("Failed to update automation rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automation-rules", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/automation-rules/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete automation rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automation-rules", projectId] });
    },
  });

  if (isLoading) {
    return <div role="status" aria-live="polite" className="text-sm text-muted-foreground">Загрузка...</div>;
  }

  if (rules.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Zap className="h-12 w-12 mx-auto mb-2 opacity-50" />
        <p>Нет правил автоматизации</p>
        <p className="text-sm">Создайте правило для автоматизации задач</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rules.map((rule) => (
        <div
          key={rule.id}
          className="border rounded-lg p-4 space-y-3 hover:bg-accent/50 transition-colors"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h4 className="font-medium truncate break-words [overflow-wrap:anywhere] min-w-0 max-w-full">{rule.name}</h4>
                {!rule.active && (
                  <Badge variant="secondary" className="text-xs">
                    Неактивно
                  </Badge>
                )}
              </div>
              {rule.description && (
                <p className="text-sm text-muted-foreground line-clamp-2 break-words [overflow-wrap:anywhere]">
                  {rule.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                aria-label={`Активность: ${rule.name}`}
                checked={rule.active}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ id: rule.id, active: checked })
                }
                disabled={toggleMutation.isPending}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Удалить правило: ${rule.name}`}
                onClick={() => {
                  if (window.confirm(`Удалить правило «${rule.name}»? Это действие нельзя отменить.`)) {
                    deleteMutation.mutate(rule.id);
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Триггер: </span>
              <Badge variant="outline">{triggerLabels[rule.trigger] || rule.trigger}</Badge>
            </div>

            {rule.conditions.length > 0 && (
              <div>
                <span className="text-muted-foreground">Условия: </span>
                <span className="text-xs">
                  {rule.conditions.length} условий
                </span>
              </div>
            )}

            <div>
              <span className="text-muted-foreground">Действия: </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {rule.actions.map((action, idx) => (
                  <Badge key={idx} variant="secondary" className="text-xs">
                    {actionLabels[action.type] || action.type}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
              Создано {rule.createdBy.name || rule.createdBy.email} •{" "}
              {new Date(rule.createdAt).toLocaleDateString("ru-RU")}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
