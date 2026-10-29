import { apiFetch } from "@/lib/api";
import type { TaskType } from "@/components/kanban/Card";

export type RequestDetailSelection = { actorId: string; projectId: string; taskId: string; openId: number };
export const requestDetailKey = ({ actorId, projectId, taskId, openId }: RequestDetailSelection) =>
  ["my-task-details", actorId, projectId, taskId, openId] as const;

/** Each opening has its own key and performs a fresh server-authorized read. */
export async function readRequestDetails({ projectId, taskId }: RequestDetailSelection, signal: AbortSignal) {
  const task = await apiFetch<TaskType>(`/api/tasks/${encodeURIComponent(taskId)}?view=details`,
    { method: "GET", cache: "no-store", signal });
  if (task.id !== taskId || task.projectId !== projectId || !Number.isInteger(task.version)
    || task.version! < 0 || task.version! > 2147483647) throw new Error("INVALID_TASK_DETAILS");
  return task;
}
