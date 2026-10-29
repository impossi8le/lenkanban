"use client";

import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bookmark,
  FileText,
  Repeat,
  Zap,
  Settings,
  FolderOpen,
  Columns,
  Users,
} from "lucide-react";

interface BoardOptionsMenuProps {
  onSavedViews: () => void;
  onTemplates: () => void;
  onRecurringTasks: () => void;
  onAutomation: () => void;
  onSettings: () => void;
  onSaveAsTemplate: () => void;
  onMembers: () => void;
  onColumns: () => void;
  canManage: boolean;
}

export function BoardOptionsMenu({
  onSavedViews,
  onTemplates,
  onRecurringTasks,
  onAutomation,
  onSettings,
  onSaveAsTemplate,
  onMembers,
  onColumns,
  canManage,
}: BoardOptionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label="Дополнительно" className="h-11 shrink-0 gap-2 rounded-lg px-3">
          <MoreVertical className="h-4 w-4" />
          <span className="hidden sm:inline">Дополнительно</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        className="w-[min(14rem,calc(100vw-1rem))] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain [&_[role=menuitem]]:min-h-11 [&_[role=menuitem]]:whitespace-normal [&_[role=menuitem]]:break-words [&_svg]:shrink-0"
      >
        {/* Часто используемые */}
        <DropdownMenuItem onClick={onSavedViews}>
          <Bookmark className="mr-2 h-4 w-4" />
          Представления
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onTemplates}>
          <FileText className="mr-2 h-4 w-4" />
          Шаблоны
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onMembers}>
          <Users className="mr-2 h-4 w-4" />
          Участники
        </DropdownMenuItem>
        {canManage && (
          <>
            <DropdownMenuItem onClick={onColumns}>
              <Columns className="mr-2 h-4 w-4" />
              Колонки
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSettings}>
              <Settings className="mr-2 h-4 w-4" />
              Название проекта
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSaveAsTemplate}>
              <FolderOpen className="mr-2 h-4 w-4" />
              Сохранить как шаблон
            </DropdownMenuItem>
          </>
        )}
        {/* Разделитель */}
        {canManage && (
          <div className="h-px bg-border my-1" />
        )}
        {/* Редко используемые */}
        <DropdownMenuItem onClick={onRecurringTasks}>
          <Repeat className="mr-2 h-4 w-4" />
          Повторяющиеся задачи
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAutomation}>
          <Zap className="mr-2 h-4 w-4" />
          Автоматизация
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
