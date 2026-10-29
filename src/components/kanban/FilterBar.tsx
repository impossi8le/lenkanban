"use client";

import { useState } from "react";
import { X, ArrowUpDown, Check } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const filterTriggerClassName =
  "h-11 w-full min-w-0 sm:w-[180px] [&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate [&>span]:text-left [&>svg]:shrink-0";
const filterContentClassName =
  "w-[min(20rem,calc(100vw-1rem))] min-w-0 max-h-[var(--radix-select-content-available-height)] [&_[role=option]]:min-h-11 [&_[role=option]]:whitespace-normal [&_[role=option]]:break-words [&_[role=option]>span:last-child]:min-w-0";

interface FilterBarProps {
  status: string | null;
  priority: string | null;
  assignee: string | null;
  tags: string[] | null;
  sortBy: string;
  onStatusChange: (value: string | null) => void;
  onPriorityChange: (value: string | null) => void;
  onAssigneeChange: (value: string | null) => void;
  onTagsChange: (value: string[] | null) => void;
  onSortChange: (value: string) => void;
  showSort?: boolean;
  columns?: Array<{ id: string; name: string }>;
  projectMembers?: Array<{
    userId: string;
    user?: { name: string; email: string };
  }>;
  projectTags?: Array<{ id: string; name: string; color: string }>;
}

