export type ChecklistProgress = {
  total: number;
  completed: number;
};

type ChecklistCarrier = {
  checklist?: ChecklistProgress | null;
  checklistItems?: ReadonlyArray<{ completed: boolean }> | null;
};

/**
 * Board and list responses carry an aggregate (`checklist`); the card detail
 * response still carries the item rows (`checklistItems`). Prefer the aggregate
 * so the list never needs the rows, and fall back for detail-shaped tasks.
 */
export function checklistProgressOf(task: ChecklistCarrier): ChecklistProgress | null {
  if (task.checklist) {
    return task.checklist.total > 0 ? task.checklist : null;
  }
  const items = task.checklistItems;
  if (!items || items.length === 0) return null;
  return { total: items.length, completed: items.filter(item => item.completed).length };
}
