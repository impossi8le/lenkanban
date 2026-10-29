import { z } from "zod";
import type { TaskRequestState } from "./task-request-policy";

export const lifecycleColumnFields = ["submittedColumnId", "inProgressColumnId", "needsInfoColumnId", "completedColumnId", "closedColumnId"] as const;
export const lifecycleWorkflowKeys: Partial<Record<typeof lifecycleColumnFields[number], string>> = {
  submittedColumnId: "TODO", inProgressColumnId: "IN_PROGRESS", completedColumnId: "REVIEW", closedColumnId: "DONE",
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const lifecycleColumnMapSchema = z.object({
  contractVersion: z.literal(1), submittedColumnId: id, inProgressColumnId: id,
  needsInfoColumnId: id, completedColumnId: id, closedColumnId: id,
}).strict().refine(value => new Set(lifecycleColumnFields.map(key => value[key])).size === 5, "Distinct columns required");
export type LifecycleColumnMap = z.infer<typeof lifecycleColumnMapSchema>;
export class LifecycleColumnConfigurationError extends Error {
  constructor(readonly code: "LIFECYCLE_COLUMNS_REQUIRED" | "INVALID_LIFECYCLE_COLUMNS") { super(code); }
}
export function decodeLifecycleColumnMap(value: unknown): LifecycleColumnMap | null {
  if (value === null) return null;
  const parsed = lifecycleColumnMapSchema.safeParse(value);
  if (!parsed.success) throw new LifecycleColumnConfigurationError("INVALID_LIFECYCLE_COLUMNS");
  return parsed.data;
}
export function lifecycleColumnId(map: LifecycleColumnMap, state: TaskRequestState): string | null {
  switch (state) {
    case "SUBMITTED": return map.submittedColumnId;
    case "IN_PROGRESS": return map.inProgressColumnId;
    case "NEEDS_INFO": return map.needsInfoColumnId;
    case "COMPLETED": return map.completedColumnId;
    case "CLOSED": return map.closedColumnId;
    default: return null; // DRAFT/CANCELLED have no agreed destination.
  }
}
export function validateLifecycleColumnTargets(map: LifecycleColumnMap, columns: readonly { id: string; projectId: string; workflowKey: string }[], projectId: string): void {
  for (const key of lifecycleColumnFields) {
    const matches = columns.filter(column => column.id === map[key] && column.projectId === projectId);
    const expectedKey = lifecycleWorkflowKeys[key];
    if (matches.length !== 1 || (expectedKey ? matches[0].workflowKey !== expectedKey : matches[0].workflowKey === "DONE")) {
      throw new LifecycleColumnConfigurationError("INVALID_LIFECYCLE_COLUMNS");
    }
  }
}
