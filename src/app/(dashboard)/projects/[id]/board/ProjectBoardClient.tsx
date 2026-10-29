"use client";

import { useState, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import dynamic from "next/dynamic";
import { isClaimProject, isBeznalProject } from "@/lib/request-presentation";
import { Loader2 } from "lucide-react";
import { KanbanBoard } from "@/components/kanban/Board";
import type { ViewType } from "@/components/views/ViewSwitcher";
import { Button } from "@/components/ui/button";
import { RequestDepartmentHeader } from "@/components/dashboard/RequestDepartmentHeader";
import { parseProjectView, projectCreateTaskHref, projectViewHref } from "@/lib/project-navigation";

// Views, dialogs and panels are split out of the board chunk. A view chunk is
// requested only for the selected view; a dialog chunk only on its first open.
function ViewLoadingFallback() {
  return (
    <div role="status" aria-live="polite" className="flex h-full items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <span className="sr-only">Загрузка представления</span>
    </div>
  );
}

const CalendarView = dynamic(
  () => import("@/components/views/CalendarView").then((mod) => ({ default: mod.CalendarView })),
  {
    loading: () => <ViewLoadingFallback />,
    ssr: false,
  }
);

const TableView = dynamic(
  () => import("@/components/views/TableView").then((mod) => ({ default: mod.TableView })),
  {
    loading: () => <ViewLoadingFallback />,
    ssr: false,
  }
);

const CreateTaskDialog = dynamic(
  () => import("@/components/task/CreateTaskDialog").then((mod) => ({ default: mod.CreateTaskDialog })),
  { loading: () => null, ssr: false }
);

const ProjectMembersDialog = dynamic(
  () => import("@/components/project/ProjectMembersDialog").then((mod) => ({ default: mod.ProjectMembersDialog })),
  { loading: () => null, ssr: false }
);

const ProjectSettingsDialog = dynamic(
  () => import("@/components/project/ProjectSettingsDialog").then((mod) => ({ default: mod.ProjectSettingsDialog })),
  { loading: () => null, ssr: false }
);

const ProjectColumnsDialog = dynamic(
  () => import("@/components/project/ProjectColumnsDialog").then((mod) => ({ default: mod.ProjectColumnsDialog })),
  { loading: () => null, ssr: false }
);

const ProjectTemplateDialog = dynamic(
  () => import("@/components/project-templates/ProjectTemplateDialog").then((mod) => ({ default: mod.ProjectTemplateDialog })),
  { loading: () => null, ssr: false }
);

const SavedViewsPanel = dynamic(
  () => import("@/components/saved-views/SavedViewsPanel").then((mod) => ({ default: mod.SavedViewsPanel })),
  { loading: () => null, ssr: false }
);

const TemplatesPanel = dynamic(
  () => import("@/components/templates/TemplatesPanel").then((mod) => ({ default: mod.TemplatesPanel })),
  { loading: () => null, ssr: false }
);

const RecurringTasksPanel = dynamic(
  () => import("@/components/recurring/RecurringTasksPanel").then((mod) => ({ default: mod.RecurringTasksPanel })),
  { loading: () => null, ssr: false }
);

const AutomationRulesPanel = dynamic(
  () => import("@/components/automation/AutomationRulesPanel").then((mod) => ({ default: mod.AutomationRulesPanel })),
  { loading: () => null, ssr: false }
);

import { motion, AnimatePresence } from "motion/react";
import { apiFetch } from "@/lib/api";
import { getBrowserTelemetryClient } from "@/lib/telemetry/client";
import { getSocketInstance } from "@/lib/socket-client";
import type { Project } from "@/types/project";

interface ProjectBoardClientProps {
  projectId: string;
  canManage: boolean;
  canCreate?: boolean;
  allowedCreationColumnIds?: readonly string[] | null;
  canExecuteRequests?: boolean;
  canChangeStatus?: boolean;
}

interface LoadedSavedView {
  name: string;
  viewType?: string;
  filters?: {
    status?: string | null;
    priority?: string | null;
    assignee?: string | null;
    tags?: string[] | null;
    search?: string;
  };
  sortBy?: string;
}

// A dialog chunk is requested on first open, not with the page. Once opened the
// component stays mounted so Radix keeps its close animation, focus return and
// internal state exactly as before.
function useEverOpened(open: boolean): boolean {
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);
  return everOpened;
}

