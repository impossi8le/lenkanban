import { apiFetch, apiPatch, apiPost, type ApiTelemetryContext } from "@/lib/api";
import type { TaskType } from "@/components/kanban/Card";
import type { TaskCommandAck } from "@/lib/task-command";

export type ModalTaskSave = { title: string; description?: string | null; priority?: string; deadline?: Date | null; columnId?: string; expectedVersion?: number };
export type ScalarChanges = { title?: string; description?: string | null; priority?: string; deadline?: string | null };
export type ScalarIntent = Readonly<{ operationId: string; expectedVersion: number; changes: Readonly<ScalarChanges> }>;
export type ScalarCommand = Readonly<{ body: ScalarIntent; actionId: string; taskId: string; projectId: string; onResult?: ApiTelemetryContext["onResult"] }>;

/** Shared legacy callbacks carry a baseline title alongside another field's intent. */
export function modalScalarChanges(data: ModalTaskSave, current: TaskType): ScalarChanges {
  const result: ScalarChanges = {};
  const hasOtherField = ["description", "priority", "deadline"].some(key => Object.hasOwn(data, key));
  if (!hasOtherField) {
    const title = data.title.trim();
    if (!title || title.length > 200) throw new Error("INVALID_CHANGE");
    if (title !== current.title.trim()) result.title = title;
  }
  if (Object.hasOwn(data, "description")) {
    const description = data.description?.trim() || null;
    if (description && description.length > 50000) throw new Error("INVALID_CHANGE");
    if (description !== (current.description?.trim() || null)) result.description = description;
  }
  if (Object.hasOwn(data, "priority")) {
    if (!["LOW", "MEDIUM", "HIGH", "URGENT", "CRITICAL"].includes(data.priority ?? "")) throw new Error("INVALID_CHANGE");
    if (data.priority !== current.priority) result.priority = data.priority;
  }
  if (Object.hasOwn(data, "deadline")) {
    const deadline = data.deadline === null ? null : data.deadline?.toISOString();
    if (deadline === undefined) throw new Error("INVALID_CHANGE");
    const previous = current.deadline ? new Date(current.deadline).toISOString() : null;
    if (deadline !== previous) result.deadline = deadline;
  }
  return result;
}
export async function patchScalarCommand(command: ScalarCommand): Promise<TaskCommandAck> {
  if (Object.keys(command.body.changes).length === 1 && Object.hasOwn(command.body.changes, "description")) {
    const path = `/api/tasks/${encodeURIComponent(command.taskId)}/lifecycle`;
    const metadata = await apiFetch<unknown>(path, { method: "GET", cache: "no-store" }, { actionId: command.actionId });
    let marked: boolean;
    try {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
      const values: Record<string, unknown> = {};
      for (const key of ["taskId", "projectId", "marked", "deleted"]) {
        const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
        if (!descriptor || !("value" in descriptor)) throw new Error();
        values[key] = descriptor.value;
      }
      if (values.taskId !== command.taskId || values.projectId !== command.projectId
        || typeof values.marked !== "boolean" || typeof values.deleted !== "boolean" || values.deleted) throw new Error();
      marked = values.marked;
    } catch { throw Object.assign(new Error("INVALID_LIFECYCLE_METADATA"), { status: 409 }); }
    if (marked) return apiPost<TaskCommandAck>(`/api/tasks/${encodeURIComponent(command.taskId)}`, {
      operationId: command.body.operationId,
      expectedVersion: command.body.expectedVersion,
      action: "edit_description",
      description: command.body.changes.description,
    }, { actionId: command.actionId, operationId: command.body.operationId, ...(command.onResult ? { onResult: command.onResult } : {}) });
  }
  return apiPatch<TaskCommandAck>(`/api/tasks/${encodeURIComponent(command.taskId)}`, command.body, { actionId: command.actionId, operationId: command.body.operationId, ...(command.onResult ? { onResult: command.onResult } : {}) });
}
export function readTaskDetails(taskId: string, telemetry: ApiTelemetryContext): Promise<TaskType> {
  return apiFetch<TaskType>(`/api/tasks/${encodeURIComponent(taskId)}?view=details`, { method: "GET", cache: "no-store" }, telemetry);
}
