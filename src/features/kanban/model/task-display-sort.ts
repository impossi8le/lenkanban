// Presentation-only modes. They never write rank or position: `position`
// always restores the persisted order supplied by the board controller.
export const ALTERNATE_TASK_DISPLAY_SORTS = [
  'created-desc',
  'created-asc',
  'updated-desc',
  'updated-asc',
  'deadline-asc',
  'deadline-desc',
  'priority-desc',
  'priority-asc',
  'title-asc',
  'title-desc',
] as const;

export type AlternateTaskDisplaySort = (typeof ALTERNATE_TASK_DISPLAY_SORTS)[number];

export type TaskDisplaySort = 'position' | AlternateTaskDisplaySort;

const alternateTaskDisplaySorts: ReadonlySet<string> = new Set(ALTERNATE_TASK_DISPLAY_SORTS);

/**
 * Single source of truth for "the board is showing a derived order". V2 must
 * disable positional drag/menu moves for exactly these modes.
 */
export function isAlternateTaskDisplaySort(sortBy: string): sortBy is AlternateTaskDisplaySort {
  return alternateTaskDisplaySorts.has(sortBy);
}

export interface DisplaySortableTask {
  id: string;
  position: number;
  priority?: string | null;
  title?: string | null;
  createdAt?: Date | string | number | null;
  updatedAt?: Date | string | number | null;
  deadline?: Date | string | number | null;
}

const PRIORITY_MAP: Record<string, number> = {
  CRITICAL: 5,
  URGENT: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function toTimestamp(val: Date | string | number | null | undefined): number | null {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    const t = val.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof val === 'number') return Number.isFinite(val) && Math.abs(val) <= 8640000000000000 ? val : null;
  if (typeof val === 'string') {
    const t = Date.parse(val);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function getPos(task: DisplaySortableTask): number {
  return Number.isFinite(task.position) ? task.position : 0;
}

function getPriority(task: DisplaySortableTask): number {
  const p = typeof task.priority === 'string' ? task.priority.trim().toUpperCase() : '';
  return PRIORITY_MAP[p] ?? 0;
}

function compareDeadline(a: DisplaySortableTask, b: DisplaySortableTask, desc: boolean): number {
  const at = toTimestamp(a.deadline);
  const bt = toTimestamp(b.deadline);
  if (at === null && bt === null) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  return desc ? bt - at : at - bt;
}

export function sortTasksForDisplay<T extends DisplaySortableTask>(
  tasks: readonly T[],
  sortBy: string
): T[] {
  return [...tasks].sort((a, b) => {
    let diff = 0;
    switch (sortBy) {
      case 'created-asc':
        diff = (toTimestamp(a.createdAt) ?? 0) - (toTimestamp(b.createdAt) ?? 0);
        break;
      case 'created-desc':
        diff = (toTimestamp(b.createdAt) ?? 0) - (toTimestamp(a.createdAt) ?? 0);
        break;
      case 'updated-asc':
        diff = (toTimestamp(a.updatedAt) ?? 0) - (toTimestamp(b.updatedAt) ?? 0);
        break;
      case 'updated-desc':
        diff = (toTimestamp(b.updatedAt) ?? 0) - (toTimestamp(a.updatedAt) ?? 0);
        break;
      case 'deadline-asc':
        diff = compareDeadline(a, b, false);
        break;
      case 'deadline-desc':
        diff = compareDeadline(a, b, true);
        break;
      case 'priority-asc':
        diff = getPriority(a) - getPriority(b);
        break;
      case 'priority-desc':
        diff = getPriority(b) - getPriority(a);
        break;
      case 'title-asc':
        diff = (a.title ?? '').localeCompare(b.title ?? '', 'ru');
        break;
      case 'title-desc':
        diff = (b.title ?? '').localeCompare(a.title ?? '', 'ru');
        break;
      default:
        break;
    }
    return diff || (getPos(a) - getPos(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