export function ProjectBoardClient({ projectId, canManage, canCreate = false, allowedCreationColumnIds = [], canExecuteRequests = false, canChangeStatus = false }: ProjectBoardClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [preferredView, setPreferredView] = useState<ViewType>("board");
  const currentView = parseProjectView(searchParams.get("view")) ?? preferredView;
  const search = searchParams.toString();
  const createTaskOpen = searchParams.get("create") === "task";
  const createTaskButtonRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [savedViewsOpen, setSavedViewsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [recurringTasksOpen, setRecurringTasksOpen] = useState(false);
  const [automationRulesOpen, setAutomationRulesOpen] = useState(false);

  const createTaskMounted = useEverOpened(createTaskOpen);
  const settingsMounted = useEverOpened(settingsOpen);
  const columnsMounted = useEverOpened(columnsOpen);
  const membersMounted = useEverOpened(membersOpen);
  const templateDialogMounted = useEverOpened(templateDialogOpen);
  const savedViewsMounted = useEverOpened(savedViewsOpen);
  const templatesMounted = useEverOpened(templatesOpen);
  const recurringTasksMounted = useEverOpened(recurringTasksOpen);
  const automationRulesMounted = useEverOpened(automationRulesOpen);

  // Lifted filter state for saved views support
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  const [tagsFilter, setTagsFilter] = useState<string[] | null>(null);
  const [sortBy, setSortBy] = useState<string>("position");
  const [tableSearch, setTableSearch] = useState("");

  // Fetch project data for template dialog
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: ({ signal }) => apiFetch<Project & { lifecycleColumnMap?: unknown }>(`/api/projects/${projectId}`, { signal }),
  });

  // Update document title with project name
  useEffect(() => {
    if (project?.name) {
      document.title = `${project.name} - ЛЕНКАНБАН`;
    }
  }, [project]);

  // URL wins over the local preference; canonicalize a missing/invalid view.
  useEffect(() => {
    // The board remains mounted behind intercepted task routes. Their search
    // changes must not navigate away from the task back to this background.
    if (pathname !== `/projects/${encodeURIComponent(projectId)}/board`) return;
    const params = new URLSearchParams(search);
    if (parseProjectView(params.get("view"))) return;
    // The approved board is the default even for users with an old table preference.
    // Explicit view URLs continue to open their requested representation.
    const view: ViewType = "board";
    setPreferredView(view);
    if (!params.get("task")) {
      params.set("view", view);
      const href = params.get("create") === "task"
        ? projectCreateTaskHref(projectId, params)
        : projectViewHref(projectId, view, params);
      // This only makes the already-rendered default explicit in the URL.
      // Next integrates native history with useSearchParams; requesting a new
      // RSC tree here would repeat server permissions before any user action.
      window.history.replaceState(null, "", `${href}${window.location.hash}`);
    }
  }, [pathname, projectId, search]);

  // Handle task opening from URL parameter
  useEffect(() => {
    const taskId = searchParams.get("task");
    if (taskId) {
      // Navigate to the task route which will be intercepted by the parallel route
      router.replace(`/projects/${projectId}/tasks/${taskId}`);
    }
  }, [searchParams, projectId, router]);

  // Save view preference to localStorage
  const handleViewChange = (view: ViewType) => {
    // Closed catalog label only; the telemetry client swallows its own failures.
    getBrowserTelemetryClient()?.recordViewChange(view);
    try { localStorage.setItem("kanban-view-preference", view); } catch { /* Optional preference. */ }
    router.push(projectViewHref(projectId, view, searchParams), { scroll: false });
  };

  const closeCreateTask = () => {
    const params = new URLSearchParams(search);
    params.delete("create");
    router.replace(projectViewHref(projectId, currentView, params), { scroll: false });
  };
  const openCreateTask = () => {
    const params = new URLSearchParams(search);
    params.set("view", currentView);
    router.push(projectCreateTaskHref(projectId, params), { scroll: false });
  };

  // Handle loading a saved view
  const handleLoadView = (view: LoadedSavedView) => {
    // Switch to the saved view type
    if (view.viewType && ["board", "table", "calendar"].includes(view.viewType)) {
      handleViewChange(view.viewType as ViewType);
    }

    // Restore filters and sorting
    if (view.filters) {
      setStatusFilter(view.filters.status || null);
      setPriorityFilter(view.filters.priority || null);
      setAssigneeFilter(view.filters.assignee || null);
      setTagsFilter(view.filters.tags || null);
    }
    setTableSearch(view.filters?.search ?? "");
    setSortBy(view.sortBy ?? "position");

    toast.success(`Представление "${view.name}" загружено`);
    setSavedViewsOpen(false);
  };

  // Global Socket.IO listener for project members updates
  // This ensures member changes reflect across all components (AssigneeSelector, etc.)
  useEffect(() => {
    const socket = getSocketInstance();

    const handleMembersUpdated = () => {
      // Invalidate project members query
      queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
      // Invalidate tasks query to update assignee lists
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    };

    const handleMemberDeleted = () => {
      queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    };

    // Listen for member update events
    socket.on("project:members:updated", handleMembersUpdated);
    socket.on("project:member:deleted", handleMemberDeleted);

    return () => {
      socket.off("project:members:updated", handleMembersUpdated);
      socket.off("project:member:deleted", handleMemberDeleted);
    };
  }, [projectId, queryClient]);

  return (
    <div className="request-department-page h-full min-h-0 min-w-0 flex flex-col overflow-y-auto">
      <RequestDepartmentHeader projectName={project?.name} canCreate={canCreate} canExecuteRequests={canExecuteRequests} onCreate={openCreateTask} createButtonRef={createTaskButtonRef}/>

      <div className="min-w-0 min-h-0 flex-1 flex flex-col">
        <div className="mb-3 hidden shrink-0 gap-2" aria-label="Срочность обращений">
        <Button size="sm" variant={!priorityFilter ? 'default' : 'outline'} aria-pressed={!priorityFilter} onClick={()=>setPriorityFilter(null)}>Все</Button>
        <Button size="sm" variant={priorityFilter==='URGENT' ? 'default' : 'outline'} aria-pressed={priorityFilter==='URGENT'} onClick={()=>setPriorityFilter('URGENT')}>{isClaimProject(project?.name)?'Срочно':'Срочные'}</Button>
      </div>
      <AnimatePresence mode="wait">
          {currentView === "board" && (
            <motion.div
              key="board"
              initial={{ opacity: 1, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0 }}
              className="flex-1 min-h-0 min-w-0"
            >
              <KanbanBoard
                claim={isClaimProject(project?.name)}
                beznal={isBeznalProject(project?.name)}
                projectId={projectId}
                dndV2Enabled={project?.dndV2Enabled ?? false}
                boardRevision={project?.boardRevision ?? 0}
                canManage={canManage}
                allowedCreationColumnIds={canCreate ? allowedCreationColumnIds : []}
                canExecuteRequests={canExecuteRequests}
                canChangeStatus={canChangeStatus}
                manualTaskMovesEnabled={false}
                statusFilter={statusFilter}
                priorityFilter={priorityFilter}
                assigneeFilter={assigneeFilter}
                tagsFilter={tagsFilter}
                sortBy={sortBy}
                onStatusFilterChange={setStatusFilter}
                onPriorityFilterChange={setPriorityFilter}
                onAssigneeFilterChange={setAssigneeFilter}
                onTagsFilterChange={setTagsFilter}
                onSortByChange={setSortBy}
              />
            </motion.div>
          )}

          {currentView === "table" && (
            <motion.div
              key="table"
              initial={{ opacity: 1, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0 }}
              className="h-full overflow-auto"
            >
              <TableView
                projectId={projectId}
                search={tableSearch}
                onSearchChange={setTableSearch}
                onTaskClick={(task) =>
                  router.push(`/projects/${projectId}/tasks/${task.id}`)
                }
                statusFilter={statusFilter}
                priorityFilter={priorityFilter}
                assigneeFilter={assigneeFilter}
                tagsFilter={tagsFilter}
                sortBy={sortBy}
                onStatusFilterChange={setStatusFilter}
                onPriorityFilterChange={setPriorityFilter}
                onAssigneeFilterChange={setAssigneeFilter}
                onTagsFilterChange={setTagsFilter}
                onSortByChange={setSortBy}
              />
            </motion.div>
          )}

          {currentView === "calendar" && (
            <motion.div
              key="calendar"
              initial={{ opacity: 1, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0 }}
              className="h-full"
            >
              <CalendarView
                projectId={projectId}
                onTaskClick={(task) =>
                  router.push(`/projects/${projectId}/tasks/${task.id}`)
                }
                statusFilter={statusFilter}
                priorityFilter={priorityFilter}
                assigneeFilter={assigneeFilter}
                tagsFilter={tagsFilter}
                sortBy={sortBy}
                onStatusFilterChange={setStatusFilter}
                onPriorityFilterChange={setPriorityFilter}
                onAssigneeFilterChange={setAssigneeFilter}
                onTagsFilterChange={setTagsFilter}
                onSortByChange={setSortBy}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {createTaskMounted && (
        <CreateTaskDialog
          key={projectId}
          projectId={projectId}
          projectName={project?.name}
          canCreate={canCreate}
          open={createTaskOpen}
          onClose={closeCreateTask}
          returnFocusRef={createTaskButtonRef}
        />
      )}

      {/* Project Settings Dialog */}
      {canManage && (
        <>
          {settingsMounted && (
            <ProjectSettingsDialog
              projectId={projectId}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
            />
          )}
          {columnsMounted && (
            <ProjectColumnsDialog
              projectId={projectId}
              open={columnsOpen}
              onOpenChange={setColumnsOpen}
            />
          )}
          {templateDialogMounted && (
            <ProjectTemplateDialog
              open={templateDialogOpen}
              onOpenChange={setTemplateDialogOpen}
              projectId={projectId}
              projectName={project?.name || ""}
            />
          )}
        </>
      )}

      {/* Project Members Dialog */}
      {membersMounted && (
        <ProjectMembersDialog
          projectId={projectId}
          canManage={canManage}
          open={membersOpen}
          onOpenChange={setMembersOpen}
        />
      )}

      {/* Templates Panel */}
      {templatesMounted && (
        <TemplatesPanel
          open={templatesOpen}
          onOpenChange={setTemplatesOpen}
          projectId={projectId}
        />
      )}

      {/* Recurring Tasks Panel */}
      {recurringTasksMounted && (
        <RecurringTasksPanel
          open={recurringTasksOpen}
          onOpenChange={setRecurringTasksOpen}
          projectId={projectId}
        />
      )}

      {/* Automation Rules Panel */}
      {automationRulesMounted && (
        <AutomationRulesPanel
          open={automationRulesOpen}
          onOpenChange={setAutomationRulesOpen}
          projectId={projectId}
        />
      )}

      {/* Saved Views Panel */}
      {savedViewsMounted && (
        <SavedViewsPanel
          open={savedViewsOpen}
          onOpenChange={setSavedViewsOpen}
          projectId={projectId}
          currentViewType={currentView}
          currentFilters={{
            status: statusFilter,
            priority: priorityFilter,
            assignee: assigneeFilter,
            tags: tagsFilter,
            search: tableSearch,
          }}
          currentSortBy={sortBy}
          onLoadView={handleLoadView}
        />
      )}
    </div>
  );
}
