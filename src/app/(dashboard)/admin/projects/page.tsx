"use client";

import { displayLogin } from "@/lib/login-identity";

import * as React from "react";

import {
  uniqueById,
  useAdminPager,
} from "@/components/admin/admin-list";
import { useAdminListFocus } from "@/components/admin/use-admin-list-focus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  owner: { id: string; email: string; name: string | null; globalRole: "USER" | "ADMIN" };
  _count: { tasks: number; members: number };
};

type ProjectsResponse = {
  items: ProjectRow[];
  nextCursor: string | null;
};

export default function AdminProjectsPage() {
  const listRef = React.useRef<HTMLDivElement>(null);
  const loadMoreRef = React.useRef<HTMLButtonElement>(null);
  const loadMoreLock = React.useRef(false);
  const { beginLoadMore, finishLoadMore } = useAdminListFocus({ listRef, buttonRef: loadMoreRef });
  const projectsQuery = useAdminPager<ProjectRow, ProjectsResponse>({
    key: ["adminProjects"],
    url: "/api/admin/projects",
    pageSizeParam: "take",
  });

  const projects = React.useMemo<ProjectRow[]>(
    () => uniqueById(projectsQuery.data?.pages.flatMap(page => page.items) ?? []),
    [projectsQuery.data?.pages],
  );

  const [listScrollable, setListScrollable] = React.useState(false);
  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setListScrollable(list.scrollWidth > list.clientWidth || list.scrollHeight > list.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    if (list.firstElementChild) observer.observe(list.firstElementChild);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [projectsQuery.isLoading, projectsQuery.isError, projects]);

  const loadMore = async () => {
    if (loadMoreLock.current || projectsQuery.isFetching || !projectsQuery.hasNextPage) return;
    loadMoreLock.current = true;
    try {
      beginLoadMore(projects.length);
      const result = await projectsQuery.fetchNextPage({ cancelRefetch: false });
      finishLoadMore(!result.isError && Boolean(result.hasNextPage));
    } finally {
      loadMoreLock.current = false;
    }
  };

  return (
    <div className="min-w-0 p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground break-words">Администратор · Проекты</h1>
        <p className="text-muted-foreground">Обзор всех проектов в системе.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Проекты</CardTitle>
          <CardDescription>Владелец, количество задач и участников.</CardDescription>
        </CardHeader>
        <CardContent>
          {projectsQuery.isLoading ? (
            <div className="space-y-2">
              <div role="status" aria-live="polite" className="sr-only">
                Загрузка проектов...
              </div>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : projectsQuery.isError && !projectsQuery.data ? (
            <div role="alert" aria-live="assertive" className="space-y-2 text-sm text-destructive"><p>Не удалось загрузить проекты.</p><Button variant="outline" disabled={projectsQuery.isFetching} onClick={() => void projectsQuery.refetch()}>Повторить</Button></div>
          ) : (
            <div ref={listRef} role="region" tabIndex={listScrollable ? 0 : undefined} aria-label="Список проектов" aria-busy={projectsQuery.isFetchingNextPage} className="max-w-full overflow-x-auto border rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
              <table className="w-full min-w-[540px] table-fixed text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left border-b">
                    <th className="p-3">Проект</th>
                    <th className="p-3">Владелец</th>
                    <th className="p-3">Статистика</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr
                      key={p.id}
                      data-admin-row
                      tabIndex={-1}
                      className="border-b last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <td className="p-3">
                        <div className="font-medium break-words [overflow-wrap:anywhere]">{p.name}</div>
                        {p.description ? (
                          <div className="min-w-0 max-w-full text-xs text-muted-foreground line-clamp-2 break-words [overflow-wrap:anywhere]">{p.description}</div>
                        ) : null}
                        <div className="text-[11px] text-muted-foreground break-all mt-1">id: {p.id}</div>
                      </td>
                      <td className="p-3">
                        <div className="font-medium break-words [overflow-wrap:anywhere]">{p.owner.name || displayLogin(p.owner.email)}</div>
                        <div className="text-xs text-muted-foreground break-all">{displayLogin(p.owner.email)}</div>
                        {p.owner.globalRole === "ADMIN" ? <Badge className="mt-1">ADMIN</Badge> : null}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="secondary">задачи: {p._count.tasks}</Badge>
                          <Badge variant="secondary">участники: {p._count.members}</Badge>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {projects.length === 0 && !projectsQuery.isError ? (
                <div className="p-4 text-sm text-muted-foreground">Проекты не найдены.</div>
              ) : null}
            </div>
          )}
          {projectsQuery.data !== undefined && (
            <div className="mt-4 flex min-w-0 max-w-full flex-col items-center gap-3">
              <div aria-live="polite" className="sr-only">
                {projectsQuery.isFetchingNextPage ? 'Загрузка дополнительных данных...' : ''}
              </div>
              {projectsQuery.isError && (
                <div role="alert" className="flex min-w-0 max-w-full flex-wrap items-center gap-2 break-words text-sm text-destructive">
                  <span>Произошла ошибка при загрузке данных.</span>
                  <Button
                    type="button"
                    disabled={projectsQuery.isFetching}
                    onClick={async (event) => {
                      const restoreFocus = document.activeElement === event.currentTarget;
                      if (projectsQuery.isFetching) return;
                      const result = projectsQuery.isFetchNextPageError
                        ? await projectsQuery.fetchNextPage({ cancelRefetch: false })
                        : await projectsQuery.refetch();
                      if (restoreFocus && !result.isError) {
                        setTimeout(() => {
                          loadMoreRef.current?.focus();
                          if (document.activeElement !== loadMoreRef.current) listRef.current?.focus();
                        }, 0);
                      }
                    }}
                    className="font-medium underline hover:no-underline"
                  >
                    Повторить
                  </Button>
                </div>
              )}
              {(projectsQuery.hasNextPage || projectsQuery.data.pages.length > 1) && (
                <Button
                  ref={loadMoreRef}
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={!projectsQuery.hasNextPage}
                  aria-disabled={!projectsQuery.hasNextPage || projectsQuery.isFetching}
                  aria-busy={projectsQuery.isFetchingNextPage}
                  className="h-auto min-h-11 max-w-full whitespace-normal break-words rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                >
                  {projectsQuery.isFetchingNextPage ? 'Загрузка...' : projectsQuery.hasNextPage ? 'Загрузить ещё' : 'Всё загружено'}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
