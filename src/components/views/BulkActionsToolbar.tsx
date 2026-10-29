"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import type { TaskType } from "@/components/kanban/Card";
import { TASK_PRIORITY_OPTIONS } from "@/lib/task-priority";

interface BulkActionsToolbarProps {
  selectedTasks: TaskType[];
  onClearSelection: () => void;
  projectId: string;
  columns: Array<{ id: string; name: string }>;
}

export function BulkActionsToolbar({
  selectedTasks,
  onClearSelection,
  projectId,
  columns,
}: BulkActionsToolbarProps) {
  const queryClient = useQueryClient();
  const [isUpdating, setIsUpdating] = useState(false);

  const bulkUpdateMutation = useMutation({
    mutationFn: async (updates: {
      columnId?: string;
      priority?: string;
    }) => {
      setIsUpdating(true);
      return apiFetch("/api/tasks/bulk", {
        method: "PATCH",
        body: JSON.stringify({
          taskIds: selectedTasks.map((t) => t.id),
          updates,
        }),
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
      onClearSelection();
      
      const updateType = variables.columnId ? "колонка" : "приоритет";
      toast.success(`Обновлено ${selectedTasks.length} задач`, {
        description: `Изменен ${updateType} для выбранных задач`,
      });
    },
    onError: () => {
      toast.error("Ошибка при обновлении задач");
    },
    onSettled: () => {
      setIsUpdating(false);
    },
  });

  const handleColumnChange = (columnId: string) => {
    bulkUpdateMutation.mutate({ columnId });
  };

  const handlePriorityChange = (priority: string) => {
    bulkUpdateMutation.mutate({ priority });
  };

  return (
    <div role="region" aria-label="Действия с выбранными задачами" className="flex min-w-0 flex-wrap items-center gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
      <div className="flex min-w-0 items-center gap-2">
        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
          <span className="text-sm font-semibold text-primary">
            {selectedTasks.length}
          </span>
        </div>
        <span className="text-sm font-medium">
          {selectedTasks.length === 1 ? "задача выбрана" : "задач выбрано"}
        </span>
      </div>

      <div className="hidden h-6 w-px bg-border lg:block" />

      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
        <Select onValueChange={handleColumnChange} disabled={isUpdating}>
          <SelectTrigger
            aria-label="Изменить колонку"
            className="h-11 min-w-0 w-full sm:w-[180px] [&>span]:truncate"
          >
            <SelectValue placeholder="Изменить колонку" />
          </SelectTrigger>
          <SelectContent>
            {columns.map((column) => (
              <SelectItem key={column.id} value={column.id}>
                {column.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select onValueChange={handlePriorityChange} disabled={isUpdating}>
          <SelectTrigger
            aria-label="Изменить приоритет"
            className="h-11 min-w-0 w-full sm:w-[180px] [&>span]:truncate"
          >
            <SelectValue placeholder="Изменить приоритет" />
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

      <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:ml-auto sm:w-auto">
        {isUpdating && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Обновление...</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-11"
          onClick={onClearSelection}
          disabled={isUpdating}
        >
          <X className="h-4 w-4 mr-1" />
          Отменить
        </Button>
      </div>
    </div>
  );
}
