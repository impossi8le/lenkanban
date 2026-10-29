import { z } from "zod";

export interface WorkflowMoveColumn {
  id: string;
  projectId: string;
  workflowKey: string;
  // Populated by the repository from ProjectColumn.position for DONE columns.
  precedingColumnId?: string | null;
}

export function isPlainMoveRouteAllowed(
  source: WorkflowMoveColumn,
  destination: WorkflowMoveColumn,
): boolean {
  if (source.projectId !== destination.projectId) return false;
  if (source.id === destination.id) return true;
  if (source.workflowKey === "DONE") return false;
  return destination.workflowKey !== "DONE" ||
    destination.precedingColumnId === source.id;
}

export const MoveTaskRequestSchema = z
  .object({
    toColumnId: z.string().min(1),
    beforeTaskId: z.string().min(1).nullable(),
    afterTaskId: z.string().min(1).nullable(),
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export type MoveTaskRequest = z.infer<typeof MoveTaskRequestSchema>;

export interface MoveTaskResponse {
  operationId: string;
  boardRevision: number;
  task: {
    id: string;
    columnId: string;
    version: number;
    status: string;
  };
}

const defaultWorkflowKeys = [
  "TODO",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
] as const;

export function defaultWorkflowKey(
  position: number,
  columnId: string,
): string {
  return defaultWorkflowKeys[position] ?? `COLUMN_${columnId}`;
}

export function derivedTaskStatus(workflowKey: string): string {
  return workflowKey === "REVIEW" ? "IN_REVIEW" : workflowKey;
}

export function resolveWorkflowColumnFilter(
  savedFilter: string,
  columns: ReadonlyArray<{ id: string; workflowKey: string }>,
): string {
  const directColumn = columns.find((column) => column.id === savedFilter);
  if (directColumn) {
    return directColumn.id;
  }

  return (
    columns.find(
      (column) =>
        column.workflowKey === savedFilter ||
        derivedTaskStatus(column.workflowKey) === savedFilter,
    )?.id ?? savedFilter
  );
}

const reservedWorkflowKeys = new Set<string>(defaultWorkflowKeys);
const legacyWorkflowKeyByName: Readonly<Record<string, string>> = {
  TODO: "TODO",
  "К ВЫПОЛНЕНИЮ": "TODO",
  IN_PROGRESS: "IN_PROGRESS",
  "В РАБОТЕ": "IN_PROGRESS",
  IN_REVIEW: "REVIEW",
  REVIEW: "REVIEW",
  "НА ПРОВЕРКЕ": "REVIEW",
  DONE: "DONE",
  "ГОТОВО": "DONE",
};

export function workflowKeyForTemplateColumn(input: {
  storedWorkflowKey?: string;
  name: string;
  columnId: string;
}): string {
  if (input.storedWorkflowKey !== undefined) {
    return reservedWorkflowKeys.has(input.storedWorkflowKey)
      ? input.storedWorkflowKey
      : defaultWorkflowKey(4, input.columnId);
  }

  return (
    legacyWorkflowKeyByName[input.name.trim().toUpperCase()] ??
    defaultWorkflowKey(4, input.columnId)
  );
}
