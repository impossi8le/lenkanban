"use client";

import { useDroppable } from "@dnd-kit/core";
import { useDroppable as useModernDroppable } from "@dnd-kit/react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { KanbanCard, TaskType } from "./Card";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import { EmptyColumn } from "@/components/shared/empty-state";
import { SortableKanbanCard } from "@/features/kanban/dnd/SortableKanbanCard";

interface KanbanColumnProps {
  canChangeStatus?: boolean;
  canCreate?: boolean;
  id: string;
  title: string;
  color: string;
  tasks: TaskType[];
  onCreateTask: (input: { title: string; columnId: string }) => void;
  onOpenTask?: (task: TaskType) => void;
  selectedTaskIds?: readonly string[];
  onToggleTaskSelect?: (taskId: string) => void;
  selectionDisabled?: boolean;
}

export function KanbanColumn({ id, title, color, tasks, onCreateTask, canCreate = true, canChangeStatus = true, selectedTaskIds = [], onToggleTaskSelect, selectionDisabled = false }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: {
      type: "Column",
    },
  });

  const [isCreating, setIsCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const isSubmittingRef = useRef(false);

  const submitCreate = () => {
    if (!canCreate) return;
    // Prevent double submission
    if (isSubmittingRef.current) {
      return;
    }

    const trimmed = draftTitle.trim();
    if (!trimmed) {
      setIsCreating(false);
      setDraftTitle("");
      isSubmittingRef.current = false;
      return;
    }

    isSubmittingRef.current = true;
    onCreateTask({ title: trimmed, columnId: id });
    setIsCreating(false);
    setDraftTitle("");

    // Reset the flag after a short delay to allow the next submission
    setTimeout(() => {
      isSubmittingRef.current = false;
    }, 300);
  };

  const indicatorColor = color;

  return (
    <motion.div
      data-column-id={id}
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      ref={setNodeRef}
      style={{
        backgroundColor: "var(--surface-column)",
        borderColor: "var(--border-muted)",
      }}
      className={cn(
        "workspace-column flex min-h-0 min-w-0 flex-col flex-shrink-0 w-[280px] sm:w-[300px] md:w-[320px] h-full rounded-xl p-3 border",
        isOver && "ring-2 ring-primary/20"
      )}
    >
      <div className="workspace-column-header flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
        <h3 className="min-w-0 font-bold text-sm flex items-center gap-2.5 tracking-tight">
          <div
            className="w-2 h-2 shrink-0 rounded-full"
            style={{ backgroundColor: indicatorColor }}
          />
          <span className="min-w-0 line-clamp-3 [overflow-wrap:anywhere]" title={title}>{title}</span>
          <motion.span
            key={tasks.length}
            initial={{ scale: 1.3, opacity: 1 }}
            animate={{ scale: 1, opacity: 1 }}
            className="workspace-column-count shrink-0"
          >
            {tasks.length}
          </motion.span>
        </h3>
        {canCreate && <motion.button
          type="button"
          onClick={() => {
            onCreateTask({ title: "", columnId: id });
          }}

          whileTap={{ scale: 0.92 }}
          className="workspace-column-add inline-flex min-h-11 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors cursor-pointer"
          style={{ width: "auto" }}
          aria-label="Добавить обращение"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Добавить обращение</span>
        </motion.button>}
      </div>

      <div data-kanban-column-scroll role="region" aria-label={`Задачи колонки «${title}»`} tabIndex={0} className="flex flex-col gap-3 min-h-0 flex-1 overflow-y-auto overscroll-y-contain rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <AnimatePresence mode="popLayout">
          {canCreate && isCreating && (
            <motion.div
              key="creating"
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 350, damping: 28 }}
              className="min-w-0 shrink-0 bg-card rounded-2xl border-2 border-primary/20 p-4 shadow-lg"
            >
              <input
                autoFocus
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Название задачи…"
                className="min-h-11 min-w-0 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCreate();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setIsCreating(false);
                    setDraftTitle("");
                  }
                }}
                onBlur={() => submitCreate()}
              />
              <div className="mt-2 text-[11px] text-muted-foreground flex flex-wrap items-center gap-2">
                <kbd className="px-2 py-1 bg-gradient-to-b from-secondary to-slate-300 dark:from-slate-600 dark:to-slate-700 rounded-md text-[10px] font-bold shadow-sm">Enter</kbd> создать
                <kbd className="px-2 py-1 bg-gradient-to-b from-secondary to-slate-300 dark:from-slate-600 dark:to-slate-700 rounded-md text-[10px] font-bold shadow-sm">Esc</kbd> отменить
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {/* A transferred task must unmount here immediately: retaining an
              exiting sortable duplicates its ID in the destination column. */}
          {tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              canMove={canChangeStatus}
              isSelected={selectedTaskIds.includes(task.id)}
              onTaskSelect={onToggleTaskSelect}
              selectionDisabled={selectionDisabled}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 && !isCreating && (
          <motion.div
            initial={{ opacity: 1, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.3 }}
          >
            <EmptyColumn description="Здесь появятся заявки в этом статусе." />
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}

export interface KanbanDndColumnProps {
  canCreate?: boolean;
  id: string;
  title: string;
  color: string;
  tasks: TaskType[];
  reorderEnabled: boolean;
  pendingTaskIds: ReadonlySet<string>;
  onCreateTask: (input: { title: string; columnId: string }) => void;
  onOpenTask?: (task: TaskType) => void;
  selectedTaskIds?: readonly string[];
  onToggleTaskSelect?: (taskId: string) => void;
  selectionDisabled?: boolean;
}

export function KanbanDndColumn({
  id,
  title,
  color,
  tasks,
  reorderEnabled,
  pendingTaskIds,
  onCreateTask,
  canCreate = true,
  onOpenTask,
  selectedTaskIds = [],
  onToggleTaskSelect,
  selectionDisabled = false,
}: KanbanDndColumnProps): React.ReactElement {
  const { ref, isDropTarget } = useModernDroppable({
    id,
    type: "column",
    accept: "task",
    collisionPriority: CollisionPriority.Low,
    data: {
      columnId: id,
      columnTitle: title,
      taskCount: tasks.length,
    },
  });
  const [isCreating, setIsCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const isSubmittingRef = useRef(false);

  const submitCreate = () => {
    if (!canCreate) return;
    if (isSubmittingRef.current) {
      return;
    }

    const title = draftTitle.trim();
    if (!title) {
      setIsCreating(false);
      setDraftTitle("");
      return;
    }

    isSubmittingRef.current = true;
    onCreateTask({ title, columnId: id });
    setIsCreating(false);
    setDraftTitle("");
    window.setTimeout(() => {
      isSubmittingRef.current = false;
    }, 300);
  };

  return (
    <motion.div
      ref={ref}
      data-column-id={id}
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{
        backgroundColor: "var(--surface-column)",
        borderColor: "var(--border-muted)",
      }}
      className={cn(
        "workspace-column flex min-h-0 min-w-0 flex-col flex-shrink-0 w-[280px] sm:w-[300px] md:w-[320px] h-full rounded-xl p-3 border",
        isDropTarget && "ring-2 ring-primary/20",
      )}
    >
      <div className="workspace-column-header flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
        <h3 className="min-w-0 font-bold text-sm flex items-center gap-2.5 tracking-tight">
          <span
            className="w-2 h-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="min-w-0 line-clamp-3 [overflow-wrap:anywhere]" title={title}>{title}</span>
          <span className="workspace-column-count shrink-0">
            {tasks.length}
          </span>
        </h3>
        {canCreate && <motion.button
          type="button"
          onClick={() => {
            onCreateTask({ title: "", columnId: id });
          }}

          whileTap={{ scale: 0.92 }}
          className="workspace-column-add inline-flex min-h-11 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors cursor-pointer"
          style={{ width: "auto" }}
          aria-label="Добавить обращение"
          data-no-drag
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>Добавить обращение</span>
        </motion.button>}
      </div>

      <div
        data-kanban-column-scroll
        role="region"
        aria-label={`Задачи колонки «${title}»`}
        tabIndex={0}
        className="flex flex-col gap-3 min-h-0 flex-1 overflow-y-auto overscroll-y-contain rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {canCreate && isCreating ? (
          <motion.div
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="min-w-0 shrink-0 bg-card rounded-2xl border-2 border-primary/20 p-4 shadow-lg"
            data-no-drag
          >
            <input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Название задачи…"
              className="min-h-11 min-w-0 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitCreate();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setIsCreating(false);
                  setDraftTitle("");
                }
              }}
              onBlur={submitCreate}
            />
          </motion.div>
        ) : null}

        {tasks.map((task, index) => (
          <SortableKanbanCard
            key={task.id}
            task={task}
            index={index}
            columnId={id}
            columnTitle={title}
            reorderEnabled={reorderEnabled}
            isPending={pendingTaskIds.has(task.id)}
            isSelected={selectedTaskIds.includes(task.id)}
            onTaskSelect={onToggleTaskSelect ? () => onToggleTaskSelect(task.id) : undefined}
            selectionDisabled={selectionDisabled || pendingTaskIds.has(task.id)}
            onOpen={() => onOpenTask?.(task)}
          />
        ))}

        {tasks.length === 0 && !isCreating ? <EmptyColumn description="Здесь появятся заявки в этом статусе." /> : null}
      </div>
    </motion.div>
  );
}
