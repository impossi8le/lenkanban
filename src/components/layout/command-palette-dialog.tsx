"use client";
import {getRequestBoardPhase} from "@/lib/request-board-phase";
import {isBeznalProject,isClaimProject} from "@/lib/request-presentation";
import {SearchHighlight,TaskSearchContext} from "@/components/ui/SearchHighlight";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { FileText, Folder } from "lucide-react";
import { toast } from "sonner";
import { useDebounce } from "@/hooks/useDebounce";
import { apiFetch } from "@/lib/api";
import { getBrowserTelemetryClient } from "@/lib/telemetry/client";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

// Constants
const MIN_SEARCH_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 200;
const RECENT_LIMIT = 8;

const REQUEST_STATE_LABELS: Record<string, string> = {
  DRAFT: "Черновик",
  SUBMITTED: "Отправлено",
  IN_PROGRESS: "В работе",
  NEEDS_INFO: "Нужно уточнение",
  COMPLETED: "Завершено",
  CANCELLED: "Отменено",
  CLOSED: "Закрыто",
};

// Types
interface Task {
  id: string;
  title: string;
  description?: string | null;
  projectId: string;
  project?: {
    name: string;
  } | null;
  attachments?: readonly unknown[];
  createdBy?: {
    name: string | null;
  } | null;
  request?: {
    state: string;
    beznalPhase?: string | null;
    author?: { name: string | null } | null;
  } | null;
}

interface Project {
  id: string;
  name: string;
}

interface SearchResults {
  tasks: Task[];
  projects: Project[];
  failed: boolean;
}

export interface CommandPaletteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  // Kept for the existing trigger contract; the empty palette no longer shows
  // navigation, quick-action or theme commands.
  projects?: Array<{ id: string; name: string }>;
  onCreateTask?: () => void;
}

