import { Prisma, type PrismaClient } from "@prisma/client";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { getTaskReadWhere } from "./project-access";
import { canExecuteRequest, getProjectRequestExecutionPolicy, getRequestExecutionProjectIds,
  getProjectRequestExecutorIds } from "./project-request-execution-policy";
import { hasRolePermission, loadRoleGrants, type RoleGrantDatabase } from "./role-grants";
import { isTaskAudienceRecipient } from "./task-audience";
import { decodeStoredTaskRequest } from "./task-request-marker-lifecycle";

export type RequestQueueArrival = { epoch: number; unseen: boolean };
export type RequestQueueReadDatabase = Pick<Prisma.TransactionClient, "user" | "project" | "task" | "scopedPrivilegeAssignment"> & RoleGrantDatabase;
type Actor = { id: string; globalRole: "USER" | "ADMIN"; primaryDepartmentId: string | null };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_EPOCH = 2147483647;
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

async function readActor(database: RequestQueueReadDatabase, actorId: string): Promise<Actor> {
  if (!validId(actorId)) throw new BadRequestError("Invalid actor");
  const actor = await database.user.findUnique({ where: { id: actorId }, select: {
    id: true, globalRole: true, isBlocked: true, blockedAt: true, primaryDepartmentId: true,
  } });
  if (!actor || actor.isBlocked !== false || actor.blockedAt !== null) throw new NotFoundError();
  return actor;
}

async function unseenWhere(database: RequestQueueReadDatabase, actor: Actor,
  filters: Prisma.TaskWhereInput, projects?: readonly string[]): Promise<Prisma.TaskWhereInput> {
  const eligible = await getRequestExecutionProjectIds(actor.id, projects, database);
  return { AND: [
    await getTaskReadWhere(actor, filters, database),
    { projectId: { in: eligible } },
    { request: { is: {
      contractVersion: 1, state: "SUBMITTED", executorId: null, deletedAt: null,
      queueEpoch: { gt: 0 }, queueSeen: { none: { userId: actor.id } },
      OR: [{ audienceUserIds: { isEmpty: true } }, { audienceUserIds: { has: actor.id } }],
    } } },
  ] };
}

/**
 * Recipients of STRICT opaque cache invalidation only, never a read grant.
 * Fresh department/group executors already satisfy the canonical submitted
 * staff branch of the shared read policy. Audience remains an additional cap.
 * No task ID, project ID, count, epoch or snapshot may be delivered using this
 * helper. Details/counts/seen writes keep their full common actor ACL checks.
 */
export async function readRequestQueueRecipientIds(database: RequestQueueReadDatabase,
  taskId: string, projectId: string): Promise<string[]> {
  if (!validId(taskId) || !validId(projectId)) throw new BadRequestError("Invalid request identity");
  const task = await database.task.findFirst({ where: { id: taskId, projectId,
    request: { is: { contractVersion: 1, state: { not: "DRAFT" }, deletedAt: null } },
  }, select: { request: { select: { authorId: true, audienceUserIds: true } } } });
  if (!task?.request) return [];
  const candidates = [...new Set(await getProjectRequestExecutorIds(projectId, database))];
  return candidates.filter(actorId => isTaskAudienceRecipient(task.request, actorId));
}

/** A narrowing predicate for rows/counts BEFORE urgency paging or limits. */
export async function readRequestQueueUnseenWhere(database: RequestQueueReadDatabase, actorId: string,
  filters: Prisma.TaskWhereInput = {}): Promise<Prisma.TaskWhereInput> {
  return unseenWhere(database, await readActor(database, actorId), filters);
}

export async function readRequestQueueUnseenCounts(database: RequestQueueReadDatabase, actorId: string,
  filters: Prisma.TaskWhereInput = {}): Promise<{ byProject: Record<string, number>; total: number }> {
  const where = await readRequestQueueUnseenWhere(database, actorId, filters);
  const rows = await database.task.groupBy({ by: ["projectId"], where, _count: { _all: true } });
  const byProject: Record<string, number> = Object.create(null);
  let total = 0;
  for (const row of rows) {
    byProject[row.projectId] = row._count._all;
    total += row._count._all;
  }
  return { byProject, total };
}

/** Unauthorized IDs are omitted; absence must never fall back to a raw DTO. */
export async function readRequestQueueArrivalMap(database: RequestQueueReadDatabase, actorId: string,
  taskIds: readonly string[]): Promise<Map<string, RequestQueueArrival | null>> {
  if (taskIds.length > 1000 || taskIds.some(id => !validId(id))) throw new BadRequestError("Invalid task IDs");
  const result = new Map<string, RequestQueueArrival | null>();
  if (taskIds.length === 0) return result;
  const actor = await readActor(database, actorId);
  const filters = { id: { in: [...new Set(taskIds)] } };
  const rows = await database.task.findMany({ where: await getTaskReadWhere(actor, filters, database),
    select: { id: true, projectId: true, request: { select: { queueEpoch: true } } } });
  if (rows.length === 0) return result;
  const unseen = new Set((await database.task.findMany({
    where: await unseenWhere(database, actor, filters, rows.map(row => row.projectId)), select: { id: true },
  })).map(row => row.id));
  for (const row of rows) result.set(row.id, row.request === null ? null : {
    epoch: row.request.queueEpoch, unseen: unseen.has(row.id),
  });
  return result;
}

