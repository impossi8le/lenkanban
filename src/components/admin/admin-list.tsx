"use client";

import * as React from "react";
import { useInfiniteQuery, type QueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";

/**
 * Shared primitives for the administrator lists.
 *
 * Every list uses the same cursor contract (`limit`/`take` + opaque `cursor`),
 * the same search normalization and the same cache reset when a filter
 * changes. Individual screens still own their selection, mutation and access
 * state; only the list mechanics are shared.
 */

export type AdminPage<T> = {
  items: T[];
  nextCursor: string | null;
  version?: number;
};

export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

/** Search terms are trimmed and case-folded once, before they reach a query key. */
export function normalizeAdminSearch(value: string): string {
  return value.trim().toLowerCase();
}

/** An empty filter is omitted instead of being sent as `q=`. */
export function adminSearchParams(query: string): Record<string, string> {
  return query ? { q: query } : {};
}

/**
 * Drop cached pages before a filter changes so a later visit starts from the
 * first page instead of replaying the previous cursor chain.
 */
export function resetAdminListQueries(
  client: QueryClient,
  keyPrefix: readonly unknown[],
  options: { exact?: boolean } = {},
) {
  client.removeQueries({ queryKey: keyPrefix, exact: options.exact ?? false });
}

type AdminPagerOptions = {
  key: readonly unknown[];
  url: string;
  params?: Record<string, string>;
  enabled?: boolean;
  pageSize?: number;
  /** Legacy admin users/projects routes use `take`; organization routes use `limit`. */
  pageSizeParam?: "limit" | "take";
};

export function useAdminPager<T, P extends AdminPage<T> = AdminPage<T>>({
  key,
  url,
  params = {},
  enabled = true,
  pageSize = 50,
  pageSizeParam = "limit",
}: AdminPagerOptions) {
  return useInfiniteQuery({
    queryKey: key,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const search = new URLSearchParams({
        ...params,
        [pageSizeParam]: String(pageSize),
      });
      if (pageParam) search.set("cursor", pageParam);
      return apiFetch<P>(`${url}?${search}`, { signal });
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false,
  });
}

export type AdminPager<T, P extends AdminPage<T> = AdminPage<T>> = ReturnType<
  typeof useAdminPager<T, P>
>;

export function AdminPagedList<T, P extends AdminPage<T> = AdminPage<T>>({
  query,
  label,
  blocked,
  listRef: externalRef,
  emptyText = "Ничего не найдено.",
  errorText,
  children,
}: {
  query: AdminPager<T, P>;
  label: string;
  blocked: boolean;
  listRef?: React.RefObject<HTMLDivElement | null>;
  emptyText?: string;
  errorText?: string;
  children: React.ReactNode;
}) {
  const ownRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const listRef = externalRef ?? ownRef;
  const buttonClass =
    "h-auto min-h-11 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]";

  async function load(retry = false) {
    if (query.isFetching || blocked) return;
    const result = retry && !query.isFetchNextPageError
      ? await query.refetch()
      : await query.fetchNextPage({ cancelRefetch: false });
    if (!result.isError) {
      setTimeout(() => {
        if (!buttonRef.current?.disabled) buttonRef.current?.focus();
        if (buttonRef.current?.disabled || document.activeElement !== buttonRef.current) {
          listRef.current?.focus();
        }
      }, 0);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      {query.isPending && <p role="status">Загрузка: {label}…</p>}
      {query.isError && (
        <div role="alert" className="space-y-2">
          <p>
            {errorText ?? `Не удалось загрузить: ${label}.`}{" "}
            {query.data
              ? "Ранее загруженные строки сохранены."
              : "Попробуйте ещё раз."}
          </p>
          <Button
            className={buttonClass}
            variant="outline"
            disabled={query.isFetching || blocked}
            onClick={() => void load(true)}
          >
            Повторить загрузку: {label}
          </Button>
        </div>
      )}
      {query.data && (
        <>
          <div
            ref={listRef}
            tabIndex={-1}
            aria-label={label}
            aria-busy={query.isFetchingNextPage}
            className="max-w-full overflow-x-auto rounded-md border"
          >
            <ul>{children}</ul>
            {query.data.pages.every(page => page.items.length === 0) && !query.isError && (
              <p className="p-3 text-sm">{emptyText}</p>
            )}
          </div>
          <Button
            ref={buttonRef}
            className={buttonClass}
            variant="outline"
            disabled={!query.hasNextPage || blocked}
            aria-disabled={!query.hasNextPage || query.isFetching || blocked}
            aria-busy={query.isFetchingNextPage}
            onClick={() => void load()}
          >
            {query.isFetchingNextPage
              ? `Загрузка: ${label}…`
              : query.hasNextPage
                ? `Загрузить ещё: ${label}`
                : `Всё загружено: ${label}`}
          </Button>
        </>
      )}
    </div>
  );
}
