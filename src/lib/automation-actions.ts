/** Shared action admission policy; safe to import in browser form code. */
export const AUTOMATION_ACTION_TYPES = ["notify_assignees", "notify_creator", "move_to_column", "change_priority", "assign_user"] as const;

/**
 * Closed trigger catalog. A rule may only subscribe to an event the shared
 * mutation paths actually emit; `status_changed` is emitted by the task PATCH,
 * the canonical move and bulk moves through the same event builder.
 */
export const AUTOMATION_TRIGGERS = [
  "task_created",
  "status_changed",
  "priority_changed",
  "assignee_added",
  "deadline_set",
  "tag_added",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const AUTOMATION_TRIGGER_LABELS: Readonly<Record<AutomationTrigger, string>> = {
  task_created: "Задача создана",
  status_changed: "Статус изменён",
  priority_changed: "Приоритет изменён",
  assignee_added: "Добавлен исполнитель",
  deadline_set: "Установлен срок",
  tag_added: "Добавлен тег",
};

export function isAutomationTrigger(value: unknown): value is AutomationTrigger {
  return typeof value === "string" && AUTOMATION_TRIGGERS.some(trigger => trigger === value);
}
export type AutomationActionType = typeof AUTOMATION_ACTION_TYPES[number];
export const AUTOMATION_ACTION_LABELS: Readonly<Record<AutomationActionType, string>> = {
  notify_assignees: "Уведомить исполнителей",
  notify_creator: "Уведомить создателя",
  move_to_column: "Переместить в колонку",
  change_priority: "Изменить приоритет",
  assign_user: "Назначить исполнителя",
};
export interface AutomationNotificationAction {
  type: AutomationActionType;
  /** Draft form shape; only parseAutomationActions produces executable actions. */
  params: { title?: string; message?: string; columnId?: string; userId?: string; priority?: string };
}
export type AutomationAction =
  | { type: "notify_assignees" | "notify_creator"; params: { title?: string; message?: string } }
  | { type: "move_to_column"; params: { columnId: string } }
  | { type: "assign_user"; params: { userId: string } }
  | { type: "change_priority"; params: { priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT" | "CRITICAL" } };

export function parseAutomationActions(value: unknown): AutomationAction[] | null {
  try {
    if (!Array.isArray(value) || value.length === 0) return null;
    const actions: AutomationAction[] = [];
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !("value" in entry)) return null;
      const row: unknown = entry.value;
      if (!row || typeof row !== "object" || Array.isArray(row)
        || Reflect.ownKeys(row).length !== 2) return null;
      const type = Object.getOwnPropertyDescriptor(row, "type");
      const params = Object.getOwnPropertyDescriptor(row, "params");
      if (!type || !("value" in type) || !AUTOMATION_ACTION_TYPES.some(item => item === type.value)
        || !params || !("value" in params) || !params.value || typeof params.value !== "object"
        || Array.isArray(params.value)) return null;
      const normalized: Record<string, string> = {};
      for (const key of Reflect.ownKeys(params.value)) {
        const allowed = type.value === "move_to_column" ? ["columnId"]
          : type.value === "assign_user" ? ["userId"]
          : type.value === "change_priority" ? ["priority"] : ["title", "message"];
        if (typeof key !== "string" || !allowed.includes(key)) return null;
        const property = Object.getOwnPropertyDescriptor(params.value, key);
        if (!property || !("value" in property) || typeof property.value !== "string") return null;
        normalized[key] = property.value;
      }
      // The equality branches preserve the closed union without casting input.
      if (type.value === "notify_assignees" || type.value === "notify_creator") {
        actions.push({ type: type.value, params: normalized });
      } else if (type.value === "move_to_column" && normalized.columnId?.trim()) {
        actions.push({ type: type.value, params: { columnId: normalized.columnId } });
      } else if (type.value === "assign_user" && normalized.userId?.trim()) {
        actions.push({ type: type.value, params: { userId: normalized.userId } });
      } else if (type.value === "change_priority") {
        const priority = normalized.priority;
        if (priority !== "LOW" && priority !== "MEDIUM" && priority !== "HIGH" && priority !== "URGENT" && priority !== "CRITICAL") return null;
        actions.push({ type: type.value, params: { priority } });
      } else return null;
    }
    return actions;
  } catch { return null; }
}
