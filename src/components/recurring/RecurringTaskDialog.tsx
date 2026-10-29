"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Calendar, Repeat } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch } from "@/lib/api";
import { TASK_PRIORITY_OPTIONS } from "@/lib/task-priority";
import { useToast } from "@/hooks/use-toast";

interface RecurringTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

interface RecurringTaskInput {
  projectId: string;
  name: string;
  description: string;
  taskTitle: string;
  taskDescription: string;
  priority: string;
  frequency: string;
  interval: number;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
  tags: string[];
  checklistItems: string[];
  assigneeIds: string[];
}

const frequencyLabels: Record<string, string> = {
  daily: "Ежедневно",
  weekly: "Еженедельно",
  monthly: "Ежемесячно",
  yearly: "Ежегодно",
};

const daysOfWeekLabels = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export function RecurringTaskDialog({ open, onOpenChange, projectId }: RecurringTaskDialogProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [priority, setPriority] = useState("LOW");
  const [frequency, setFrequency] = useState("daily");
  const [interval, setInterval] = useState(1);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [dayOfMonth, setDayOfMonth] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0]);
  const [endDate, setEndDate] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createRecurringTaskMutation = useMutation({
    mutationFn: async (data: RecurringTaskInput) => {
      return apiFetch("/api/recurring-tasks", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring-tasks", projectId] });
      toast({
        title: "Повторяющаяся задача создана",
        description: "Задачи будут создаваться автоматически по расписанию",
      });
      resetForm();
      onOpenChange(false);
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось создать повторяющуюся задачу",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setName("");
    setDescription("");
    setTaskTitle("");
    setTaskDescription("");
    setPriority("LOW");
    setFrequency("daily");
    setInterval(1);
    setDaysOfWeek([]);
    setDayOfMonth(null);
    setStartDate(new Date().toISOString().split("T")[0]);
    setEndDate("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim() || !taskTitle.trim()) {
      toast({
        title: "Ошибка",
        description: "Заполните обязательные поля",
        variant: "destructive",
      });
      return;
    }

    createRecurringTaskMutation.mutate({
      projectId,
      name,
      description,
      taskTitle,
      taskDescription,
      priority,
      frequency,
      interval,
      daysOfWeek: frequency === "weekly" ? daysOfWeek : [],
      dayOfMonth: frequency === "monthly" ? dayOfMonth : null,
      startDate,
      endDate: endDate || null,
      tags: [],
      checklistItems: [],
      assigneeIds: [],
    });
  };

  const toggleDayOfWeek = (day: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:max-w-[600px] sm:p-6"
        onOpenAutoFocus={() => {
          openerRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        }}
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          if (opener?.isConnected && opener !== document.body) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        <form onSubmit={handleSubmit} className="min-w-0">
          <DialogHeader>
            <DialogTitle className="flex min-w-0 items-start gap-2 pr-6 text-left">
              <Repeat className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">Создать повторяющуюся задачу</span>
            </DialogTitle>
            <DialogDescription>
              Задачи будут создаваться автоматически по указанному расписанию
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Название правила *</Label>
              <Input
                id="name"
                placeholder="Например: Еженедельный отчет"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={createRecurringTaskMutation.isPending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Описание правила</Label>
              <Textarea
                id="description"
                placeholder="Опишите цель этого правила"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={createRecurringTaskMutation.isPending}
                rows={2}
              />
            </div>

            <div className="border-t pt-4 space-y-4">
              <h4 className="font-medium text-sm">Параметры задачи</h4>

              <div className="space-y-2">
                <Label htmlFor="task-title">Заголовок задачи *</Label>
                <Input
                  id="task-title"
                  placeholder="Заголовок создаваемой задачи"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  disabled={createRecurringTaskMutation.isPending}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="task-description">Описание задачи</Label>
                <Textarea
                  id="task-description"
                  placeholder="Описание создаваемой задачи"
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  disabled={createRecurringTaskMutation.isPending}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="priority">Приоритет</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id="priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_PRIORITY_OPTIONS.map(({value, label}) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="border-t pt-4 space-y-4">
              <h4 className="font-medium text-sm flex items-center gap-2">
                <Calendar className="h-4 w-4" aria-hidden="true" />
                Расписание
              </h4>

              <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="frequency">Частота</Label>
                  <Select value={frequency} onValueChange={setFrequency}>
                    <SelectTrigger id="frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(frequencyLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="min-w-0 space-y-2">
                  <Label htmlFor="interval">Интервал</Label>
                  <Input
                    id="interval"
                    type="number"
                    min="1"
                    value={interval}
                    onChange={(e) => setInterval(parseInt(e.target.value) || 1)}
                    disabled={createRecurringTaskMutation.isPending}
                  />
                  <p className="text-xs text-muted-foreground">
                    Каждые {interval} {frequency === "daily" ? "дней" : frequency === "weekly" ? "недель" : frequency === "monthly" ? "месяцев" : "лет"}
                  </p>
                </div>
              </div>

              {frequency === "weekly" && (
                <div className="space-y-2">
                  <Label>Дни недели</Label>
                  <div className="flex flex-wrap gap-2">
                    {daysOfWeekLabels.map((label, index) => (
                      <div key={index} className="flex items-center">
                        <Checkbox
                          id={`day-${index}`}
                          checked={daysOfWeek.includes(index)}
                          onCheckedChange={() => toggleDayOfWeek(index)}
                        />
                        <label
                          htmlFor={`day-${index}`}
                          className="ml-1 text-sm cursor-pointer"
                        >
                          {label}
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {frequency === "monthly" && (
                <div className="space-y-2">
                  <Label htmlFor="day-of-month">День месяца</Label>
                  <Input
                    id="day-of-month"
                    type="number"
                    min="1"
                    max="31"
                    placeholder="1-31"
                    value={dayOfMonth || ""}
                    onChange={(e) => setDayOfMonth(parseInt(e.target.value) || null)}
                    disabled={createRecurringTaskMutation.isPending}
                  />
                </div>
              )}

              <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="start-date">Дата начала *</Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    disabled={createRecurringTaskMutation.isPending}
                  />
                </div>

                <div className="min-w-0 space-y-2">
                  <Label htmlFor="end-date">Дата окончания</Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    disabled={createRecurringTaskMutation.isPending}
                  />
                  <p className="text-xs text-muted-foreground">Опционально</p>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="flex flex-col-reverse sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
              disabled={createRecurringTaskMutation.isPending}
            >
              Отмена
            </Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={createRecurringTaskMutation.isPending}>
              {createRecurringTaskMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
