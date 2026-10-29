import { loadRoleGrants } from "./role-grants";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getTaskReadWhere } from "@/lib/project-access";
import { matchesScopedPrivilegeScope } from "@/lib/access-policy";
import { relatedEndpointAvailability, relatedMarkerSelect } from "@/lib/task-related-access";
import { logActivityWithClient } from "@/lib/activity-logger";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { TaskCommandError } from "@/lib/task-command";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const relatedRequestCommandSchema = z.object({ operationId: z.string().uuid().transform(value => value.toLowerCase()),
  expectedVersion: z.number().int().min(0).max(2147483646), relatedTaskId: id }).strict();
type Actor = { id: string; globalRole: "USER" | "ADMIN" };
type Db = Prisma.TransactionClient;
const selection = { id: true, title: true, projectId: true, version: true, status: true, createdById: true,
  request: { select: relatedMarkerSelect },
  assignees: { select: { userId: true }, take: 2 },
  project: { select: { name: true, department: { select: { id: true, archivedAt: true, leaderId: true } }, responsibleGroup: { select: {
    id: true, archivedAt: true, leaderId: true, members: { select: { userId: true } },
  } } } } } as const;
type Task = Prisma.TaskGetPayload<{ select: typeof selection }>;
const cardSelection = { id: true, title: true, projectId: true, status: true,
  request: { select: relatedMarkerSelect }, project: { select: { name: true } } } as const;
type Card = Prisma.TaskGetPayload<{ select: typeof cardSelection }>;
export type RelatedRequestProjection = { taskId: string; version: number; canManage: boolean; items: {
  id: string; title: string; projectId: string; projectName: string; state: string; isDirect: boolean; url: string;
}[]; limited: boolean };
const MAX_NODES = 100, MAX_EDGES = 500;

async function freshActor(tx: Db, actorId: string, lock = true): Promise<Actor> {
  if (lock) await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true, isBlocked: true, blockedAt: true } });
  if (!actor || actor.isBlocked !== false || actor.blockedAt !== null) throw new NotFoundError();
  return actor;
}
async function readable(tx: Db, actor: Actor, taskId: string) {
  const task = await tx.task.findFirst({ where: await getTaskReadWhere(actor, { id: taskId }, tx), select: selection });
  if (!task) throw new NotFoundError();
  const availability = relatedEndpointAvailability(task);
  if (!availability.available) throw availability.reason === "deleted"
    ? new NotFoundError() : new TaskCommandError("INVALID_REQUEST_MARKER");
  return task;
}
async function canManage(tx: Db, actor: Actor, task: Task): Promise<boolean> {
  if (task.request?.state === "DRAFT") return false;
  if (actor.globalRole === "ADMIN") return true;
  const authorId = task.request?.authorId ?? task.createdById;
  const executorId = task.request ? task.request.executorId : task.assignees.length === 1 ? task.assignees[0].userId : null;
  if (authorId === actor.id || executorId === actor.id) return true;
  const { department, responsibleGroup: group } = task.project;
  // Department leadership is canonical submitted read only. An active
  // responsible group of the board keeps its canonical management fact.
  if (group?.archivedAt === null && group.leaderId === actor.id && group.members.some(member => member.userId === actor.id)) return true;
  const grants = await loadRoleGrants(tx, [actor.id], { lock: true });
  return grants.some(grant => grant.visibility === "board" && grant.permissions.includes("request.update")
    && matchesScopedPrivilegeScope({ projectId: task.projectId, activeDepartmentId: department?.archivedAt === null ? department.id : null }, grant));
}

/** Traverse the reader-visible induced graph. Hidden vertices never enter the
 * frontier, the result, or the limit calculation. No full-graph totals exist. */
