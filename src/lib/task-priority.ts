import type { z } from "zod";
import type { taskPrioritySchema } from "./validators";

export type TaskPriority = z.infer<typeof taskPrioritySchema>;

const presentations = {
  CRITICAL: { label: "Срочно", color: "priority-critical", dot: "bg-red-500" },
  URGENT: { label: "Срочно", color: "priority-urgent", dot: "bg-red-500" },
  HIGH: { label: "Срочно", color: "priority-high", dot: "bg-orange-500" },
  MEDIUM: { label: "Не срочно", color: "priority-medium", dot: "bg-amber-500" },
  LOW: { label: "Не срочно", color: "priority-low", dot: "bg-slate-500" },
} as const satisfies Record<TaskPriority, { label: string; color: string; dot: string }>;

const unknown = {
  label: "Неизвестный приоритет",
  color: "border-border bg-muted text-muted-foreground",
  dot: "bg-muted-foreground",
} as const;

export const TASK_PRIORITY_OPTIONS = (["URGENT", "LOW"] as const)
  .map(value => ({ value, ...presentations[value] }));

// Display only: the original DTO/value is never rewritten for a round-trip.
export function getTaskPriorityPresentation(value: unknown) {
  const key = typeof value === "string" ? value.trim().toUpperCase() : "";
  return Object.prototype.hasOwnProperty.call(presentations, key)
    ? presentations[key as TaskPriority]
    : unknown;
}
