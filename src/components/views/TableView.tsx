"use client";
import {SearchHighlight,TaskSearchContext} from "@/components/ui/SearchHighlight";

import {getRequestBoardPhase} from "@/lib/request-board-phase";
import {isBeznalProject,isClaimProject} from "@/lib/request-presentation";
import { matchesTaskSearch } from "@/lib/search-context";
import { useMemo, useRef, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  ColumnDef,
  flexRender,
  SortingState,
  ColumnFiltersState,
  RowSelectionState,
} from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowUpDown, ArrowUp, ArrowDown, Search } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useProjectMemberOptions } from "@/hooks/useProjectMemberOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { BulkActionsToolbar } from "@/components/views/BulkActionsToolbar";
import type { TaskType } from "@/components/kanban/Card";
import { FilterBar } from "@/components/kanban/FilterBar";
import { useTaskViewFocus } from "./useTaskViewFocus";
import { getTaskPriorityPresentation } from "@/lib/task-priority";
import { sortTasksForDisplay } from "@/features/kanban/model/task-display-sort";
import { TASK_LIST_MAX_LIMIT } from "@/lib/task-list-limits";

interface TableViewProps {
  projectId: string;
  onTaskClick: (task: TaskType) => void;
  statusFilter?: string | null;
  priorityFilter?: string | null;
  assigneeFilter?: string | null;
  tagsFilter?: string[] | null;
  sortBy?: string;
  search?: string;
  onStatusFilterChange?: (value: string | null) => void;
  onPriorityFilterChange?: (value: string | null) => void;
  onAssigneeFilterChange?: (value: string | null) => void;
  onTagsFilterChange?: (value: string[] | null) => void;
  onSortByChange?: (value: string) => void;
  onSearchChange?: (value: string) => void;
}

interface ProjectTagOption {
  id: string;
  name: string;
  color: string;
}

const statusLabels: Record<string, string> = {
  TODO: "К выполнению",
  IN_PROGRESS: "В работе",
  IN_REVIEW: "На проверке",
  DONE: "Готово",
};

function mapSortByToSortingState(sortBy: string): SortingState {
  switch (sortBy) {
    case "title-asc":
      return [{ id: "title", desc: false }];
    case "title-desc":
      return [{ id: "title", desc: true }];
    case "deadline-asc":
      return [{ id: "deadline", desc: false }];
    case "deadline-desc":
      return [{ id: "deadline", desc: true }];
    case "priority-asc":
      return [{ id: "priority", desc: false }];
    case "priority-desc":
      return [{ id: "priority", desc: true }];
    default:
      return [];
  }
}

