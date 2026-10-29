"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { TaskChangesResponse } from "@/lib/task-change-contract";

/** One actor-scoped batch read is shared by all cards on the board. */
export function useTaskChanges(projectId: string, taskId?: string) {
  const { data: session } = useSession();
  const actorId = session?.user?.id;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["task-changes", actorId, projectId, taskId ?? ""],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ projectId });
      if (taskId) params.set("taskId", taskId);
      const result = await apiFetch<TaskChangesResponse>(`/api/tasks/changes?${params}`, { signal, cache: "no-store" });
      if (result?.actorId !== actorId || !result.byTask || typeof result.byTask !== "object") throw new Error("CHANGE_READER_MISMATCH");
      return result;
    },
    enabled: Boolean(actorId && projectId),
    staleTime: 0, refetchOnMount: "always", refetchInterval: 30_000, retry: false,
  });
  useEffect(() => {
    if (!actorId || !projectId) return;
    // Existing task reads/realtime invalidations also refresh this read model.
    // Receipt writes never invalidate tasks or change the board's order.
    const unsubscribe = client.getQueryCache().subscribe(event => {
      const key = event.query.queryKey;
      if (event.type !== "updated" || !["tasks", "task", "activities"].includes(String(key[0]))) return;
      const relevant = key[0] === "tasks" ? key.includes(projectId) : Boolean(taskId && key.includes(taskId));
      if (relevant && (event.action.type === "success" || event.action.type === "invalidate")) {
        void client.invalidateQueries({ queryKey: ["task-changes", actorId, projectId] });
      }
    });
    return unsubscribe;
  }, [actorId, projectId, taskId, client]);
  return { ...query, actorId, data: query.isError ? undefined : query.data };
}
