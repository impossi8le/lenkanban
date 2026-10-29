"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { apiFetch } from "@/lib/api";

export type NotificationSummary = {
  actorId: string;
  count: number;
  byProject: Record<string, number>;
  byTask: Record<string, number>;
  unscopedCount: number;
};

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function counts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_NOTIFICATION_SUMMARY");
  const entries = Object.entries(value);
  if (!entries.every(([id, n]) => /^[A-Za-z0-9_-]{1,128}$/.test(id) && count(n))) throw new Error("INVALID_NOTIFICATION_SUMMARY");
  return Object.fromEntries(entries);
}
export function parseNotificationSummary(value: unknown, actorId: string): NotificationSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_NOTIFICATION_SUMMARY");
  const row = value as Record<string, unknown>;
  if (row.actorId !== actorId || !count(row.count) || !count(row.unscopedCount)) throw new Error("INVALID_NOTIFICATION_SUMMARY");
  const byProject = counts(row.byProject), byTask = counts(row.byTask);
  if (Object.values(byProject).reduce((a, b) => a + b, 0) + row.unscopedCount !== row.count
    || Object.values(byTask).reduce((a, b) => a + b, 0) > row.count) throw new Error("INVALID_NOTIFICATION_SUMMARY");
  return { actorId, count: row.count, byProject, byTask, unscopedCount: row.unscopedCount };
}

/** Bell, navigation, board and cards share this one actor-owned cache snapshot. */
export function useNotificationSummary({ poll = true }: { poll?: boolean } = {}) {
  const { data: session, status } = useSession();
  const actorId = status === "authenticated" ? session?.user?.id : undefined;
  const query = useQuery({
    queryKey: ["notifications", actorId, "unread-count"],
    enabled: Boolean(actorId),
    queryFn: async ({ signal }) => parseNotificationSummary(await apiFetch<unknown>("/api/notifications/unread-count", { signal, cache: "no-store" }), actorId!),
    staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: true, refetchInterval: poll ? 30_000 : false, retry: false,
  });
  const data = actorId && !query.isError && query.data?.actorId === actorId ? query.data : undefined;
  return { ...query, actorId, data, count: data?.count, byProject: data?.byProject, byTask: data?.byTask };
}