export function TableView({
  projectId,
  onTaskClick,
  statusFilter: externalStatusFilter,
  priorityFilter: externalPriorityFilter,
  assigneeFilter: externalAssigneeFilter,
  tagsFilter: externalTagsFilter,
  sortBy: externalSortBy,
  search: externalSearch,
  onStatusFilterChange,
  onPriorityFilterChange,
  onAssigneeFilterChange,
  onTagsFilterChange,
  onSortByChange,
  onSearchChange,
}: TableViewProps) {
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const openTask = useTaskViewFocus(onTaskClick, tableContainerRef);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [internalSearch, setInternalSearch] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // Internal state is used when the component is uncontrolled (e.g. in tests
  // or when the parent does not lift filters).
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
  const globalFilter = externalSearch !== undefined ? externalSearch : internalSearch;
  const setGlobalFilter = onSearchChange ?? setInternalSearch;
  const searchRef=useRef(globalFilter);
  searchRef.current=globalFilter;
  const sorting = mapSortByToSortingState(sortBy);

  const setStatusFilter = onStatusFilterChange ?? setInternalStatusFilter;
  const setPriorityFilter = onPriorityFilterChange ?? setInternalPriorityFilter;
  const setAssigneeFilter = onAssigneeFilterChange ?? setInternalAssigneeFilter;
  const setTagsFilter = onTagsFilterChange ?? setInternalTagsFilter;
  const setSortBy = onSortByChange ?? setInternalSortBy;

  const { data: tasks = [], isLoading, isError, refetch } = useQuery({
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

  // Fetch project members for filter
  const { data: projectMembers } = useProjectMemberOptions(projectId);

  // Fetch project tags for filter
  const { data: projectTags } = useQuery({
    queryKey: ["tags", projectId],
    queryFn: ({ signal }) =>
      apiFetch<ProjectTagOption[]>(`/api/tags?projectId=${projectId}`, { signal }),
  });

  // Apply filters to tasks
  const filteredTasks = useMemo(() => {
    if (!tasks) return [];

    return tasks.filter((task) => {
      // Status filter
      if (statusFilter && task.columnId !== statusFilter) return false;

      // Priority filter
      if (priorityFilter && task.priority !== priorityFilter) return false;

      // Assignee filter - check if any assignee matches
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

      // Tags filter: task must contain all selected tags.
      if (tagsFilter && tagsFilter.length > 0) {
        const taskTagIds = task.tags?.map((t) => t.tag.id) ?? [];
        const hasAllTags = tagsFilter.every((tagId) =>
          taskTagIds.includes(tagId),
        );
        if (!hasAllTags) return false;
      }

      return true;
    });
  }, [tasks, statusFilter, priorityFilter, assigneeFilter, tagsFilter]);

  // Both headers and saved views use the same display sort and tie breakers.
  const sortedTasks = useMemo(
    () => sortTasksForDisplay(filteredTasks, sortBy),
    [filteredTasks, sortBy],
  );

  const columns = useMemo<ColumnDef<TaskType>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            className="h-11 w-11"
            checked={table.getIsAllPageRowsSelected()}
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label="Выбрать все"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            className="h-11 w-11"
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Выбрать строку"
            onClick={(e) => e.stopPropagation()}
          />
        ),
        enableSorting: false,
        enableHiding: false,
        size: 80,
      },
      {
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            #{row.original.id.slice(-6).toUpperCase()}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: "title",
        size: 320,
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 min-h-11"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Название
              {column.getIsSorted() === "asc" ? (
                <ArrowUp className="ml-2 h-4 w-4" />
              ) : column.getIsSorted() === "desc" ? (
                <ArrowDown className="ml-2 h-4 w-4" />
              ) : (
                <ArrowUpDown className="ml-2 h-4 w-4" />
              )}
            </Button>
          );
        },
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <div
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                getTaskPriorityPresentation(row.original.priority).dot,
              )}
            />
            <div className="min-w-0"><button
              type="button"
              data-task-opener
              className="min-h-11 min-w-0 break-words rounded-sm text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                openTask(row.original, event.currentTarget);
              }}
            >
              <SearchHighlight text={row.original.title} query={searchRef.current}/>
            </button>{searchRef.current&&<TaskSearchContext task={row.original} query={searchRef.current}/>}</div>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Статус",
        cell: ({ row }) => (
          <Badge variant="outline" className="font-normal">
            {row.original.request ? getRequestBoardPhase(row.original,isBeznalProject(row.original.project?.name),isClaimProject(row.original.project?.name)).label : row.original.column?.name ||
              statusLabels[row.original.status ?? ""] ||
              "Неизвестная колонка"}
          </Badge>
        ),
        filterFn: (row, id, value) => {
          return value.includes(row.getValue(id));
        },
        size: 120,
      },
      {
        accessorKey: "priority",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 min-h-11"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Приоритет
              {column.getIsSorted() === "asc" ? (
                <ArrowUp className="ml-2 h-4 w-4" />
              ) : column.getIsSorted() === "desc" ? (
                <ArrowDown className="ml-2 h-4 w-4" />
              ) : (
                <ArrowUpDown className="ml-2 h-4 w-4" />
              )}
            </Button>
          );
        },
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={cn(
              "font-normal",
              getTaskPriorityPresentation(row.original.priority).color,
            )}
          >
            {getTaskPriorityPresentation(row.original.priority).label}
          </Badge>
        ),
        size: 120,
      },
      {
        accessorKey: "assignees",
        header: "Исполнители",
        cell: ({ row }) => {
          const assignees = row.original.assignees;
          if (!assignees || assignees.length === 0) {
            return <span className="text-muted-foreground text-sm">—</span>;
          }

          return (
            <div className="flex items-center -space-x-2">
              {assignees.slice(0, 3).map((assignment) => (
                <Avatar
                  key={assignment.id}
                  className="h-6 w-6 border-2 border-background"
                >
                  <AvatarFallback className="text-xs">
                    {(
                      assignment.user.name || assignment.user.email
                    )[0].toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ))}
              {assignees.length > 3 && (
                <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium border-2 border-background">
                  +{assignees.length - 3}
                </div>
              )}
            </div>
          );
        },
        size: 150,
      },
      {
        accessorKey: "deadline",
        header: ({ column }) => {
          return (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 min-h-11"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === "asc")
              }
            >
              Дедлайн
              {column.getIsSorted() === "asc" ? (
                <ArrowUp className="ml-2 h-4 w-4" />
              ) : column.getIsSorted() === "desc" ? (
                <ArrowDown className="ml-2 h-4 w-4" />
              ) : (
                <ArrowUpDown className="ml-2 h-4 w-4" />
              )}
            </Button>
          );
        },
        cell: ({ row }) => {
          const deadline = row.original.deadline;
          if (!deadline)
            return <span className="text-muted-foreground text-sm">—</span>;

          const date = new Date(deadline);
          const today = new Date();
          const isTodayDate = date.toDateString() === today.toDateString();
          const isPast = date < today && !isTodayDate;

          return (
            <span
              className={cn(
                "text-sm",
                isPast && "text-red-500 font-medium",
                isTodayDate && "text-amber-500 font-medium",
              )}
            >
              {format(date, "d MMM yyyy", { locale: ru })}
            </span>
          );
        },
        size: 120,
      },
    ],
    [openTask],
  );

  const table = useReactTable({
    data: sortedTasks,
    globalFilterFn: (row, columnId, value) => matchesTaskSearch(row.original,String(value??"")) || String(row.getValue(columnId)??"").toLocaleLowerCase().includes(String(value??"").toLocaleLowerCase()),
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      rowSelection,
    },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const column = next[0];
      setSortBy(column ? `${column.id}-${column.desc ? "desc" : "asc"}` : "position");
    },
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    getRowId: (task) => task.id,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    enableRowSelection: true,
    initialState: {
      pagination: {
        pageSize: 20,
      },
    },
  });

  const selectedTasks = table
    .getSelectedRowModel()
    .rows.map((row) => row.original);

  if (isLoading) {
    return (
      <div className="min-w-0 space-y-4">
        <div
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          Загрузка таблицы...
        </div>
        <div className="h-10 bg-muted animate-pulse rounded-lg" />
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        role="alert"
        className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border bg-card p-4"
      >
        <p className="break-words text-sm text-muted-foreground">
          Не удалось загрузить таблицу задач
        </p>
        <Button variant="outline" onClick={() => void refetch()}>
          Повторить
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-4 [&_button]:min-h-11">
      {/* Filter Bar */}
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

      {/* Bulk Actions Toolbar */}
      {selectedTasks.length > 0 && (
        <BulkActionsToolbar
          selectedTasks={selectedTasks}
          onClearSelection={() => setRowSelection({})}
          projectId={projectId}
          columns={workflowColumns}
        />
      )}

      {/* Search */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Поиск задач..."
            aria-label="Поиск задач в таблице"
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-11 min-w-0 pl-9"
          />
        </div>
        <div
          className="shrink-0 text-sm text-muted-foreground"
          aria-live="polite"
        >
          {table.getFilteredRowModel()?.rows?.length || 0} задач
        </div>
      </div>

      {/* Table */}
      <div
        ref={tableContainerRef}
        role="region"
        aria-label="Таблица задач, горизонтальная прокрутка"
        tabIndex={0}
        className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-lg border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>div]:overflow-visible"
      >
        <Table
          className="min-w-[850px] table-fixed"
          aria-label="Задачи проекта"
        >
          <TableHeader>
            {table.getHeaderGroups()?.map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers?.map((header) => (
                  <TableHead key={header.id} style={{ width: header.getSize() }}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel()?.rows?.length ? (
              table.getRowModel()?.rows?.map((row) => (
                <motion.tr
                  key={row.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={(event) => {
                    const opener =
                      event.currentTarget.querySelector<HTMLButtonElement>(
                        "[data-task-opener]",
                      );
                    if (opener) openTask(row.original, opener);
                  }}
                >
                  {row.getVisibleCells()?.map((cell) => (
                    <TableCell key={cell.id} className="break-words">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </motion.tr>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  Задачи не найдены
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">
            Страница {table.getState().pagination.pageIndex + 1} из{" "}
            {table.getPageCount()}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Назад
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Вперёд
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