async function project(tx: Db, actor: Actor, source: Task): Promise<RelatedRequestProjection> {
  const readWhere: Prisma.TaskWhereInput = { AND: [await getTaskReadWhere(actor, {}, tx),
    { OR: [{ request: { is: null } }, { request: { is: { contractVersion: 1, deletedAt: null } } }] }] };
  const seen = new Map<string, { task: Card; direct: boolean }>([[source.id, { task: source, direct: true }]]);
  let frontier = [source.id], visitedEdges = 0, limited = false;
  while (frontier.length) {
    const edges = await tx.taskRelation.findMany({ where: { AND: [
      { OR: [{ leftTaskId: { in: frontier } }, { rightTaskId: { in: frontier } }] },
      { leftTask: { is: readWhere } }, { rightTask: { is: readWhere } },
    ] }, orderBy: [{ leftTaskId: "asc" }, { rightTaskId: "asc" }], take: MAX_EDGES - visitedEdges + 1,
    select: { leftTaskId: true, rightTaskId: true, leftTask: { select: cardSelection }, rightTask: { select: cardSelection } } });
    if (edges.length > MAX_EDGES - visitedEdges) { limited = true; edges.length = MAX_EDGES - visitedEdges; }
    visitedEdges += edges.length;
    const next: string[] = [];
    for (const edge of edges) {
      // A corrupt or deleted neighbor may neither become a node nor bridge the
      // component: drop the whole edge before either endpoint enters `seen`.
      if ([edge.leftTask, edge.rightTask].some(task => !relatedEndpointAvailability(task).available)) continue;
      for (const task of [edge.leftTask, edge.rightTask]) {
        const direct = edge.leftTaskId === source.id || edge.rightTaskId === source.id;
        if (seen.has(task.id)) { if (direct) seen.get(task.id)!.direct = true; continue; }
        if (seen.size >= MAX_NODES) { limited = true; continue; }
        seen.set(task.id, { task, direct }); next.push(task.id);
      }
    }
    if (limited || visitedEdges >= MAX_EDGES) { limited = limited || next.length > 0; break; }
    frontier = next;
  }
  return { taskId: source.id, version: source.version, canManage: await canManage(tx, actor, source), limited,
    items: [...seen.values()].filter(row => row.task.id !== source.id).map(({ task, direct }) => ({ id: task.id, title: task.title,
      projectId: task.projectId, projectName: task.project.name, state: task.request?.state ?? task.status, isDirect: direct,
      url: `/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}`,
    })).sort((a, b) => Number(b.isDirect) - Number(a.isDirect) || a.id.localeCompare(b.id)) };
}
export async function readRelatedRequests(database: Pick<PrismaClient, "$transaction">, actorId: string, taskId: string) {
  if (!id.safeParse(actorId).success || !id.safeParse(taskId).success) throw new NotFoundError();
  return database.$transaction(async tx => {
    const actor = await freshActor(tx, actorId);
    return project(tx, actor, await readable(tx, actor, taskId));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Project→Task locks use a stable order for both endpoints. The graph mutex
 * serializes edge commands; existing task writers retain their own CAS locks. */
export async function changeRelatedRequests(database: Pick<PrismaClient, "$transaction">, input: {
  actorId: string; taskId: string; action: "add" | "remove";
} & z.input<typeof relatedRequestCommandSchema>) {
  const parsed = relatedRequestCommandSchema.safeParse({ operationId: input.operationId, expectedVersion: input.expectedVersion, relatedTaskId: input.relatedTaskId });
  if (!parsed.success || !id.safeParse(input.actorId).success || !id.safeParse(input.taskId).success || !["add", "remove"].includes(input.action)
    || input.taskId === input.relatedTaskId) throw new TaskCommandError("INVALID_COMMAND");
  const command = { ...input, ...parsed.data };
  const hash = createHash("sha256").update(JSON.stringify(["task-relation-v1", command.actorId, command.taskId, command.action, command.relatedTaskId, command.expectedVersion])).digest("hex");
  return database.$transaction(async tx => {
    // Preflight source read + management with fresh actor facts before any
    // target identity/read/lock lookup. A nonmanager then gets the same 403
    // for a guessed missing target and an existing readable target.
    const preflightActor = await freshActor(tx, command.actorId, false);
    const preflightSource = await readable(tx, preflightActor, command.taskId);
    if (!await canManage(tx, preflightActor, preflightSource)) throw new ForbiddenError();
    const key = JSON.stringify(["task-request-lifecycle-v1", command.actorId, command.operationId]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS locked`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('task-relations-v1', 0))::text AS locked`;
    const ids = [command.taskId, command.relatedTaskId].sort();
    const identities = await tx.task.findMany({ where: { id: { in: ids } }, select: { id: true, projectId: true } });
    if (identities.length !== 2) throw new NotFoundError();
    const projects = [...new Set(identities.map(task => task.projectId))].sort();
    const lockedProjects = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Project" WHERE "id" IN (${Prisma.join(projects)}) ORDER BY "id" FOR UPDATE`;
    const lockedTasks = await tx.$queryRaw<{ id: string; projectId: string }[]>`SELECT "id", "projectId" FROM "Task" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
    if (lockedProjects.length !== projects.length || lockedTasks.length !== 2 || identities.some(task => !lockedTasks.some(locked => locked.id === task.id && locked.projectId === task.projectId))) throw new TaskCommandError("IDENTITY_CHANGED");
    // Stabilize the shared ACL grants before evaluating the common read filter.
    await tx.$queryRaw`SELECT d."id" FROM "Department" d JOIN "Project" p ON p."departmentId" = d."id" WHERE p."id" IN (${Prisma.join(projects)}) ORDER BY d."id" FOR SHARE OF d`;
    await tx.$queryRaw`SELECT g."id" FROM "ResponsibleGroup" g JOIN "Project" p ON p."responsibleGroupId" = g."id" WHERE p."id" IN (${Prisma.join(projects)}) ORDER BY g."id" FOR SHARE OF g`;
    await tx.$queryRaw`SELECT "userId" FROM "ResponsibleGroupMember" WHERE "userId" = ${command.actorId} ORDER BY "groupId" FOR SHARE`;
    await tx.$queryRaw`SELECT "userId" FROM "TaskWatcher" WHERE "taskId" IN (${Prisma.join(ids)}) AND "userId" = ${command.actorId} ORDER BY "taskId" FOR SHARE`;
    await tx.$queryRaw`SELECT a."id" FROM "ScopedPrivilegeAssignment" a JOIN "PrivilegeProfile" p ON p."id" = a."profileId" WHERE a."userId" = ${command.actorId} ORDER BY a."id" FOR SHARE OF a, p`;
    const actor = await freshActor(tx, command.actorId);
    const source = await readable(tx, actor, command.taskId);
    if (!await canManage(tx, actor, source)) throw new ForbiddenError();
    const target = await readable(tx, actor, command.relatedTaskId);
    const receipt = await tx.taskCommandOperation.findUnique({ where: { actorId_operationId: { actorId: command.actorId, operationId: command.operationId } } });
    if (receipt) {
      if (receipt.requestHash !== hash) throw new TaskCommandError("OPERATION_ID_REUSED");
      if (receipt.actorId !== command.actorId || receipt.operationId !== command.operationId || receipt.taskId !== source.id || receipt.projectId !== source.projectId || receipt.expectedVersion !== command.expectedVersion
        || typeof receipt.changed !== "boolean" || !Number.isInteger(receipt.committedVersion) || receipt.committedVersion > 2147483647
        || receipt.committedVersion !== command.expectedVersion + Number(receipt.changed)) throw new TaskCommandError("INVALID_RECEIPT");
      return { projection: await project(tx, actor, source), changed: false, affected: [] };
    }
    if (source.version !== command.expectedVersion) throw new TaskCommandError("STALE_TASK_VERSION");
    const [leftTaskId, rightTaskId] = ids;
    const edgeWhere = { leftTaskId_rightTaskId: { leftTaskId, rightTaskId } };
    const exists = await tx.taskRelation.findUnique({ where: edgeWhere, select: { leftTaskId: true } });
    const changed = command.action === "add" ? !exists : Boolean(exists);
    if (changed) {
      if ([source, target].some(task => task.version >= 2147483647)) throw new TaskCommandError("VERSION_EXHAUSTED");
      if (command.action === "add") await tx.taskRelation.create({ data: { leftTaskId, rightTaskId, createdById: actor.id } });
      else await tx.taskRelation.delete({ where: edgeWhere });
      for (const [task, other] of [[source, target], [target, source]]) {
        const updated = await tx.task.updateMany({ where: { id: task.id, projectId: task.projectId, version: task.version }, data: { version: { increment: 1 } } });
        if (updated.count !== 1) throw new TaskCommandError("STALE_TASK_VERSION");
        await logActivityWithClient(tx, { taskId: task.id, userId: actor.id, action: command.action === "add" ? "related_request_added" : "related_request_removed",
          ...(command.action === "add" ? { newValue: { relatedTaskId: other.id } } : { oldValue: { relatedTaskId: other.id } }) });
      }
    }
    await tx.taskCommandOperation.create({ data: { actorId: actor.id, operationId: command.operationId, taskId: source.id, projectId: source.projectId,
      requestHash: hash, expectedVersion: command.expectedVersion, committedVersion: command.expectedVersion + Number(changed), changed } });
    return { projection: await project(tx, actor, { ...source, version: source.version + Number(changed) }), changed,
      affected: changed ? [source, target].map(task => ({ id: task.id, projectId: task.projectId })) : [] };
  });
}





