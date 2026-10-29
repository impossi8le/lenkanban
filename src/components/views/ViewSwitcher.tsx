"use client";

import { motion } from "motion/react";
import { LayoutGrid, Table2, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";

export type ViewType = "board" | "table" | "calendar";

interface ViewSwitcherProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  className?: string;
}

const views = [
  { id: "board" as ViewType, label: "Доска", icon: LayoutGrid },
  { id: "table" as ViewType, label: "Таблица", icon: Table2 },
  { id: "calendar" as ViewType, label: "Календарь", icon: Calendar },
];

export function ViewSwitcher({ currentView, onViewChange, className }: ViewSwitcherProps) {
  return (
    <div role="group" aria-label="Представление проекта" className={cn("inline-flex min-w-0 shrink-0 flex-wrap items-center rounded-lg border bg-card p-[3px]", className)}>
      {views.map((view) => {
        const Icon = view.icon;
        const isActive = currentView === view.id;
        
        return (
          <button
            type="button"
            aria-label={view.label}
            aria-pressed={isActive}
            key={view.id}
            onClick={() => onViewChange(view.id)}
            className={cn(
              "relative inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
              "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            {isActive && (
              <motion.div
                layoutId="activeView"
                className="absolute inset-0 rounded-md bg-muted"
                transition={{
                  type: "spring",
                  stiffness: 380,
                  damping: 30,
                }}
              />
            )}
            <Icon className="relative h-4 w-4" />
            <span className="relative hidden sm:inline">{view.label}</span>
          </button>
        );
      })}
    </div>
  );
}
