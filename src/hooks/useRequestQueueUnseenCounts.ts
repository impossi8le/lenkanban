"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

import { apiFetch } from "@/lib/api";

type UnseenCounts = {
  byProject: Record<string, number>;
  total: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUnseenCounts(value: unknown): UnseenCounts {
  if (!isRecord(value) || !isRecord(value.byProject)) {
    throw new Error("Invalid request queue unseen response");
  }

  const entries: Array<[string, number]> = [];
  let sum = 0;

  for (const [projectId, count] of Object.entries(value.byProject)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid request queue unseen response");
    }

    entries.push([projectId, count]);
    sum += count;
  }

  const total = value.total;

  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    sum !== total
  ) {
    throw new Error("Invalid request queue unseen response");
  }

  return { byProject: Object.fromEntries(entries), total };
}

export function useRequestQueueUnseenCounts() {
  const { data: session, status } = useSession();
  const actorId = status === "authenticated" ? session?.user?.id : undefined;

  const query = useQuery({
    queryKey: ["request-queue-unseen", actorId],
    queryFn: async ({ signal }) => {
      const response = await apiFetch<unknown>("/api/tasks/queue-unseen", {
        signal,
      });

      return parseUnseenCounts(response);
    },
    enabled: Boolean(actorId),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const data = actorId && !query.isError ? query.data : undefined;

  return {
    byProject: data?.byProject ?? {},
    total: data?.total ?? 0,
    isLoading: Boolean(actorId) && query.isLoading,
    isError: Boolean(actorId) && query.isError,
    refetch: query.refetch,
  };
}
