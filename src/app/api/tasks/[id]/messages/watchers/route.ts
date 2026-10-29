import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getTaskReadWhere } from "@/lib/project-access";
import { lockProjectStatusAuthority } from "@/lib/project-status-policy";
import { decodeStoredTaskRequest } from "@/lib/task-request-marker-lifecycle";
import { TaskCommandError } from "@/lib/task-command";
import { logActivityWithClient } from "@/lib/activity-logger";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { loadTaskWithRelations } from "@/lib/task-queries";
import { emitTaskUpdated } from "@/socket/board-events";
import { apiSuccess, apiError, apiUnauthorized, apiNotFound, apiInvalidJson, apiValidationError, apiInternalError, apiForbidden } from "@/lib/api-response";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const singleBody = z.object({ userId: id }).strict();
const bulkAddBody = z.object({ userIds: z.array(id).max(100).default([]), groupIds: z.array(id).max(20).default([]) }).strict()
  .refine(value => value.userIds.length + value.groupIds.length > 0, "Выберите людей или группы");
const removeBody = z.object({ userIds: z.array(id).min(1).max(200) }).strict();
const activeUser = { isBlocked: false, blockedAt: null } as const;
type Actor = { id: string; globalRole: "USER" | "ADMIN" };
const requestSelect = { taskId: true, contractVersion: true, state: true, authorId: true, executorId: true,
  needsInfoSince: true, pausedTotalMs: true, deletedAt: true, audienceUserIds: true } as const;
function readSelect(actorId: string) {
  return { id: true, projectId: true, request: { select: requestSelect }, project: { select: {
    department: { select: { archivedAt: true, leaderId: true } },
    responsibleGroup: { select: { archivedAt: true, leaderId: true, members: { where: { userId: actorId }, select: { userId: true } } } },
  } } } satisfies Prisma.TaskSelect;
}
type ReadableTask = Prisma.TaskGetPayload<{ select: ReturnType<typeof readSelect> }>;
function canManage(actor: Actor, task: ReadableTask): boolean {
  if (task.request?.state === "DRAFT") return false;
  if (actor.globalRole === "ADMIN" || !task.request || task.request.audienceUserIds.length === 0) return true;
  const { department, responsibleGroup: group } = task.project;
  return task.request.authorId === actor.id || task.request.executorId === actor.id
    || (department?.archivedAt === null && department.leaderId === actor.id)
    || (group?.archivedAt === null && group.leaderId === actor.id && group.members.some(member => member.userId === actor.id));
}
async function readable(db: Prisma.TransactionClient | typeof prisma, actor: Actor, taskId: string) {
  return db.task.findFirst({ where: await getTaskReadWhere(actor, { id: taskId }, db), select: readSelect(actor.id) });
}
function isMissingWatcherTable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return value.code === "P2021" || (value.code === "P2010" && ["42P01", "42703"].includes(String(value.meta?.code)))
    || (typeof value.message === "string" && /relation\s+"?TaskWatcher"?\s+does not exist/i.test(value.message));
}
class WatcherError extends Error {}
function failure(error: unknown, fallback: string) {
  if (error instanceof ForbiddenError) return apiForbidden();
  if (error instanceof UnauthorizedError) return apiUnauthorized();
  if (error instanceof NotFoundError) return apiNotFound(error.message === "Пользователь не найден" ? error.message : "Задача не найдена");
  if (error instanceof WatcherError) return apiError("WATCHER_SELECTION_INVALID", error.message, undefined, 422);
  if (error instanceof TaskCommandError) return apiError(error.code, "Состав наблюдателей изменился. Обновите карточку и повторите действие.", undefined, 409);
  if (isMissingWatcherTable(error)) return apiError("SCHEMA_MIGRATION_REQUIRED", "Хранилище наблюдателей ещё не мигрировано", undefined, 503);
  return apiInternalError(fallback);
}
function noStore(response: Response) { response.headers.set("Cache-Control", "no-store"); return response; }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiUser(request); const { id: taskId } = await context.params;
    const task = await readable(prisma, actor, taskId);
    if (!task) throw new NotFoundError();
    const manage = canManage(actor, task);
    const query = new URL(request.url).searchParams;
    if (query.get("view") === "candidates") {
      if (!manage) throw new ForbiddenError();
      const search = (query.get("search") ?? "").trim().slice(0, 200);
      const [users, groups] = await Promise.all([
        prisma.user.findMany({ where: { ...activeUser, ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}) },
          orderBy: [{ name: "asc" }, { id: "asc" }], take: 50,
          select: { id: true, name: true, primaryDepartment: { select: { name: true } } } }),
        prisma.responsibleGroup.findMany({ where: { archivedAt: null, ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}) },
          orderBy: [{ name: "asc" }, { id: "asc" }], take: 50,
          select: { id: true, name: true, _count: { select: { members: { where: { user: activeUser } } } } } }),
      ]);
      return noStore(apiSuccess({ users: users.map(user => ({ id: user.id, name: user.name, departmentName: user.primaryDepartment?.name ?? null })),
        groups: groups.map(group => ({ id: group.id, name: group.name, memberCount: group._count.members })) }));
    }
    const rows = await prisma.taskWatcher.findMany({ where: { taskId }, orderBy: [{ user: { name: "asc" } }, { userId: "asc" }],
      select: { userId: true, user: { select: { name: true } } } });
    return noStore(apiSuccess({ items: rows.map(row => ({ userId: row.userId, name: row.user.name })), canManage: manage }));
  } catch (error) { return noStore(failure(error, "Не удалось загрузить наблюдателей")); }
}

