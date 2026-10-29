"use client";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

type Props = {
  taskId: string;
  actorId?: string;
  version: number;
};

function latestQuestion(activities: unknown[]): string | null {
  // The existing endpoint returns the last 50 activities, newest first. Never
  // substitute an older question when the latest request has no question text.
  const request = activities.find((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item)
    && "action" in item && item.action === "request_info_requested");
  const value = request?.newValue;
  if (!value || typeof value !== "object" || Array.isArray(value) || !("reason" in value)) return null;
  return typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : null;
}

/** Read-only context for a fresh NEEDS_INFO snapshot; lifecycle owns visibility. */
export function RequestInfoQuestion({ taskId, actorId, version }: Props) {
  const question = useQuery({
    queryKey: ["request-info-question", taskId, actorId ?? null, version],
    enabled: Boolean(actorId),
    queryFn: async ({ signal }) => {
      const activities = await apiFetch<unknown>(`/api/activities?taskId=${encodeURIComponent(taskId)}`, { signal });
      if (!Array.isArray(activities)) throw new Error("Invalid activities response");
      return latestQuestion(activities);
    },
    retry: false,
    throwOnError: false,
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (!actorId) return null;

  return (
    <div className="space-y-2 rounded-md border bg-background p-3" aria-label="Вопрос по обращению">
      <h4 className="font-semibold">Вопрос специалиста</h4>
      {question.isFetching || !question.isFetchedAfterMount ? (
        <p role="status">Загружаем вопрос…</p>
      ) : question.isError ? (
        <>
          <p role="alert">Ошибка загрузки вопроса. Попробуйте загрузить его ещё раз.</p>
          <Button type="button" variant="outline" onClick={() => void question.refetch()}>Загрузить вопрос ещё раз</Button>
        </>
      ) : question.data ? (
        <p className="whitespace-pre-wrap break-words">{question.data}</p>
      ) : (
        <p>Вопрос не указан в последних действиях. Уточните у исполнителя, какие сведения нужны.</p>
      )}
    </div>
  );
}