/** Caller holds the canonical Project/Task/marker locks and has passed its CAS. */
export async function recordRequestQueueArrival(database: Pick<Prisma.TransactionClient, "taskRequest" | "taskRequestQueueSeen">,
  input: { taskId: string; actorId: string }): Promise<void> {
  const updated = await database.taskRequest.updateMany({ where: {
    taskId: input.taskId, contractVersion: 1, state: "SUBMITTED", executorId: null,
    deletedAt: null, queueEpoch: { lt: MAX_EPOCH },
  }, data: { queueEpoch: { increment: 1 } } });
  if (updated.count !== 1) throw new ConflictError("Request queue epoch exhausted or changed");
  await database.taskRequestQueueSeen.deleteMany({ where: { taskId: input.taskId } });
  await database.taskRequestQueueSeen.createMany({
    data: [{ taskId: input.taskId, userId: input.actorId }], skipDuplicates: true,
  });
}

/** A view is a read receipt, not permission to edit the task or its messages. */
export async function markRequestQueueSeen(database: Pick<PrismaClient, "$transaction">,
  input: { actorId: string; expectedActorId: string; taskId: string; queueEpoch: number }): Promise<{ changed: boolean; stale: boolean }> {
  if (![input.actorId, input.expectedActorId, input.taskId].every(validId)
    || !Number.isInteger(input.queueEpoch) || input.queueEpoch < 1 || input.queueEpoch > MAX_EPOCH) {
    throw new BadRequestError("Invalid queue view");
  }
  if (input.actorId !== input.expectedActorId) throw new ForbiddenError("Account changed");
  return database.$transaction(async tx => {
    const identity = await tx.task.findUnique({ where: { id: input.taskId }, select: { projectId: true } });
    if (!identity) throw new NotFoundError();
    const projects = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Project" WHERE "id" = ${identity.projectId} FOR UPDATE`;
    if (projects.length !== 1) throw new NotFoundError();
    const tasks = await tx.$queryRaw<{ id: string; projectId: string }[]>`SELECT "id", "projectId" FROM "Task" WHERE "id" = ${input.taskId} FOR UPDATE`;
    if (tasks.length !== 1 || tasks[0].projectId !== identity.projectId) throw new NotFoundError();
    const project = await tx.project.findUnique({ where: { id: identity.projectId }, select: {
      responsibleGroupId: true, departmentId: true,
    } });
    if (!project) throw new NotFoundError();
    // Same authority order as canonical lifecycle: group/member, watcher,
    // department, user, role grants. A missing membership never becomes a grant.
    let isGroupMember = false;
    if (project.responsibleGroupId) {
      const groups = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`SELECT "id", "archivedAt" FROM "ResponsibleGroup" WHERE "id" = ${project.responsibleGroupId} FOR SHARE`;
      if (groups.length === 1) {
        const members = await tx.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "ResponsibleGroupMember" WHERE "groupId" = ${project.responsibleGroupId} AND "userId" = ${input.actorId} FOR SHARE`;
        isGroupMember = groups[0].archivedAt === null && members.some(row => row.userId === input.actorId);
      }
    }
    await tx.$queryRaw`SELECT "userId" FROM "TaskWatcher" WHERE "taskId" = ${input.taskId} AND "userId" = ${input.actorId} FOR SHARE`;
    let department: { id: string; archivedAt: Date | null } | null = null;
    if (project.departmentId) {
      const departments = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`SELECT "id", "archivedAt" FROM "Department" WHERE "id" = ${project.departmentId} FOR SHARE`;
      if (departments.length !== 1) throw new NotFoundError();
      department = departments[0];
    }
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.actorId} FOR SHARE`;
    const actor = await readActor(tx, input.actorId);
    const grants = await loadRoleGrants(tx, [actor.id], { lock: true });
    const readable = await tx.task.findFirst({ where: await getTaskReadWhere(actor,
      { id: input.taskId, projectId: identity.projectId }, tx, { projectId: identity.projectId, roleGrants: grants }),
      select: { id: true, request: { select: {
        taskId: true, contractVersion: true, state: true, authorId: true, executorId: true,
        needsInfoSince: true, pausedTotalMs: true, deletedAt: true, audienceUserIds: true, queueEpoch: true,
      } } } });
    if (!readable || readable.request?.deletedAt != null) throw new NotFoundError();
    if (!readable.request) return { changed: false, stale: true };
    const { deletedAt, audienceUserIds, queueEpoch, ...marker } = readable.request;
    void deletedAt;
    if (!decodeStoredTaskRequest(marker, input.taskId).valid) throw new NotFoundError();
    if (!isTaskAudienceRecipient({ authorId: marker.authorId, audienceUserIds }, actor.id)
      || !canExecuteRequest({ hasDepartment: project.departmentId !== null,
        isDepartmentStaff: department?.archivedAt === null && actor.primaryDepartmentId === department.id,
        isGroupMember, hasExecutionPermission: hasRolePermission(grants, actor.id, "request.execute", {
          projectId: identity.projectId, activeDepartmentId: department?.archivedAt === null ? department.id : null,
        }),
      }) || !(await getProjectRequestExecutionPolicy(actor.id, identity.projectId, tx)).canExecute) throw new NotFoundError();
    if (queueEpoch !== input.queueEpoch || marker.state !== "SUBMITTED" || marker.executorId !== null) {
      return { changed: false, stale: true };
    }
    const inserted = await tx.taskRequestQueueSeen.createMany({
      data: [{ taskId: input.taskId, userId: actor.id }], skipDuplicates: true,
    });
    return { changed: inserted.count === 1, stale: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
