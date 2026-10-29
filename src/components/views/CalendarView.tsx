"use client";

import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useEffect,
  useState,
  type SyntheticEvent,
  type KeyboardEvent,
  type PropsWithChildren,
} from "react";
import {
  Calendar,
  dateFnsLocalizer,
  Event as BigCalendarEvent,
  type View,
  type EventWrapperProps,
} from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { ru } from "date-fns/locale";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { apiFetch } from "@/lib/api";
import { useProjectMemberOptions } from "@/hooks/useProjectMemberOptions";
import { TASK_LIST_MAX_LIMIT } from "@/lib/task-list-limits";
import type { TaskType } from "@/components/kanban/Card";
import { FilterBar } from "@/components/kanban/FilterBar";
import "react-big-calendar/lib/css/react-big-calendar.css";
import styles from "./CalendarView.module.css";
import { useTaskViewFocus } from "./useTaskViewFocus";

const locales = {
  ru: ru,
};

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
});

interface CalendarViewProps {
  projectId: string;
  onTaskClick: (task: TaskType) => void;
  statusFilter?: string | null;
  priorityFilter?: string | null;
  assigneeFilter?: string | null;
  tagsFilter?: string[] | null;
  sortBy?: string;
  onStatusFilterChange?: (value: string | null) => void;
  onPriorityFilterChange?: (value: string | null) => void;
  onAssigneeFilterChange?: (value: string | null) => void;
  onTagsFilterChange?: (value: string[] | null) => void;
  onSortByChange?: (value: string) => void;
}

interface CalendarEvent extends BigCalendarEvent {
  task: TaskType;
}

// RBC wraps date/all-day and timed events differently. A provider adds no DOM
// element and lets the shared content preserve exactly one interactive target.
const CalendarEventKind = createContext<"date" | "time">("date");
function CalendarEventWrapper({ children, type }: PropsWithChildren<EventWrapperProps<CalendarEvent> & { type?: string }>) {
  return <CalendarEventKind.Provider value={type === "time" ? "time" : "date"}>{children}</CalendarEventKind.Provider>;
}
function CalendarTaskEvent({ event, onOpen }: { event: CalendarEvent; onOpen: (task: TaskType, opener: HTMLElement) => void }) {
  const kind = useContext(CalendarEventKind);
  if (kind === "time") return <span className={styles.taskButton}>{event.task.title}</span>;
  return (
    <button type="button" data-task-opener className={styles.taskButton} aria-label={`Открыть задачу: ${event.task.title}`}
      onClick={click => { click.stopPropagation(); onOpen(event.task, click.currentTarget); }}
      onKeyDown={key => key.stopPropagation()}>
      {event.task.title}
    </button>
  );
}

interface ProjectTagOption {
  id: string;
  name: string;
  color: string;
}

const priorityColors: Record<string, { bg: string; border: string }> = {
  CRITICAL: { bg: "var(--danger-muted)", border: "var(--danger-bright)" },
  URGENT: { bg: "var(--danger-muted)", border: "var(--danger-bright)" },
  HIGH: { bg: "var(--urgent-muted)", border: "var(--urgent-bright)" },
  MEDIUM: { bg: "var(--warning-muted)", border: "var(--warning-bright)" },
  LOW: { bg: "var(--info-muted)", border: "var(--info-bright)" },
};

