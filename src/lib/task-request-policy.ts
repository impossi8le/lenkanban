/** These are marker codes, never inferred from legacy Task.status or columns. */
export const TASK_REQUEST_STATES = ["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED", "CANCELLED"] as const;
export type TaskRequestState = typeof TASK_REQUEST_STATES[number];
export type TaskRequestMarker = Readonly<{
  taskId: string;
  contractVersion: 1;
  state: TaskRequestState;
  authorId: string;
  executorId: string | null;
}>;
export type TaskRequestDecodeResult = { valid: true; marker: TaskRequestMarker | null } | { valid: false };
export type TaskRequestDecision = { allowed: true; mode: "legacy" }
  | { allowed: false; code: "REQUEST_LIFECYCLE_NOT_ENABLED" | "INVALID_REQUEST_MARKER" };

const keys = ["taskId", "contractVersion", "state", "authorId", "executorId"] as const;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function identifier(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

/** Unknown persistence values are closed projections, not casts or repairs. */
export function decodeTaskRequestMarker(value: unknown, expectedTaskId: string): TaskRequestDecodeResult {
  try {
    if (value === null) return { valid: true, marker: null };
    if (!identifier(expectedTaskId)) return { valid: false };
    if (typeof value !== "object" || Array.isArray(value)) return { valid: false };
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key as typeof keys[number]))) {
      return { valid: false };
    }
    const row: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return { valid: false };
      row[key] = descriptor.value;
    }
    if (!identifier(row.taskId) || row.taskId !== expectedTaskId || row.contractVersion !== 1 || !identifier(row.authorId)
      || (row.executorId !== null && !identifier(row.executorId)) || typeof row.state !== "string"
      || !TASK_REQUEST_STATES.includes(row.state as TaskRequestState)) return { valid: false };
    const state = row.state as TaskRequestState;
    if ((state === "DRAFT" || state === "SUBMITTED") && row.executorId !== null) return { valid: false };
    if ((state === "IN_PROGRESS" || state === "NEEDS_INFO" || state === "COMPLETED" || state === "CLOSED") && row.executorId === null) return { valid: false };
    return { valid: true, marker: { taskId: row.taskId, contractVersion: 1, state, authorId: row.authorId,
      executorId: row.executorId as string | null } };
  } catch { return { valid: false }; }
}

/** Dispatch/denial only: there is no flag or transition that enables a marker. */
export function evaluateTaskRequestMutation(value: unknown, expectedTaskId: string): TaskRequestDecision {
  const decoded = decodeTaskRequestMarker(value, expectedTaskId);
  if (!decoded.valid) return { allowed: false, code: "INVALID_REQUEST_MARKER" };
  return decoded.marker === null ? { allowed: true, mode: "legacy" }
    : { allowed: false, code: "REQUEST_LIFECYCLE_NOT_ENABLED" };
}
