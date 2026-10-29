"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import { AUTOMATION_ACTION_TYPES, AUTOMATION_ACTION_LABELS, parseAutomationActions, type AutomationNotificationAction } from "@/lib/automation-actions";

interface Condition {
  field: string;
  operator: string;
  value: string;
}

type Action = AutomationNotificationAction;

interface CreateAutomationRuleInput {
  projectId: string;
  name: string;
  description: string;
  trigger: string;
  conditions: Condition[];
  actions: Action[];
}

interface AutomationRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function AutomationRuleDialog({ open, onOpenChange, projectId }: AutomationRuleDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState("task_created");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [actions, setActions] = useState<Action[]>([]);

  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (data: CreateAutomationRuleInput) => {
      const res = await fetch("/api/automation-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create automation rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automation-rules", projectId] });
      onOpenChange(false);
      resetForm();
    },
  });

  const resetForm = () => {
    setName("");
    setDescription("");
    setTrigger("task_created");
    setConditions([]);
    setActions([]);
  };

  const addCondition = () => {
    setConditions([...conditions, { field: "status", operator: "equals", value: "" }]);
  };

  const removeCondition = (index: number) => {
    setConditions(conditions.filter((_, i) => i !== index));
  };

  const updateCondition = (index: number, updates: Partial<Condition>) => {
    setConditions(conditions.map((c, i) => (i === index ? { ...c, ...updates } : c)));
  };

  const addAction = () => {
    setActions([...actions, { type: "notify_assignees", params: {} }]);
  };

  const removeAction = (index: number) => {
    setActions(actions.filter((_, i) => i !== index));
  };

  const updateAction = (index: number, updates: Partial<Action>) => {
    setActions(actions.map((a, i) => (i === index ? { ...a, ...updates } : a)));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const admittedActions = parseAutomationActions(actions);
    if (!admittedActions) return;
    createMutation.mutate({
      projectId,
      name,
      description,
      trigger,
      conditions,
      actions: admittedActions,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 min-w-0 [overflow-wrap:anywhere]">
        <DialogHeader>
          <DialogTitle className="break-words [overflow-wrap:anywhere]">Создать правило автоматизации</DialogTitle>
          <DialogDescription className="break-words [overflow-wrap:anywhere]">Выберите событие и условия уведомления. Назначения и рабочие статусы меняют люди.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="min-w-0 space-y-4">
          <div>
            <Label htmlFor="name">Название</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Уведомить при завершении"
              required
            />
          </div>

          <div>
            <Label htmlFor="description">Описание</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Отправить уведомление исполнителям когда задача завершена"
            />
          </div>

          <div>
            <Label htmlFor="trigger">Триггер</Label>
            <Select value={trigger} onValueChange={setTrigger}>
              <SelectTrigger id="trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="task_created">Задача создана</SelectItem>
                <SelectItem value="status_changed">Статус изменен</SelectItem>
                <SelectItem value="priority_changed">Приоритет изменен</SelectItem>
                <SelectItem value="assignee_added">Исполнитель добавлен</SelectItem>
                <SelectItem value="deadline_set">Дедлайн установлен</SelectItem>
                <SelectItem value="tag_added">Тег добавлен</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Условия</Label>
              <Button type="button" variant="outline" size="sm" onClick={addCondition}>
                <Plus className="h-4 w-4 mr-1" />
                Добавить условие
              </Button>
            </div>
            {conditions.map((condition, index) => (
              <div key={index} className="mb-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <Select
                  value={condition.field}
                  onValueChange={(value) => updateCondition(index, { field: value })}
                >
                  <SelectTrigger aria-label={`Поле условия ${index + 1}`} className="col-span-2 min-w-0 w-full sm:col-span-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="status">Статус</SelectItem>
                    <SelectItem value="priority">Приоритет</SelectItem>
                    <SelectItem value="assignee_count">Кол-во исполнителей</SelectItem>
                    <SelectItem value="tag_count">Кол-во тегов</SelectItem>
                    <SelectItem value="has_deadline">Есть дедлайн</SelectItem>
                    <SelectItem value="is_overdue">Просрочена</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={condition.operator}
                  onValueChange={(value) => updateCondition(index, { operator: value })}
                >
                  <SelectTrigger aria-label={`Оператор условия ${index + 1}`} className="col-span-2 min-w-0 w-full sm:col-span-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="equals">Равно</SelectItem>
                    <SelectItem value="not_equals">Не равно</SelectItem>
                    <SelectItem value="contains">Содержит</SelectItem>
                    <SelectItem value="not_contains">Не содержит</SelectItem>
                    <SelectItem value="greater_than">Больше</SelectItem>
                    <SelectItem value="less_than">Меньше</SelectItem>
                    <SelectItem value="is_empty">Пусто</SelectItem>
                    <SelectItem value="is_not_empty">Не пусто</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={condition.value}
                  onChange={(e) => updateCondition(index, { value: e.target.value })}
                  placeholder="Значение"
                  aria-label={`Значение условия ${index + 1}`}
                  className="min-w-0"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeCondition(index)}
                  aria-label={`Удалить условие ${index + 1}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Действия</Label>
              <Button type="button" variant="outline" size="sm" onClick={addAction}>
                <Plus className="h-4 w-4 mr-1" />
                Добавить действие
              </Button>
            </div>
            {actions.map((action, index) => (
              <div key={index} className="space-y-2 mb-4 p-3 border rounded-lg">
                <div className="flex gap-2">
                  <Select
                    value={action.type}
                    onValueChange={(value) => {
                      const type = AUTOMATION_ACTION_TYPES.find(item => item === value);
                      if (type) updateAction(index, { type, params: {} });
                    }}
                  >
                    <SelectTrigger aria-label={`Тип действия ${index + 1}`} className="min-w-0 flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AUTOMATION_ACTION_TYPES.map(type => (
                        <SelectItem key={type} value={type}>{AUTOMATION_ACTION_LABELS[type]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeAction(index)}
                    aria-label={`Удалить действие ${index + 1}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                {(action.type === "notify_assignees" || action.type === "notify_creator") && (
                  <div className="space-y-2">
                    <Input
                      value={action.params.title || ""}
                      onChange={(e) =>
                        updateAction(index, {
                          params: { ...action.params, title: e.target.value },
                        })
                      }
                      placeholder="Заголовок уведомления"
                    />
                    <Input
                      value={action.params.message || ""}
                      onChange={(e) =>
                        updateAction(index, {
                          params: { ...action.params, message: e.target.value },
                        })
                      }
                      placeholder="Текст уведомления"
                    />
                  </div>
                )}

              </div>
            ))}
          </div>

          {createMutation.isError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-[var(--danger-muted)] p-3 text-sm text-[var(--danger-bright)]">
              Не удалось создать правило. Проверьте соединение и повторите попытку.
            </p>
          )}
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={createMutation.isPending || actions.length === 0}>
              {createMutation.isPending ? "Создание..." : "Создать правило"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
