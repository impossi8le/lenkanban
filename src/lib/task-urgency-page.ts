import type { Prisma } from "@prisma/client";

export const URGENT_TASK_PRIORITIES = ["CRITICAL", "URGENT", "HIGH"];
export const TASK_CREATED_ORDER = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.TaskOrderByWithRelationInput[];

export function taskUrgencyWhere(where: Prisma.TaskWhereInput, urgent: boolean): Prisma.TaskWhereInput {
  return { AND: [where, { priority: urgent ? { in: URGENT_TASK_PRIORITIES } : { notIn: URGENT_TASK_PRIORITIES } }] };
}

/** Two disjoint ordered reads; the sentinel and pagination apply to their union. */
export async function readTaskUrgencyPage<T>({ offset, pageSize, read, countUrgent }: {
  offset: number;
  pageSize: number;
  read: (urgent: boolean, skip: number, take: number) => Promise<T[]>;
  countUrgent: () => Promise<number>;
}): Promise<T[]> {
  const needed = pageSize + 1;
  const urgentCount = offset > 0 ? await countUrgent() : null;
  const urgentRows = urgentCount === null || offset < urgentCount
    ? await read(true, offset, needed) : [];
  if (urgentRows.length >= needed) return urgentRows;
  const normalSkip = urgentCount === null ? 0 : Math.max(0, offset - urgentCount);
  const normalRows = await read(false, normalSkip, needed - urgentRows.length);
  return [...urgentRows, ...normalRows];
}