export function FilterBar({
  status,
  priority,
  assignee,
  tags,
  sortBy,
  onStatusChange,
  onPriorityChange,
  onAssigneeChange,
  onTagsChange,
  onSortChange,
  showSort = true,
  columns = [],
  projectMembers = [],
  projectTags = [],
}: FilterBarProps) {
  const [tagsOpen, setTagsOpen] = useState(false);

  const hasActiveFilters =
    status || priority || assignee || (tags && tags.length > 0);

  const clearFilters = () => {
    onStatusChange(null);
    onPriorityChange(null);
    onAssigneeChange(null);
    onTagsChange(null);
  };

  const selectedTagSet = new Set(tags ?? []);

  const toggleTag = (tagId: string) => {
    const next = new Set(selectedTagSet);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    onTagsChange(next.size > 0 ? Array.from(next) : null);
  };

  const selectedTagLabel =
    (tags?.length ?? 0) === 0
      ? "Все теги"
      : tags!.length === 1
        ? projectTags.find((t) => t.id === tags![0])?.name ?? `${tags!.length} тег`
        : `${tags!.length} тега`;

  return (
    <div className="mb-2 grid min-w-0 grid-cols-2 items-center gap-2 sm:mb-4 sm:flex sm:flex-wrap">
      <Select
        value={status || "all"}
        onValueChange={(v) => onStatusChange(v === "all" ? null : v)}
      >
        <SelectTrigger
          aria-label="Фильтр по колонке"
          className={filterTriggerClassName}
        >
          <SelectValue placeholder="Колонка" />
        </SelectTrigger>
        <SelectContent className={filterContentClassName} collisionPadding={8}>
          <SelectItem value="all">Все колонки</SelectItem>
          {columns.map((column) => (
            <SelectItem key={column.id} value={column.id}>
              {column.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={priority || "all"}
        onValueChange={(v) => onPriorityChange(v === "all" ? null : v)}
      >
        <SelectTrigger
          aria-label="Фильтр по приоритету"
          className={filterTriggerClassName}
        >
          <SelectValue placeholder="Приоритет" />
        </SelectTrigger>
        <SelectContent className={filterContentClassName} collisionPadding={8}>
          <SelectItem value="all">Все приоритеты</SelectItem>
          <SelectItem value="CRITICAL">🚨 Критический</SelectItem>
          <SelectItem value="URGENT">🔴 Срочно</SelectItem>
          <SelectItem value="HIGH">🟠 Высокий</SelectItem>
          <SelectItem value="MEDIUM">🟡 Средний</SelectItem>
          <SelectItem value="LOW">🔵 Низкий</SelectItem>
        </SelectContent>
      </Select>

      {projectMembers.length > 0 && (
        <Select
          value={assignee || "all"}
          onValueChange={(v) => onAssigneeChange(v === "all" ? null : v)}
        >
          <SelectTrigger
            aria-label="Фильтр по исполнителю"
            className={filterTriggerClassName}
          >
            <SelectValue placeholder="Исполнители" />
          </SelectTrigger>
          <SelectContent
            className={filterContentClassName}
            collisionPadding={8}
          >
            <SelectItem value="all">Все исполнители</SelectItem>
            <SelectItem value="unassigned">Без исполнителя</SelectItem>
            {projectMembers.map((member) => (
              <SelectItem key={member.userId} value={member.userId}>
                {member.user?.name || member.user?.email || "Unknown"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {projectTags.length > 0 && (
        <Popover open={tagsOpen} onOpenChange={setTagsOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-label="Фильтр по тегам"
              className={cn(
                filterTriggerClassName,
                "justify-start gap-2 font-normal hover:bg-accent",
                tags && tags.length > 0 && "border-primary"
              )}
            >
              {tags && tags.length > 0 && (
                <Badge
                  variant="secondary"
                  className="h-5 px-1.5 text-xs font-normal shrink-0"
                >
                  {tags.length}
                </Badge>
              )}
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedTagLabel}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[min(20rem,calc(100vw-1rem))] p-0"
            align="start"
            collisionPadding={8}
          >
            <div className="max-h-[min(24rem,var(--radix-popover-content-available-height))] overflow-auto p-2">
              <button
                type="button"
                onClick={() => onTagsChange(null)}
                className="flex w-full min-h-11 items-center gap-2 rounded-sm px-2 py-2 text-sm text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {!tags || tags.length === 0 ? (
                  <Check className="h-4 w-4 shrink-0 rounded-sm border bg-primary text-primary-foreground p-0.5" />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded-sm border" />
                )}
                <span className="flex-1">Все теги</span>
              </button>
              {projectTags.map((tag) => {
                const checked = selectedTagSet.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={cn(
                      "flex w-full min-h-11 items-center gap-2 rounded-sm px-2 py-2 text-sm text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      checked && "font-medium",
                    )}
                  >
                    {checked ? (
                      <Check className="h-4 w-4 shrink-0 rounded-sm border bg-primary text-primary-foreground p-0.5" />
                    ) : (
                      <span className="h-4 w-4 shrink-0 rounded-sm border" />
                    )}
                    <div
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="min-w-0 flex-1 break-words">{tag.name}</span>
                    {checked ? <Check className="h-4 w-4 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-11"
          aria-label="Сбросить фильтры"
          onClick={clearFilters}
        >
          <X className="mr-2 h-4 w-4" />
          <span className="hidden sm:inline">Сбросить</span>
          <span className="sm:hidden">Сбросить</span>
        </Button>
      )}

      {showSort && (
        <div className="flex min-w-0 items-center gap-2">
          <Select value={sortBy} onValueChange={onSortChange}>
            <SelectTrigger
              aria-label="Сортировка задач"
              className={filterTriggerClassName}
            >
              <ArrowUpDown className="mr-2 h-4 w-4" />
              <SelectValue placeholder="Сортировка" />
            </SelectTrigger>
            <SelectContent
              className={filterContentClassName}
              collisionPadding={8}
            >
              <SelectItem value="position">По позиции</SelectItem>
              <SelectItem value="created-desc">Новые первыми</SelectItem>
              <SelectItem value="created-asc">Старые первыми</SelectItem>
              <SelectItem value="updated-desc">Недавно обновленные</SelectItem>
              <SelectItem value="updated-asc">Давно обновленные</SelectItem>
              <SelectItem value="deadline-asc">
                Дедлайн (ближайшие)
              </SelectItem>
              <SelectItem value="deadline-desc">Дедлайн (дальние)</SelectItem>
              <SelectItem value="priority-desc">
                Приоритет (высокий)
              </SelectItem>
              <SelectItem value="priority-asc">Приоритет (низкий)</SelectItem>
              <SelectItem value="title-asc">По названию (А-Я)</SelectItem>
              <SelectItem value="title-desc">По названию (Я-А)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