type Selection = { userIds: string[]; groupIds: string[] };
async function resolveTargets(tx: Prisma.TransactionClient, selection: Selection): Promise<string[]> {
  const chosen = new Set(selection.userIds);
  const groupIds = [...new Set(selection.groupIds)].sort();
  if (groupIds.length) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ResponsibleGroup" WHERE "id" = ANY(${groupIds}::text[]) AND "archivedAt" IS NULL ORDER BY "id" FOR SHARE`;
    if (locked.length !== groupIds.length) throw new WatcherError("Одна из групп больше недоступна. Обновите список и выберите группу заново.");
    // Lock actual membership rows: a lock on the parent alone does not stop
    // concurrent membership removal. 20 groups × 200 unique people = 4000 rows;
    // row 4001 guarantees the union exceeds the supported size.
    const members = await tx.$queryRaw<{ userId: string }[]>`
      SELECT gm."userId" FROM "ResponsibleGroupMember" gm
      JOIN "User" u ON u."id" = gm."userId"
      WHERE gm."groupId" = ANY(${groupIds}::text[]) AND u."isBlocked" = false AND u."blockedAt" IS NULL
      ORDER BY gm."groupId", gm."userId" LIMIT 4001 FOR SHARE OF gm, u
    `;
    for (const member of members) chosen.add(member.userId);
  }
  if (chosen.size > 200) throw new WatcherError("За один раз можно добавить не больше 200 наблюдателей. Выберите меньше людей или групп.");
  if (chosen.size === 0) throw new WatcherError("В выбранных группах нет доступных сотрудников. Выберите людей или другую группу.");
  const ids = [...chosen].sort();
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR SHARE`;
  const users = await tx.user.findMany({ where: { id: { in: ids }, ...activeUser }, select: { id: true } });
  if (users.length !== ids.length) throw new WatcherError("Один из сотрудников больше недоступен. Обновите список получателей.");
  return ids;
}

async function mutateWatchers(tx: Prisma.TransactionClient, actorId: string, taskId: string, projectId: string, selection: Selection, adding: boolean) {
  const projects = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  if (projects.length !== 1) throw new NotFoundError();
  const tasks = await tx.$queryRaw<{ id: string; projectId: string; version: number }[]>`SELECT "id", "projectId", "version" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE`;
  if (tasks.length !== 1) throw new NotFoundError();
  const lockedTask = tasks[0];
  if (lockedTask.projectId !== projectId) throw new TaskCommandError("IDENTITY_CHANGED");
  await tx.$queryRaw`SELECT d."id" FROM "Department" d JOIN "Project" p ON p."departmentId" = d."id" WHERE p."id" = ${projectId} FOR SHARE OF d`;
  await lockProjectStatusAuthority(tx, actorId, projectId);
  await tx.$queryRaw`SELECT "userId" FROM "TaskWatcher" WHERE "taskId" = ${taskId} AND "userId" = ${actorId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true, isBlocked: true, blockedAt: true } });
  if (!actor || actor.isBlocked !== false || actor.blockedAt !== null) throw new NotFoundError();
  const task = await readable(tx, actor, taskId);
  if (!task) throw new NotFoundError();
  if (task.projectId !== projectId) throw new TaskCommandError("IDENTITY_CHANGED");
  if (task.request !== null) {
    const { deletedAt, audienceUserIds: _audience, ...fields } = task.request;
    void _audience;
    const decoded = decodeStoredTaskRequest(fields, taskId);
    if (!decoded.valid || decoded.marker === null) throw new TaskCommandError("INVALID_REQUEST_MARKER");
    if (deletedAt !== null) throw new NotFoundError();
    if (task.request.state === "DRAFT") throw new WatcherError("Сначала отправьте обращение в отдел. После этого можно добавить наблюдателей.");
  }
  const selfRemoval = !adding && selection.userIds.every(id => id === actorId);
  if (!canManage(actor, task) && !selfRemoval) throw new ForbiddenError();
  const targets = adding ? await resolveTargets(tx, selection) : [...new Set(selection.userIds)].sort();
  const existing = await tx.taskWatcher.findMany({ where: { taskId, userId: { in: targets } }, select: { userId: true } });
  const present = new Set(existing.map(row => row.userId));
  const changed = targets.filter(id => adding ? !present.has(id) : present.has(id));
  if (!changed.length) return changed;
  const written = adding ? await tx.taskWatcher.createMany({ data: changed.map(userId => ({ id: randomUUID(), taskId, userId })), skipDuplicates: true })
    : await tx.taskWatcher.deleteMany({ where: { taskId, userId: { in: changed } } });
  if (written.count !== changed.length) throw new TaskCommandError("STALE_TASK_VERSION");
  if (task.request !== null) {
    if (!Number.isSafeInteger(lockedTask.version) || lockedTask.version < 0 || lockedTask.version >= 2147483647) throw new TaskCommandError("VERSION_EXHAUSTED");
    const updated = await tx.task.updateMany({ where: { id: taskId, projectId, version: lockedTask.version }, data: { version: { increment: 1 } } });
    if (updated.count !== 1) throw new TaskCommandError("STALE_TASK_VERSION");
  }
  for (const userId of changed) await logActivityWithClient(tx, { taskId, userId: actorId, action: adding ? "watcher_added" : "watcher_removed",
    ...(adding ? { newValue: { userId, count: 1 } } : { oldValue: { userId, count: 1 } }) });
  return changed;
}

