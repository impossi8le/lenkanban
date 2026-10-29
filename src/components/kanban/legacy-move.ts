type LegacyTask = { id: string; columnId?: string | null; position: number };
export type LegacyRect = { top: number; left: number; width: number; height: number };

export function planLegacyMove<T extends LegacyTask>(input: {
  tasks: readonly T[];
  taskId: string;
  toColumnId: string;
  centerY: number;
  rects: ReadonlyMap<string, LegacyRect>;
}) {
  const { tasks, taskId, toColumnId, centerY, rects } = input;
  const active = tasks.find(task => task.id === taskId);
  if (!active) return null;
  const ordered = tasks.filter(task => task.columnId === toColumnId)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const destination = ordered.filter(task => task.id !== taskId);
  const sourceIndex = ordered.findIndex(task => task.id === taskId);
  const found = destination.findIndex(task => {
    const rect = rects.get(task.id);
    if (!rect) return false;
    const midpoint = rect.top + rect.height / 2;
    // Keyboard sorting lands exactly at a neighbor's center. Break a tie in
    // the travel direction, so both ArrowUp and ArrowDown change the slot.
    return centerY < midpoint || (centerY === midpoint
      && sourceIndex > ordered.findIndex(candidate => candidate.id === task.id));
  });
  const index = found < 0 ? destination.length : found;
  if (active.columnId === toColumnId && sourceIndex === index) return null;
  const beforeTaskId = destination[index - 1]?.id ?? null;
  const afterTaskId = destination[index]?.id ?? null;
  const before = beforeTaskId ? rects.get(beforeTaskId) : undefined;
  const after = afterTaskId ? rects.get(afterTaskId) : undefined;
  const edge = after ?? before ?? rects.get(toColumnId);
  const indicator = edge ? {
    left: edge.left,
    width: edge.width,
    top: before && after ? (before.top + before.height + after.top) / 2
      : after ? after.top - 4 : before ? before.top + before.height + 4 : edge.top + 64,
  } : null;
  destination.splice(index, 0, { ...active, columnId: toColumnId });
  const positions = new Map(destination.map((task, i) => [task.id, (i + 1) * 1024]));
  return {
    toColumnId, beforeTaskId, afterTaskId, indicator,
    tasks: tasks.map(task => positions.has(task.id)
      ? { ...task, columnId: toColumnId, position: positions.get(task.id)! } : task),
  };
}
