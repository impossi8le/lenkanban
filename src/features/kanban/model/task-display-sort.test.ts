import { describe, it, expect } from 'vitest';
import {
  ALTERNATE_TASK_DISPLAY_SORTS,
  isAlternateTaskDisplaySort,
  sortTasksForDisplay,
  type DisplaySortableTask,
} from './task-display-sort';

const baseTask = (id: string, pos = 0, rest: Partial<DisplaySortableTask> = {}): DisplaySortableTask => ({
  id,
  position: pos,
  ...rest,
});

describe('sortTasksForDisplay', () => {
  it('covers all 11 sort choices and unknown mode fallback', () => {
    const list: DisplaySortableTask[] = [
      baseTask('b', 2, { title: 'Б', priority: 'LOW', createdAt: 200, updatedAt: 20, deadline: 50 }),
      baseTask('a', 1, { title: 'А', priority: 'HIGH', createdAt: 100, updatedAt: 30, deadline: 100 }),
    ];
    expect(sortTasksForDisplay(list, 'position').map(t => t.id)).toEqual(['a', 'b']);
    expect(sortTasksForDisplay(list, 'created-asc').map(t => t.id)).toEqual(['a', 'b']);
    expect(sortTasksForDisplay(list, 'created-desc').map(t => t.id)).toEqual(['b', 'a']);
    expect(sortTasksForDisplay(list, 'updated-asc').map(t => t.id)).toEqual(['b', 'a']);
    expect(sortTasksForDisplay(list, 'updated-desc').map(t => t.id)).toEqual(['a', 'b']);
    expect(sortTasksForDisplay(list, 'deadline-asc').map(t => t.id)).toEqual(['b', 'a']);
    expect(sortTasksForDisplay(list, 'deadline-desc').map(t => t.id)).toEqual(['a', 'b']);
    expect(sortTasksForDisplay(list, 'priority-asc').map(t => t.id)).toEqual(['b', 'a']);
    expect(sortTasksForDisplay(list, 'priority-desc').map(t => t.id)).toEqual(['a', 'b']);
    expect(sortTasksForDisplay(list, 'title-asc').map(t => t.id)).toEqual(['a', 'b']);
    expect(sortTasksForDisplay(list, 'title-desc').map(t => t.id)).toEqual(['b', 'a']);
    expect(sortTasksForDisplay(list, 'unknown-mode').map(t => t.id)).toEqual(['a', 'b']);
  });

  it('orders all 5 priorities in both directions with unknown mapped to 0', () => {
    const tasks: DisplaySortableTask[] = [
      baseTask('1', 0, { priority: 'LOW' }),
      baseTask('2', 0, { priority: 'URGENT' }),
      baseTask('3', 0, { priority: 'OTHER' }),
      baseTask('4', 0, { priority: 'CRITICAL' }),
      baseTask('5', 0, { priority: 'HIGH' }),
      baseTask('6', 0, { priority: 'MEDIUM' }),
    ];
    const desc = sortTasksForDisplay(tasks, 'priority-desc').map(t => t.priority);
    expect(desc).toEqual(['CRITICAL', 'URGENT', 'HIGH', 'MEDIUM', 'LOW', 'OTHER']);
    const asc = sortTasksForDisplay(tasks, 'priority-asc').map(t => t.priority);
    expect(asc).toEqual(['OTHER', 'LOW', 'MEDIUM', 'HIGH', 'URGENT', 'CRITICAL']);
  });

  it('keeps missing and invalid deadlines last in both directions', () => {
    const tasks: DisplaySortableTask[] = [
      baseTask('none', 1, { deadline: null }),
      baseTask('inv', 2, { deadline: 'invalid-date' }),
      baseTask('range', 5, { deadline: 1e300 }),
      baseTask('mid', 3, { deadline: 200 }),
      baseTask('early', 4, { deadline: 100 }),
    ];
    expect(sortTasksForDisplay(tasks, 'deadline-asc').map(t => t.id)).toEqual(['early', 'mid', 'none', 'inv', 'range']);
    expect(sortTasksForDisplay(tasks, 'deadline-desc').map(t => t.id)).toEqual(['mid', 'early', 'none', 'inv', 'range']);
  });

  it('falls back to 0 for missing and invalid created or updated dates', () => {
    const dates: DisplaySortableTask[] = [
      baseTask('valid', 2, { createdAt: '2026-01-01' }),
      baseTask('inv', 1, { createdAt: 'invalid-date' }),
      baseTask('nil', 3, { createdAt: null }),
    ];
    expect(sortTasksForDisplay(dates, 'created-asc').map(t => t.id)).toEqual(['inv', 'nil', 'valid']);
  });

  it('breaks ties deterministically by position then stable id regardless of arrival', () => {
    const a = [baseTask('z', 1, { title: 'Same' }), baseTask('a', 1, { title: 'Same' }), baseTask('m', 0, { title: 'Same' })];
    const b = [baseTask('a', 1, { title: 'Same' }), baseTask('m', 0, { title: 'Same' }), baseTask('z', 1, { title: 'Same' })];
    expect(sortTasksForDisplay(a, 'title-asc').map(t => t.id)).toEqual(['m', 'a', 'z']);
    expect(sortTasksForDisplay(b, 'title-asc').map(t => t.id)).toEqual(['m', 'a', 'z']);
  });

  // #36 acceptance: every offered sort must change the visible order, and the
  // presentation-only sort must never rewrite persisted position/rank fields.
  const distinctTasks = (): DisplaySortableTask[] => [
    baseTask('p1', 10, { title: 'Дельта', priority: 'LOW', createdAt: 300, updatedAt: 200, deadline: null }),
    baseTask('p2', 20, { title: 'Альфа', priority: 'CRITICAL', createdAt: 100, updatedAt: 500, deadline: 400 }),
    baseTask('p3', 30, { title: 'Эхо', priority: 'MEDIUM', createdAt: 500, updatedAt: 100, deadline: 100 }),
    baseTask('p4', 40, { title: 'Браво', priority: 'HIGH', createdAt: 200, updatedAt: 400, deadline: 300 }),
    baseTask('p5', 50, { title: 'Гамма', priority: 'URGENT', createdAt: 400, updatedAt: 300, deadline: 200 }),
  ];
  const canonicalOrder = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const expectedOrders: Record<string, string[]> = {
    'created-asc': ['p2', 'p4', 'p1', 'p5', 'p3'],
    'created-desc': ['p3', 'p5', 'p1', 'p4', 'p2'],
    'updated-asc': ['p3', 'p1', 'p5', 'p4', 'p2'],
    'updated-desc': ['p2', 'p4', 'p5', 'p1', 'p3'],
    'deadline-asc': ['p3', 'p5', 'p4', 'p2', 'p1'],
    'deadline-desc': ['p2', 'p4', 'p5', 'p3', 'p1'],
    'priority-asc': ['p1', 'p3', 'p4', 'p5', 'p2'],
    'priority-desc': ['p2', 'p5', 'p4', 'p3', 'p1'],
    'title-asc': ['p2', 'p4', 'p5', 'p1', 'p3'],
    'title-desc': ['p3', 'p1', 'p5', 'p4', 'p2'],
  };

  it.each(ALTERNATE_TASK_DISPLAY_SORTS)(
    'changes the visible order for %s and restores the persisted position order',
    (sortBy) => {
      const tasks = distinctTasks();
      const before = JSON.stringify(tasks);
      const sorted = sortTasksForDisplay(tasks, sortBy);
      expect(sorted.map(task => task.id)).toEqual(expectedOrders[sortBy]);
      expect(sorted.map(task => task.id)).not.toEqual(canonicalOrder);
      expect(sortTasksForDisplay(tasks, 'position').map(task => task.id)).toEqual(canonicalOrder);
      expect(JSON.stringify(tasks)).toBe(before);
      expect(sorted.map(task => task.position)).not.toEqual(
        sortTasksForDisplay(tasks, 'position').map(task => task.position),
      );
    },
  );

  it('exposes exactly the ten alternate modes and no position mode to the DnD policy', () => {
    expect(ALTERNATE_TASK_DISPLAY_SORTS).toHaveLength(10);
    for (const sortBy of ALTERNATE_TASK_DISPLAY_SORTS) {
      expect(isAlternateTaskDisplaySort(sortBy)).toBe(true);
    }
    for (const sortBy of ['position', '', 'unknown-mode', 'POSITION', 'priority']) {
      expect(isAlternateTaskDisplaySort(sortBy)).toBe(false);
    }
    // Every alternate mode must be handled by the sorter, not silently ignored.
    const tasks = distinctTasks();
    for (const sortBy of ALTERNATE_TASK_DISPLAY_SORTS) {
      expect(sortTasksForDisplay(tasks, sortBy).map(task => task.id)).not.toEqual(canonicalOrder);
    }
  });

  it('preserves frozen input, handles non-finite position, and does not drop duplicates', () => {
    const dup: DisplaySortableTask[] = [
      baseTask('dup', Number.NaN),
      baseTask('dup', 2),
      baseTask('first', 1),
    ];
    Object.freeze(dup);
    dup.forEach(t => Object.freeze(t));
    const sorted = sortTasksForDisplay(dup, 'position');
    expect(sorted).toHaveLength(3);
    expect(sorted.map(t => t.id)).toEqual(['dup', 'first', 'dup']);
  });
});

