/** Pure business-history presentation shared by client and server. No persistence or logging. */
export interface ActivityValue {
  text?: string;
  columnId?: string;
  columnName?: string;
  status?: string;
  priority?: string;
  assigneeName?: string;
  deadline?: string | null;
  tagName?: string;
}

function localizedTaskStatus(status: string | undefined): string {
  switch (status) {
    case "TODO":
      return "К выполнению";
    case "IN_PROGRESS":
      return "В работе";
    case "REVIEW":
    case "IN_REVIEW":
      return "На проверке";
    case "DONE":
      return "Готово";
    default:
      return "Другой этап";
  }
}

function localizedPriority(priority: string | undefined): string {
  const labels: Record<string, string> = { LOW: "Низкий", MEDIUM: "Средний", HIGH: "Высокий", URGENT: "Срочный", CRITICAL: "Критический" };
  return priority ? labels[priority] ?? "не указан" : "не указан";
}

function localizedDeadline(value: string | null | undefined): string {
  if (!value) return "не указан";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "не указан";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export function getActivityDescription(activity: {
  action: string;
  oldValue: ActivityValue | null;
  newValue: ActivityValue | null;
  user: { name: string | null; email: string };
}): string {
  const userName = activity.user.name || activity.user.email;

  switch (activity.action) {
    case "request_approved": return `${userName} принял счёт и закрыл заявку`;
    case "request_invoice_marked_ready": return `${userName} отметил счёт готовым`;
    case "request_returned_for_revision": return `${userName} вернул заявку на доработку`;
    case "created":
      return `${userName} создал задачу`;
    case "watcher_added":
      return `${userName} добавил наблюдателя`;
    case "watcher_removed":
      return `${userName} убрал наблюдателя`;

    case "status_changed":
      return `${userName} изменил статус: «${localizedTaskStatus(activity.oldValue?.status)}» → «${localizedTaskStatus(activity.newValue?.status)}»`;

    case "priority_changed":
      return `${userName} изменил приоритет: «${localizedPriority(activity.oldValue?.priority)}» → «${localizedPriority(activity.newValue?.priority)}»`;

    case "assigned":
      return `${userName} назначил исполнителя: ${activity.newValue?.assigneeName || "не указан"}`;

    case "unassigned":
      return `${userName} снял исполнителя: ${activity.oldValue?.assigneeName || "не указан"}`;

    case "deadline_set":
      return `${userName} установил срок: ${localizedDeadline(activity.newValue?.deadline)}`;

    case "deadline_removed":
      return `${userName} убрал срок`;

    case "deadline_changed":
      return `${userName} изменил срок: ${localizedDeadline(activity.oldValue?.deadline)} → ${localizedDeadline(activity.newValue?.deadline)}`;

    case "title_changed":
      return `${userName} изменил название задачи`;

    case "description_changed":
      return `${userName} изменил описание задачи`;

    case "tag_added":
      return `${userName} добавил тег «${activity.newValue?.tagName || "Без названия"}»`;

    case "tag_removed":
      return `${userName} удалил тег «${activity.oldValue?.tagName || "Без названия"}»`;

    case "checklist_item_added":
      return `${userName} добавил пункт чек-листа «${activity.newValue?.text || "Без названия"}»`;
    case "checklist_item_completed":
      return `${userName} выполнил пункт чек-листа «${activity.newValue?.text || "Без названия"}»`;
    case "checklist_item_reopened":
      return `${userName} вернул в работу пункт чек-листа «${activity.newValue?.text || "Без названия"}»`;
    case "checklist_item_updated":
      return `${userName} изменил пункт чек-листа «${activity.newValue?.text || "Без названия"}»`;
    case "checklist_item_deleted":
      return `${userName} удалил пункт чек-листа «${activity.oldValue?.text || "Без названия"}»`;

    case "moved": {
      const statusContext =
        `(статус: «${localizedTaskStatus(activity.oldValue?.status)}» → ` +
        `«${localizedTaskStatus(activity.newValue?.status)}»)`;
      const fromColumnName = activity.oldValue?.columnName;
      const toColumnName = activity.newValue?.columnName;
      if (fromColumnName && toColumnName) {
        return (
          `${userName} переместил задачу из колонки ` +
          `«${fromColumnName}» в «${toColumnName}» ${statusContext}`
        );
      }
      return `${userName} переместил задачу ${statusContext}`;
    }

    default:
      return `${userName} обновил задачу`;
  }
}
