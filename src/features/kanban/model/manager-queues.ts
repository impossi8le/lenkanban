import type { Prisma } from "@prisma/client";

export const managerQueues = {
  overdue: "Просроченные",
  upcoming: "Ближайшие 7 дней",
  unassigned: "Без исполнителя",
  period: "По периоду",
} as const;
export type ManagerQueue = keyof typeof managerQueues;
export type ManagerFilters = { queue: ManagerQueue; from?: string; to?: string };

function dateBoundary(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== value) throw new Error("Некорректная дата периода");
  return date;
}

export function parseManagerFilters(params: Record<string, string | string[] | undefined>): ManagerFilters {
  const queue = params.queue ?? "overdue";
  if (typeof queue !== "string" || !Object.hasOwn(managerQueues, queue)) throw new Error("Неизвестная очередь");
  const from = params.from || undefined;
  const to = params.to || undefined;
  if ((from !== undefined && typeof from !== "string") || (to !== undefined && typeof to !== "string")) {
    throw new Error("Некорректный период");
  }
  if (from) dateBoundary(from);
  if (to) dateBoundary(to);
  if (from && to && from > to) throw new Error("Начало периода позже окончания");
  if (queue === "period" && !from && !to) throw new Error("Укажите период срока выполнения");
  return { queue: queue as ManagerQueue, from, to };
}

/** Queue constraints are ANDed with the shared read policy by the caller. */
export function managerQueueWhere(filters: ManagerFilters, now: Date): Prisma.TaskWhereInput {
  const { queue, from, to } = parseManagerFilters(filters);
  const conditions: Prisma.TaskWhereInput[] = [{
    OR: [
      { request: { is: null }, status: { notIn: ["DONE", "CANCELLED"] } },
      { request: { is: { contractVersion: 1, deletedAt: null, state: { in: ["SUBMITTED", "IN_PROGRESS"] } } } },
    ],
  }];
  if (queue === "overdue") conditions.push({ deadline: { lt: now } });
  if (queue === "upcoming") conditions.push({ deadline: { gte: now, lt: new Date(now.getTime() + 7 * 86400000) } });
  if (queue === "unassigned") conditions.push({ OR: [
    { request: { is: null }, assignees: { none: {} } },
    { request: { is: { executorId: null } } },
  ] });
  if (from || to) conditions.push({ deadline: {
    ...(from ? { gte: dateBoundary(from) } : {}),
    ...(to ? { lt: new Date(dateBoundary(to).getTime() + 86400000) } : {}),
  } });
  return { AND: conditions };
}