export function CalendarView({
  projectId,
  onTaskClick,
  statusFilter: externalStatusFilter,
  priorityFilter: externalPriorityFilter,
  assigneeFilter: externalAssigneeFilter,
  tagsFilter: externalTagsFilter,
  sortBy: externalSortBy,
  onStatusFilterChange,
  onPriorityFilterChange,
  onAssigneeFilterChange,
  onTagsFilterChange,
  onSortByChange,
}: CalendarViewProps) {
  const openTask = useTaskViewFocus(onTaskClick);
  const [date, setDate] = useState(() => new Date());
  const [compact, setCompact] = useState(false);
  const [desktopView, setDesktopView] = useState<View>("month");
  const [compactView, setCompactView] = useState<View>("agenda");

  // Internal state for uncontrolled usage.
  const [internalStatusFilter, setInternalStatusFilter] = useState<string | null>(null);
  const [internalPriorityFilter, setInternalPriorityFilter] = useState<string | null>(null);
  const [internalAssigneeFilter, setInternalAssigneeFilter] = useState<string | null>(null);
  const [internalTagsFilter, setInternalTagsFilter] = useState<string[] | null>(null);
  const [internalSortBy, setInternalSortBy] = useState<string>("position");

  const statusFilter =
    externalStatusFilter !== undefined ? externalStatusFilter : internalStatusFilter;
  const priorityFilter =
    externalPriorityFilter !== undefined ? externalPriorityFilter : internalPriorityFilter;
  const assigneeFilter =
    externalAssigneeFilter !== undefined ? externalAssigneeFilter : internalAssigneeFilter;
  const tagsFilter =
    externalTagsFilter !== undefined ? externalTagsFilter : internalTagsFilter;
  const sortBy = externalSortBy !== undefined ? externalSortBy : internalSortBy;

  const setStatusFilter = onStatusFilterChange ?? setInternalStatusFilter;
  const setPriorityFilter = onPriorityFilterChange ?? setInternalPriorityFilter;
  const setAssigneeFilter = onAssigneeFilterChange ?? setInternalAssigneeFilter;
  const setTagsFilter = onTagsFilterChange ?? setInternalTagsFilter;
  const setSortBy = onSortByChange ?? setInternalSortBy;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const { data: tasks = [], isLoading, isError } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: ({ signal }) =>
      apiFetch<TaskType[]>(
        `/api/tasks?projectId=${projectId}&limit=${TASK_LIST_MAX_LIMIT}`, { signal },
      ),
  });

  const { data: workflowColumns = [] } = useQuery({
    queryKey: ["columns", projectId],
    queryFn: ({ signal }) =>
      apiFetch<Array<{ id: string; name: string }>>(
        `/api/projects/${projectId}/columns`, { signal },
      ),
  });

  const { data: projectMembers } = useProjectMemberOptions(projectId);

  const { data: projectTags } = useQuery({
    queryKey: ["tags", projectId],
    queryFn: ({ signal }) =>
      apiFetch<ProjectTagOption[]>(`/api/tags?projectId=${projectId}`, { signal }),
  });

  const hasActiveFilters =
    statusFilter || priorityFilter || assigneeFilter || (tagsFilter && tagsFilter.length > 0);

  const events = useMemo<CalendarEvent[]>(() => {
    if (!tasks || !Array.isArray(tasks)) return [];

    return tasks
      .filter((task) => {
        if (!task.deadline) return false;

        if (statusFilter && task.columnId !== statusFilter) return false;
        if (priorityFilter && task.priority !== priorityFilter) return false;

        if (assigneeFilter) {
          const hasAssignees = task.assignees && task.assignees.length > 0;
          if (assigneeFilter === "unassigned" && hasAssignees) return false;
          if (assigneeFilter !== "unassigned") {
            const hasMatchingAssignee = task.assignees?.some(
              (a) => a.user.id === assigneeFilter,
            );
            if (!hasMatchingAssignee) return false;
          }
        }

        if (tagsFilter && tagsFilter.length > 0) {
          const taskTagIds = task.tags?.map((t) => t.tag.id) ?? [];
          const hasAllTags = tagsFilter.every((tagId) =>
            taskTagIds.includes(tagId),
          );
          if (!hasAllTags) return false;
        }

        return true;
      })
      .map((task) => ({
        title: task.title,
        start: new Date(task.deadline!),
        end: new Date(task.deadline!),
        task,
      }));
  }, [
    tasks,
    statusFilter,
    priorityFilter,
    assigneeFilter,
    tagsFilter,
  ]);

  const handleSelectEvent = useCallback(
    (event: CalendarEvent, click?: SyntheticEvent<HTMLElement>) => {
      const target = click?.currentTarget;
      const opener =
        target?.querySelector<HTMLButtonElement>("[data-task-opener]") ??
        target;
      if (opener) openTask(event.task, opener as HTMLElement);
      else onTaskClick(event.task);
    },
    [onTaskClick, openTask],
  );

  const TaskEvent = useCallback(
    ({ event }: { event: CalendarEvent }) => <CalendarTaskEvent event={event} onOpen={openTask} />,
    [openTask],
  );
  // Only timed wrappers receive these keys; native date/agenda buttons stop
  // propagation and retain their own keyboard activation.
  const handleKeyPressEvent = useCallback(
    (event: CalendarEvent, key: SyntheticEvent<HTMLElement>) => {
      const keyboard = key as KeyboardEvent<HTMLElement>;
      if (keyboard.key !== "Enter" && keyboard.key !== " ") return;
      keyboard.preventDefault();
      handleSelectEvent(event, key);
    },
    [handleSelectEvent],
  );

  const eventStyleGetter = useCallback((event: CalendarEvent) => {
    const priority = event.task.priority;
    const colors = Object.prototype.hasOwnProperty.call(priorityColors, priority)
      ? priorityColors[priority]
      : { bg: "var(--muted)", border: "var(--border)" };

    return {
      style: {
        backgroundColor: colors.bg,
        borderLeft: `4px solid ${colors.border}`,
        color: "var(--foreground)",
        borderRadius: "4px",
        padding: "2px 8px",
        fontSize: "0.75rem",
        fontWeight: 500,
      },
    };
  }, []);

  if (isLoading || isError) {
    return (
      <div className={styles.viewport}>
        <div
          className={`${styles.calendar} rounded-lg border bg-card p-3 sm:p-4 flex items-center justify-center`}
        >
          <div
            role={isError ? "alert" : "status"}
            aria-live="polite"
            className="text-muted-foreground"
          >
            {isError
              ? "Не удалось загрузить календарь"
              : "Загрузка календаря..."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={styles.viewport}
    >
      <div className={`${styles.calendar} rounded-lg border bg-card p-3 sm:p-4`}>
        <FilterBar
          status={statusFilter}
          priority={priorityFilter}
          assignee={assigneeFilter}
          tags={tagsFilter}
          sortBy={sortBy}
          showSort={false}
          onStatusChange={setStatusFilter}
          onPriorityChange={setPriorityFilter}
          onAssigneeChange={setAssigneeFilter}
          onTagsChange={setTagsFilter}
          onSortChange={setSortBy}
          projectMembers={projectMembers}
          projectTags={projectTags}
          columns={workflowColumns}
        />

        {events.length === 0 && (
          <p role="status" className="mb-2 text-sm text-muted-foreground">
            {hasActiveFilters
              ? "Нет задач с дедлайнами, соответствующих фильтрам"
              : "Нет задач с дедлайнами"}
          </p>
        )}
        <Calendar
          localizer={localizer}
          events={events}
          startAccessor="start"
          endAccessor="end"
          culture="ru"
          onSelectEvent={handleSelectEvent}
          onKeyPressEvent={handleKeyPressEvent}
          eventPropGetter={eventStyleGetter}
          views={["month", "week", "day", "agenda"]}
          date={date}
          onNavigate={setDate}
          view={compact ? compactView : desktopView}
          onView={compact ? setCompactView : setDesktopView}
          components={{
            event: TaskEvent,
            agenda: { event: TaskEvent },
            eventWrapper: CalendarEventWrapper,
          }}
          messages={{
            next: "Вперёд",
            previous: "Назад",
            today: "Сегодня",
            month: "Месяц",
            week: "Неделя",
            day: "День",
            agenda: "Список",
            date: "Дата",
            time: "Время",
            allDay: "Весь день",
            event: "Задача",
            noEventsInRange: "Нет задач с дедлайнами в этом периоде",
            showMore: (total) => `+${total} ещё`,
          }}
          style={{ height: "100%" }}
        />
      </div>
    </motion.div>
  );
}
