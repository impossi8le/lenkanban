"use client";

import { useSession } from "next-auth/react";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ProjectColumn {
  id: string;
  name: string;
  position: number;
}

export interface TaskColumnSelectorProps {
  projectId: string;
  columnId?: string | null;
  onChange: (columnId: string) => void;
  disabled?: boolean;
  className?: string;
}

export function TaskColumnSelector({ projectId, columnId, onChange, disabled = false, className }: TaskColumnSelectorProps) {
  const { data: session } = useSession();
  const actorId = session?.user?.id;
  const permission = useQuery({
    queryKey: ["task-status-permission", actorId, projectId],
    queryFn: ({ signal }) => apiFetch<{ canChangeStatus: boolean }>(`/api/projects/${projectId}/task-permissions`, { signal }),
    enabled: Boolean(actorId),
  });
  const { data: columns = [], isPending, isError } = useQuery({
    queryKey: ["columns", projectId],
    queryFn: ({ signal }) => apiFetch<ProjectColumn[]>(`/api/projects/${projectId}/columns`, { signal }),
  });
  const selectedColumn = columns.find(column => column.id === columnId);
  const unavailable = disabled || !actorId || permission.data?.canChangeStatus !== true || isPending || isError || columns.length === 0;
  const placeholder = isPending ? "Загрузка колонок…"
    : isError ? "Колонки недоступны"
      : columns.length === 0 ? "В проекте нет колонок" : "Выберите колонку";

  return (
    <div className="min-w-0">
      <Select
        key={projectId}
        value={selectedColumn?.id ?? ""}
        disabled={unavailable}
        onValueChange={value => {
          if (!unavailable && value !== columnId && columns.some(column => column.id === value)) {
            onChange(value);
          }
        }}
      >
        <SelectTrigger aria-label="Колонка задачи" className={cn("min-w-0 [&>span]:min-w-0 [&>span]:truncate", className)}>
          <SelectValue placeholder={placeholder}>{selectedColumn?.name}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-w-[calc(100vw-1rem)] max-h-[var(--radix-select-content-available-height)]">
          {columns.map(column => <SelectItem className="min-h-11 min-w-0 whitespace-normal [overflow-wrap:anywhere] [&>span:last-child]:min-w-0" key={column.id} value={column.id}>{column.name}</SelectItem>)}
        </SelectContent>
      </Select>
      {isError && <p role="alert" className="mt-1 text-xs text-destructive">Не удалось загрузить колонки</p>}
    </div>
  );
}