function taskMeta(task: Task): string {
  const author = task.request?.author?.name ?? task.createdBy?.name ?? null;
  const state = task.request?.state ? (isBeznalProject(task.project?.name)||isClaimProject(task.project?.name) ? getRequestBoardPhase(task,isBeznalProject(task.project?.name),isClaimProject(task.project?.name)).label : REQUEST_STATE_LABELS[task.request.state]) : null;
  return [task.project?.name, author, state]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function RetryPrompt({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Повторить
      </button>
    </div>
  );
}

/**
 * The cmdk search surface. It lives in its own module so the shell chunk does
 * not carry cmdk and the dialog primitives; the trigger and the Ctrl/⌘+K
 * listener stay in `command-palette.tsx`.
 *
 * The empty palette shows the newest accessible requests the list API returns
 * (urgent priorities first, then newest). Typing searches accessible requests
 * and departments on the server; the browser never widens that access.
 */
export function CommandPaletteDialog({
  open,
  onOpenChange,
  triggerRef,
}: CommandPaletteDialogProps) {
  const [searchQuery, setSearchQuery] = React.useState("");
  const { data: session, status } = useSession();
  const actorId = status === "authenticated" ? session?.user?.id : undefined;
  const queryClient = useQueryClient();
  const router = useRouter();

  const trimmedQuery = searchQuery.trim();
  const queryEmpty = trimmedQuery.length === 0;
  const debouncedQuery = useDebounce(trimmedQuery, SEARCH_DEBOUNCE_MS);
  const searchActive = debouncedQuery.length >= MIN_SEARCH_LENGTH;

  // A search was executed. Only the fact is recorded; the query text never leaves
  // the browser. The ref keeps a rerender from emitting the same search twice.
  const recordedSearchRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (debouncedQuery.length < MIN_SEARCH_LENGTH) return;
    if (recordedSearchRef.current === debouncedQuery) return;
    recordedSearchRef.current = debouncedQuery;
    getBrowserTelemetryClient()?.recordSearch();
  }, [debouncedQuery]);

  // Recent requests: one bounded list read on the server with the actor's own
  // read policy. The client adds no access and keeps no visited history.
  const {
    data: cachedRecentTasks,
    isFetching: recentFetching,
    isFetchedAfterMount: recentFetchedAfterMount,
    isError: recentFailed,
    refetch: refetchRecent,
  } = useQuery<Task[]>({
    queryKey: ["command-recent", actorId],
    queryFn: ({ signal }) =>
      apiFetch<Task[]>(`/api/tasks?limit=${RECENT_LIMIT}`, {
        credentials: "include",
        signal,
      }),
    enabled: open && Boolean(actorId) && queryEmpty,
    staleTime: 0,
    refetchOnMount: "always",
    gcTime: 60_000,
  });
  // Freshness and actor gating apply here too: a cached list from another
  // account, or from before a reopen, is never shown while it is being checked.
  const recentTasks = open && actorId && recentFetchedAfterMount && !recentFetching
    && !recentFailed && queryEmpty ? cachedRecentTasks : undefined;

  // Search accessible requests and departments. Both requests stay scoped to
  // the server session; a failed side degrades to no rows for that side.
  const {
    data: cachedSearchResults,
    isFetching: searchFetching,
    isFetchedAfterMount,
    isError: searchFailed,
    refetch: refetchSearch,
  } = useQuery<SearchResults>({
    queryKey: ["search", actorId, debouncedQuery],
    queryFn: async ({ signal }) => {
      const [tasksRes, projectsRes] = await Promise.all([
        apiFetch<Task[]>(`/api/tasks?search=${encodeURIComponent(debouncedQuery)}`, {
          credentials: "include",
          signal,
        }).catch((error) => {
          if (signal.aborted) throw error;
          toast.error(`Ошибка поиска задач: ${error.status ?? error.message}`);
          return null;
        }),
        apiFetch<Project[]>(`/api/projects?view=navigation&search=${encodeURIComponent(debouncedQuery)}`, {
          credentials: "include",
          signal,
        }).catch((error) => {
          if (signal.aborted) throw error;
          toast.error(`Ошибка поиска направлений: ${error.status ?? error.message}`);
          return null;
        }),
      ]);

      if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");

      return {
        tasks: tasksRes ?? [],
        projects: projectsRes ?? [],
        failed: tasksRes === null || projectsRes === null,
      };
    },
    enabled: open && Boolean(actorId) && searchActive,
    staleTime: 0,
    refetchOnMount: "always",
    gcTime: 60_000,
  });
  // Private results must be checked again on open and never flash from a
  // previous account or query while the current request is loading.
  const searchResults = open && actorId && isFetchedAfterMount && !searchFetching && !searchFailed
    && searchActive && trimmedQuery === debouncedQuery ? cachedSearchResults : undefined;
  React.useEffect(() => {
    if (open) return;
    void queryClient.cancelQueries({ queryKey: ["command-recent", actorId], exact: true });
    void queryClient.cancelQueries({ queryKey: ["search", actorId, debouncedQuery], exact: true });
  }, [open, actorId, debouncedQuery, queryClient]);

  const runCommand = React.useCallback((command: () => void) => {
    onOpenChange(false);
    setSearchQuery("");
    command();
  }, [onOpenChange]);

  const openTask = React.useCallback((task: Task) => {
    runCommand(() => router.push(`/projects/${task.projectId}/board?task=${task.id}`));
  }, [router, runCommand]);

  const hasSearchResults = searchResults
    && (searchResults.tasks.length > 0 || searchResults.projects.length > 0);
  const hasRecentTasks = recentTasks && recentTasks.length > 0;

  const renderTask = (task: Task, valuePrefix: string) => (
    <CommandItem
      key={task.id}
      value={`${valuePrefix}-${task.id}`}
      onSelect={() => openTask(task)}
    >
      <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm [overflow-wrap:anywhere]"><SearchHighlight text={task.title} query={queryEmpty?"":debouncedQuery}/></span>
        {!queryEmpty && <TaskSearchContext task={task} query={debouncedQuery}/>}
        {taskMeta(task) && (
          <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{taskMeta(task)}</span>
        )}
      </div>
    </CommandItem>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex w-[calc(100vw-2rem)] max-w-[600px] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:rounded-xl [&>button]:right-2 [&>button]:top-2.5 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-lg [&>button]:hover:bg-accent [&>button]:focus-visible:ring-inset [&>button]:focus-visible:ring-offset-0"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // A command may already have opened another modal. Its autofocus
          // owns focus; restoring the palette trigger would move behind it.
          if (!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) {
            triggerRef.current?.focus();
          }
        }}
      >
      <DialogTitle className="sr-only">Поиск обращений и направлений</DialogTitle>
      <Command label="Поиск обращений и направлений" shouldFilter={false} className="h-auto min-h-0 rounded-none [&_[cmdk-group]]:px-2 [&_[cmdk-group]]:py-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-item]]:min-h-12 [&_[cmdk-item]]:gap-3 [&_[cmdk-item]]:rounded-lg [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-3 [&_[cmdk-item]]:leading-5 [&_[cmdk-item]]:break-words [&_[cmdk-item]]:transition-colors [&_[cmdk-item]]:hover:bg-accent/60 [&_[cmdk-item][aria-selected=true]]:bg-accent [&_[cmdk-item][aria-selected=true]]:text-accent-foreground [&_[cmdk-item]_svg]:m-0 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5 [&_[cmdk-item]_svg]:shrink-0 [&_[cmdk-item]_svg]:text-muted-foreground">
      <CommandInput
        aria-label="Поиск обращений и направлений"
        maxLength={200}
        placeholder="Найти обращение или направление…"
        wrapperClassName="h-16 shrink-0 gap-3 px-5 pr-16 transition-colors focus-within:border-primary/50 focus-within:bg-accent/20 [&>svg]:m-0 [&>svg]:h-5 [&>svg]:w-5 [&>svg]:text-muted-foreground [&>svg]:opacity-100"
        className="h-16 min-w-0 rounded-none border-0 py-0 text-base focus-visible:outline-none! focus-visible:[box-shadow:none]!"
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList className="min-h-0 max-h-[min(480px,calc(100dvh-10rem))] overscroll-contain p-2 [&_[cmdk-item]>div]:min-w-0 [&_[cmdk-item]>span]:min-w-0 [&_[cmdk-item]>span]:[overflow-wrap:anywhere]">
        <CommandEmpty>
          {queryEmpty
            ? recentFetching
              ? "Загружаем доступные вам обращения…"
              : recentFailed
                ? <RetryPrompt message="Не удалось загрузить обращения." onRetry={() => void refetchRecent()} />
                : "Пока нет доступных вам обращений."
            : searchFetching || trimmedQuery.length >= MIN_SEARCH_LENGTH && trimmedQuery !== debouncedQuery
              ? "Ищем доступные вам обращения…"
              : searchActive && searchResults?.failed && !hasSearchResults
                ? <RetryPrompt message="Не удалось выполнить поиск." onRetry={() => void refetchSearch()} />
                : searchActive && searchResults
                  ? "Ничего не найдено."
                  : searchActive
                    ? "Ищем доступные вам обращения…"
                    : "Введите минимум 2 символа для поиска..."}
        </CommandEmpty>

        {/* Empty query: newest accessible requests, bounded to one list page. */}
        {queryEmpty && hasRecentTasks && (
          <CommandGroup heading="Недавние обращения">
            {recentTasks.map((task) => renderTask(task, "recent"))}
          </CommandGroup>
        )}

        {/* Search Results */}
        {hasSearchResults && (
          <>
            {searchResults.tasks.length > 0 && (
              <CommandGroup heading="Обращения">
                {searchResults.tasks.map((task) => renderTask(task, "task"))}
              </CommandGroup>
            )}

            {searchResults.projects.length > 0 && (
              <>
                {searchResults.tasks.length > 0 && <CommandSeparator />}
                <CommandGroup heading="Направления">
                  {searchResults.projects.map((project: Project) => (
                    <CommandItem
                      key={project.id}
                      value={`project-${project.id}`}
                      onSelect={() =>
                        runCommand(() => router.push(`/projects/${project.id}/board`))
                      }
                    >
                      <Folder className="mr-2 h-4 w-4" aria-hidden="true" />
                      <span><SearchHighlight text={project.name} query={debouncedQuery}/></span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {searchResults.failed && (
              <div role="alert" className="mx-3 my-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm">
                <span>Часть результатов не загрузилась.</span>
                <button
                  type="button"
                  onClick={() => void refetchSearch()}
                  className="rounded-md border px-3 py-2 font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Повторить
                </button>
              </div>
            )}
          </>
        )}
      </CommandList>
      <div className="hidden shrink-0 items-center border-t bg-muted/30 px-5 py-3 text-sm text-muted-foreground sm:flex">
        <span>
          {queryEmpty
            ? "Сначала срочные, затем новые доступные вам обращения."
            : "Стрелки — выбор, Enter — открыть, Esc — закрыть."}
        </span>
      </div>
      </Command>
      </DialogContent>
    </Dialog>
  );
}
