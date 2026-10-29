"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X, Trash2 } from "lucide-react";
import { apiPost } from "@/lib/api";
import { TASK_PRIORITY_OPTIONS } from "@/lib/task-priority";

interface BulkActionsBarProps {
  canChangeStatus?: boolean;
  selectedTaskIds: string[];
  projectId: string;
  columns: Array<{ id: string; name: string }>;
  onClearSelection: () => void;
  onDeleteTasks?: (taskIds: string[]) => void | Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

export function BulkActionsBar({
  canChangeStatus = true,
  selectedTaskIds,
  projectId,
  columns,
  onClearSelection,
  onDeleteTasks,
  onPendingChange,
}: BulkActionsBarProps) {
  const queryClient = useQueryClient();
  const [bulkAction, setBulkAction] = useState<string>("");
  const [bulkValue, setBulkValue] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const uniqueIds = [...new Set(selectedTaskIds)];
  const liveRef = useRef({ projectId, ids: uniqueIds });
  liveRef.current = { projectId, ids: uniqueIds };
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Bulk update mutation
  const bulkUpdateMutation = useMutation({
    mutationFn: (data: {
      taskIds: string[];
      updates: Record<string, string>;
    }) =>
      apiPost("/api/tasks/bulk-update", data),
  });

  const runAction = async (kind: "update" | "delete", updates: Record<string, string> = {}) => {
    if (!canChangeStatus && (updates.columnId || updates.status)) return;
    if (pendingRef.current || uniqueIds.length === 0) return;
    const ids = [...uniqueIds];
    const targetProjectId = projectId;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    onPendingChange?.(true);
    try {
      if (kind === "delete") {
        if (!onDeleteTasks) return;
        await onDeleteTasks(ids);
      } else {
        await bulkUpdateMutation.mutateAsync({ taskIds: ids, updates });
        await queryClient.invalidateQueries({ queryKey: ["tasks", targetProjectId] });
        toast.success("Задачи обновлены", { description: `Обновлено задач: ${ids.length}` });
      }
      const current = liveRef.current;
      if (mountedRef.current && current.projectId === targetProjectId &&
          current.ids.length === ids.length && ids.every(id => current.ids.includes(id))) {
        onClearSelection();
        setBulkAction("");
        setBulkValue("");
      }
    } catch (failure) {
      if (mountedRef.current) setError(errorMessage(failure));
      toast.error(kind === "delete" ? "Не удалось удалить задачи" : "Не удалось обновить задачи");
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
      onPendingChange?.(false);
    }
  };

  const handleApplyBulkAction = () => {
    if (pendingRef.current) return;
    if (!bulkAction || !bulkValue) {
      toast.error("Выберите действие и значение");
      return;
    }

    const updates: Record<string, string> = {};

    switch (bulkAction) {
      case "priority":
        updates.priority = bulkValue;
        break;
      case "column":
        updates.columnId = bulkValue;
        break;
      default:
        toast.error("Неизвестное действие");
        return;
    }

    void runAction("update", updates);
  };

  const handleDeleteSelected = () => {
    if (pendingRef.current || !onDeleteTasks) return;
    if (
      confirm(
        `Вы уверены, что хотите удалить ${uniqueIds.length} задач(и)?`
      )
    ) {
      void runAction("delete");
    }
  };

  if (uniqueIds.length === 0) {
    return null;
  }

  return (
    <div role="region" aria-label="Массовые действия" aria-busy={pending} className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-1.5rem)] max-w-3xl">
      <div className="bg-card border shadow-lg rounded-lg p-3 flex max-h-[calc(100dvh-1.5rem)] flex-wrap items-center gap-3 min-w-0 overflow-y-auto">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            Выбрано: {uniqueIds.length}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClearSelection}
            aria-label="Снять выделение"
            disabled={pending}
            className="h-11 w-11 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="hidden h-6 w-px bg-border sm:block" />

        <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 sm:basis-auto sm:flex-1">
          <Select
            value={bulkAction}
            disabled={pending}
            onValueChange={(value) => {
              setBulkAction(value);
              setBulkValue("");
            }}
          >
            <SelectTrigger
              aria-label="Выберите действие"
              className="w-[180px] max-w-full min-h-11"
            >
              <SelectValue placeholder="Выберите действие" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="priority">Изменить приоритет</SelectItem>
              {canChangeStatus && <SelectItem value="column">Переместить</SelectItem>}
            </SelectContent>
          </Select>

          {bulkAction === "priority" && (
            <Select value={bulkValue} onValueChange={setBulkValue} disabled={pending}>
              <SelectTrigger aria-label="Выберите приоритет" className="w-[150px] max-w-full min-h-11">
                <SelectValue placeholder="Приоритет" />
              </SelectTrigger>
              <SelectContent>
                {TASK_PRIORITY_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          {bulkAction === "column" && (
            <Select value={bulkValue} onValueChange={setBulkValue} disabled={pending}>
              <SelectTrigger
                aria-label="Выберите колонку"
                className="w-[180px] max-w-full min-h-11"
              >
                <SelectValue placeholder="Колонка" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((column) => (
                  <SelectItem key={column.id} value={column.id}>
                    {column.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {bulkAction && bulkValue && (
            <Button
              size="sm"
              onClick={handleApplyBulkAction}
              disabled={pending}
              className="min-h-11"
            >
              Применить
            </Button>
          )}
        </div>

        <div className="hidden h-6 w-px bg-border sm:block" />

        <Button
          size="sm"
          variant="destructive"
          onClick={handleDeleteSelected}
          disabled={pending || !onDeleteTasks}
          className="min-h-11"
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Удалить
        </Button>
        {pending && <p role="status" className="w-full text-sm">Сохранение…</p>}
        {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
