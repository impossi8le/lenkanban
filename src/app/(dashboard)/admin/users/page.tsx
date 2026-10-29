"use client";
import {SearchHighlight} from "@/components/ui/SearchHighlight";

import { displayLogin } from "@/lib/login-identity";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import {
  adminSearchParams,
  normalizeAdminSearch,
  resetAdminListQueries,
  uniqueById,
  useAdminPager,
} from "@/components/admin/admin-list";
import { useAdminListFocus } from "@/components/admin/use-admin-list-focus";
import { Input } from "@/components/ui/input";
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

type GlobalRole = "USER" | "ADMIN";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  globalRole: GlobalRole;
  createdAt: string;
  _count: { projects: number; projectMemberships: number; apiTokens: number };
};

type UsersResponse = {
  items: UserRow[];
  nextCursor: string | null;
};

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  const loadMoreRef = React.useRef<HTMLButtonElement>(null);
  const loadMoreLock = React.useRef(false);
  const { beginLoadMore, finishLoadMore } = useAdminListFocus({ listRef, buttonRef: loadMoreRef });

  const search = normalizeAdminSearch(q);
  const changeSearch = (value: string) => {
    const next = normalizeAdminSearch(value);
    if (next !== search) {
      // Returning to an earlier search starts from its first page too.
      resetAdminListQueries(queryClient, ["adminUsers", next], { exact: true });
    }
    setQ(value);
  };

  const usersQuery = useAdminPager<UserRow, UsersResponse>({
    key: ["adminUsers", search],
    url: "/api/admin/users",
    params: adminSearchParams(search),
    pageSizeParam: "take",
  });

  const users = React.useMemo<UserRow[]>(
    () => uniqueById(usersQuery.data?.pages.flatMap(page => page.items) ?? []),
    [usersQuery.data?.pages],
  );

  const loadMore = async () => {
    if (loadMoreLock.current || usersQuery.isFetching || !usersQuery.hasNextPage) return;
    loadMoreLock.current = true;
    try {
      beginLoadMore(users.length);
      const result = await usersQuery.fetchNextPage({ cancelRefetch: false });
      finishLoadMore(!result.isError && Boolean(result.hasNextPage));
    } finally {
      loadMoreLock.current = false;
    }
  };

  return (
    <div className="min-w-0 p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground break-words">Администратор · Пользователи</h1>
        <p className="text-muted-foreground">Поиск пользователей и управление глобальными ролями.</p>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-lg">Поиск</CardTitle>
          <CardDescription>Фильтр по email или имени.</CardDescription>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              aria-label="Поиск пользователей"
              placeholder="Поиск по email или имени…"
              className="w-full sm:flex-1 min-w-0"
              value={q}
              onChange={(e) => changeSearch(e.target.value)}
            />
            <Button variant="outline" className="w-full sm:w-auto shrink-0" onClick={() => changeSearch("")}>Очистить</Button>
          </div>
        </CardHeader>
        <CardContent>
          {usersQuery.isLoading ? (
            <div className="space-y-2">
              <div role="status" aria-live="polite" className="sr-only">
                Загрузка пользователей...
              </div>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : usersQuery.isError && !usersQuery.data ? (
            <div role="alert" aria-live="assertive" className="space-y-2 text-sm text-destructive"><p>Не удалось загрузить пользователей.</p><Button variant="outline" disabled={usersQuery.isFetching} onClick={() => void usersQuery.refetch()}>Повторить</Button></div>
          ) : (
            <div ref={listRef} tabIndex={-1} aria-label="Список пользователей" aria-busy={usersQuery.isFetchingNextPage} className="max-w-full overflow-x-auto border rounded-lg">
              <table className="w-full min-w-[540px] text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left border-b">
                    <th className="p-3">Пользователь</th>
                    <th className="p-3">Статистика</th>
                    <th className="p-3 w-[220px]">Глобальная роль</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      data-admin-row
                      tabIndex={-1}
                      className="border-b last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <td className="p-3">
                        <div className="font-medium break-words [overflow-wrap:anywhere]"><SearchHighlight text={u.name || displayLogin(u.email)} query={q}/></div>
                        <div className="text-xs text-muted-foreground break-all"><SearchHighlight text={displayLogin(u.email)} query={q}/></div>
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="secondary">владелец: {u._count.projects}</Badge>
                          <Badge variant="secondary">участник: {u._count.projectMemberships}</Badge>
                          <Badge variant="secondary">токены: {u._count.apiTokens}</Badge>
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="space-y-2">
                          <Badge variant="secondary">{u.globalRole}</Badge>
                          <Link className="inline-flex min-h-11 min-w-11 items-center rounded-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" href={`/admin/organization/roles?userId=${encodeURIComponent(u.id)}`}>Изменить роль</Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {users.length === 0 && !usersQuery.isError ? (
                <div className="p-4 text-sm text-muted-foreground">Пользователи не найдены.</div>
              ) : null}
            </div>
          )}
          {usersQuery.data !== undefined && (
            <div className="mt-4 flex min-w-0 max-w-full flex-col items-center gap-3">
              <div aria-live="polite" className="sr-only">
                {usersQuery.isFetchingNextPage ? 'Загрузка дополнительных данных...' : ''}
              </div>
              {usersQuery.isError && (
                <div role="alert" className="flex min-w-0 max-w-full flex-wrap items-center gap-2 break-words text-sm text-destructive">
                  <span>Произошла ошибка при загрузке данных.</span>
                  <Button
                    type="button"
                    disabled={usersQuery.isFetching}
                    onClick={async (event) => {
                      const restoreFocus = document.activeElement === event.currentTarget;
                      if (usersQuery.isFetching) return;
                      const result = usersQuery.isFetchNextPageError
                        ? await usersQuery.fetchNextPage({ cancelRefetch: false })
                        : await usersQuery.refetch();
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
              {(usersQuery.hasNextPage || usersQuery.data.pages.length > 1) && (
                <Button
                  ref={loadMoreRef}
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={!usersQuery.hasNextPage}
                  aria-disabled={!usersQuery.hasNextPage || usersQuery.isFetching}
                  aria-busy={usersQuery.isFetchingNextPage}
                  className="h-auto min-h-11 max-w-full whitespace-normal break-words rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                >
                  {usersQuery.isFetchingNextPage ? 'Загрузка...' : usersQuery.hasNextPage ? 'Загрузить ещё' : 'Всё загружено'}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