async function mutate(request: Request, context: { params: Promise<{ id: string }> }, adding: boolean) {
  let json: unknown; try { json = await request.json(); } catch { return noStore(apiInvalidJson()); }
  const parsed = (adding ? z.union([singleBody, bulkAddBody]) : z.union([singleBody, removeBody])).safeParse(json);
  if (!parsed.success) return noStore(apiValidationError(parsed.error));
  try {
    const actor = await requireApiUser(request); const { id: taskId } = await context.params;
    const task = await readable(prisma, actor, taskId); if (!task) throw new NotFoundError();
    const single = "userId" in parsed.data ? parsed.data.userId : null;
    const selection = { userIds: single ? [single] : "userIds" in parsed.data ? parsed.data.userIds : [],
      groupIds: "groupIds" in parsed.data ? parsed.data.groupIds as string[] : [] };
    const changed = await prisma.$transaction(tx => mutateWatchers(tx, actor.id, taskId, task.projectId, selection, adding));
    // Reuse the existing safe task projection and visibility-aware delivery.
    if (changed.length) { try { const current = await loadTaskWithRelations(taskId); if (current) emitTaskUpdated(task.projectId, current); } catch { /* Commit is authoritative. */ } }
    return noStore(apiSuccess(single ? { userId: single, ...(adding ? { added: changed.length > 0 } : { removed: changed.length > 0 }) }
      : { userIds: changed, ...(adding ? { added: changed.length } : { removed: changed.length }) }, undefined, adding && changed.length ? 201 : 200));
  } catch (error) { return noStore(failure(error, adding ? "Не удалось добавить наблюдателей" : "Не удалось убрать наблюдателя")); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return mutate(request, context, true); }
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return mutate(request, context, false); }
