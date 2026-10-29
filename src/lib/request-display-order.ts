import { isUrgentRequest } from "./request-presentation";

/** Same order as GET /api/tasks, independent of status, rank or last edit. */
export function compareRequestsForDisplay(
  a: { id: string; priority?: string | null; createdAt?: string | Date | null },
  b: { id: string; priority?: string | null; createdAt?: string | Date | null },
): number {
  const urgency = Number(isUrgentRequest(b.priority)) - Number(isUrgentRequest(a.priority));
  if (urgency) return urgency;
  const timestamp = (value: typeof a.createdAt) => {
    const result = value ? new Date(value).getTime() : 0;
    return Number.isFinite(result) ? result : 0;
  };
  const created = timestamp(b.createdAt) - timestamp(a.createdAt);
  return created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Actor-visible server work cursor; urgency does not affect BezNal order. */
export function compareRequestsByVisibleWork(
  a: { id: string; lastVisibleWorkAt?: string | Date | null; createdAt?: string | Date | null },
  b: { id: string; lastVisibleWorkAt?: string | Date | null; createdAt?: string | Date | null },
): number {
  const timestamp = (value: string | Date | null | undefined) => { const time = value ? new Date(value).getTime() : 0; return Number.isFinite(time) ? time : 0; };
  return timestamp(b.lastVisibleWorkAt ?? b.createdAt) - timestamp(a.lastVisibleWorkAt ?? a.createdAt)
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
