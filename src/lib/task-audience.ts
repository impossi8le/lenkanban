import type { Prisma } from "@prisma/client";

type Actor = Readonly<{ id: string; globalRole: "USER" | "ADMIN" }>;
export type TaskAudience = Readonly<{ authorId: string; audienceUserIds: readonly string[] }>;

/** Destination department leadership grants canonical submitted read only. */
export function taskDepartmentLeaderReadPredicate(actor: Actor): Prisma.TaskWhereInput {
  return { AND: [
    { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } },
    { project: { department: { is: { archivedAt: null, leaderId: actor.id } } } },
  ] };
}

/** Existing group leadership remains a read/management fact, never department staff. */
export function taskResponsibleGroupLeaderReadPredicate(actor: Actor): Prisma.TaskWhereInput {
  return { AND: [
    { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } },
    { project: { responsibleGroup: { is: { archivedAt: null, leaderId: actor.id, members: { some: { userId: actor.id } } } } } },
  ] };
}

/** A persisted watcher reads one legacy/submitted task, never another draft. */
export function taskWatcherReadPredicate(actor: Actor): Prisma.TaskWhereInput {
  return { AND: [
    { OR: [{ request: { is: null } }, { request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } } }] },
    { watchers: { some: { userId: actor.id } } },
  ] };
}

function validAudience(request: TaskAudience): boolean {
  return Boolean(request) && typeof request === "object" && typeof request.authorId === "string" && Array.isArray(request.audienceUserIds)
    && request.audienceUserIds.length <= 20
    && request.audienceUserIds.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))
    && new Set(request.audienceUserIds).size === request.audienceUserIds.length;
}

/** An additional cap on ordinary task read, never a standalone role grant. */
export function taskAudienceReadPredicate(actor: Actor): Prisma.TaskWhereInput {
  if (actor.globalRole === "ADMIN") return {};
  return { OR: [
    { request: { is: null } },
    { request: { is: { audienceUserIds: { isEmpty: true } } } },
    { request: { is: { authorId: actor.id } } },
    { request: { is: { audienceUserIds: { has: actor.id } } } },
    { project: { responsibleGroup: { is: {
      archivedAt: null, leaderId: actor.id, members: { some: { userId: actor.id } },
    } } } },
    taskDepartmentLeaderReadPredicate(actor),
    taskWatcherReadPredicate(actor),
  ] };
}

/** Unknown storage fails closed; only a real absent marker is legacy/general. */
export function canReadTaskAudience(actor: Actor, request: TaskAudience | null, currentDestinationLeader = false, currentTaskWatcher = false): boolean {
  if (actor.globalRole === "ADMIN") return true;
  return request === null || (validAudience(request)
    && (request.audienceUserIds.length === 0 || request.authorId === actor.id || request.audienceUserIds.includes(actor.id)
      || currentDestinationLeader === true || currentTaskWatcher === true));
}

/** Assignment/reopen must not add a new audience member, including an ADMIN. */
export function isTaskAudienceRecipient(request: TaskAudience | null, userId: string): boolean {
  return request === null || (validAudience(request)
    && (request.audienceUserIds.length === 0 || request.audienceUserIds.includes(userId)));
}

/** Kept separate from closed lifecycle-marker projections and decoders. */
export async function readTaskAudience(database: Pick<Prisma.TransactionClient, "taskRequest">, taskId: string): Promise<TaskAudience | null> {
  return database.taskRequest.findUnique({ where: { taskId }, select: { authorId: true, audienceUserIds: true } });
}
