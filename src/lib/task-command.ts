import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { logActivityWithClient } from "./activity-logger";
import { NotFoundError } from "./errors";
import { getProjectAccess } from "./project-access";
import { taskDetailsCommandSchema, type TaskDetailsCommand } from "./validators";
import { readTaskRequestDecision, readTaskRequestBatchDecision } from "./task-request-guard";
import type { TaskRequestLifecycleDenial } from "./task-request-marker-lifecycle";
import { lockProjectStatusAuthority } from "./project-status-policy";
import { requireTaskDeadlineExecutor } from "./task-field-policy";

export interface TaskCommandAck {
  taskId: string;
  projectId: string;
  version: number;
  changed: boolean;
  replayed: boolean;
}
export interface TaskCommandEffects {
  priority?: { oldValue: string; newValue: string };
  deadlineSet?: string;
}
export interface TaskDetailsCommandResult {
  ack: TaskCommandAck;
  effects: TaskCommandEffects | null;
}
export type TaskCommandErrorCode = "INVALID_COMMAND" | "IDENTITY_CHANGED" | "OPERATION_ID_REUSED"
  | "INVALID_RECEIPT" | "STALE_TASK_VERSION" | "VERSION_EXHAUSTED"
  | "REQUEST_LIFECYCLE_NOT_ENABLED" | "INVALID_REQUEST_MARKER"
  | TaskRequestLifecycleDenial;
export class TaskCommandError extends Error {
  constructor(readonly code: TaskCommandErrorCode) {
    super(code);
    this.name = "TaskCommandError";
  }
}

export interface LegacyTaskScalarBatchRow {
  id: string;
  projectId: string;
  priority: string;
  version: number;
}

/** Caller owns the transaction; every target is authorized and guarded before writes. */
export async function prepareLegacyTaskScalarBatch({ tx, actorId, expectedTasks, requireOwnerOrMember, requireAssignmentAuthority }: {
  tx: Prisma.TransactionClient;
  actorId: string;
  expectedTasks: readonly { id: string; projectId: string }[];
  requireOwnerOrMember?: true;
  requireAssignmentAuthority?: true;
}): Promise<LegacyTaskScalarBatchRow[]> {
  const identities = new Map<string, string>();
  for (const task of expectedTasks) {
    const { id, projectId } = task;
    if (typeof id !== "string" || typeof projectId !== "string"
      || (identities.has(id) && identities.get(id) !== projectId)) {
      throw new Error("Invalid task batch identity");
    }
    identities.set(id, projectId);
  }
  const taskIds = [...identities.keys()].sort();
  const projectIds = [...new Set(identities.values())].sort();
  if (taskIds.length === 0) return [];

  const values = (row: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Reflect.ownKeys(row).length !== keys.length) throw new Error("Invalid locked task batch");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("Invalid locked task batch");
      result[key] = descriptor.value;
    }
    return result;
  };
  const projects = await tx.$queryRaw<unknown>`
    SELECT "id" FROM "Project" WHERE "id" IN (${Prisma.join(projectIds)}) ORDER BY "id" FOR UPDATE
  `;
  if (!Array.isArray(projects)) throw new Error("Invalid locked project batch");
  const seenProjects = new Set<string>();
  for (const row of projects) {
    const { id } = values(row, ["id"]);
    if (typeof id !== "string" || !projectIds.includes(id) || seenProjects.has(id)) {
      throw new Error("Invalid locked project batch");
    }
    seenProjects.add(id);
  }
  if (seenProjects.size !== projectIds.length) throw new NotFoundError();
  const lockedTasks = await tx.$queryRaw<unknown>`
    SELECT "id", "projectId", "priority", "version" FROM "Task"
    WHERE "id" IN (${Prisma.join(taskIds)}) ORDER BY "id" FOR UPDATE
  `;
  if (!Array.isArray(lockedTasks)) throw new Error("Invalid locked task batch");
  const seenTasks = new Set<string>();
  const rows: LegacyTaskScalarBatchRow[] = [];
  for (const row of lockedTasks) {
    const { id, projectId, priority, version } = values(row, ["id", "projectId", "priority", "version"]);
    if (typeof id !== "string" || !identities.has(id) || seenTasks.has(id)
      || typeof projectId !== "string" || typeof priority !== "string"
      || typeof version !== "number" || !Number.isInteger(version)
      || version < -2147483648 || version > 2147483647) throw new Error("Invalid locked task batch");
    if (projectId !== identities.get(id)) throw new TaskCommandError("IDENTITY_CHANGED");
    seenTasks.add(id);
    rows.push({ id, projectId, priority, version });
  }
  if (seenTasks.size !== taskIds.length) throw new NotFoundError();
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true } });
  if (!actor) throw new NotFoundError();
  for (const projectId of projectIds) {
    const access = await getProjectAccess(actor, projectId, tx);
    if (!access.canWrite) throw new NotFoundError();
    if (requireAssignmentAuthority && actor.globalRole !== "ADMIN" && !access.canManageMembers
      && !(await lockProjectStatusAuthority(tx, actorId, projectId))) throw new NotFoundError();
    if (requireOwnerOrMember && actor.globalRole === "ADMIN") {
      // Some legacy endpoints restrict even ADMIN to explicit project membership.
      // This extra server-only restriction never grants rights to other callers.
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: {
          ownerId: true,
          members: { where: { userId: actor.id }, select: { userId: true }, take: 1 },
        },
      });
      if (!project || (project.ownerId !== actor.id && project.members.length === 0)) throw new NotFoundError();
    }
  }
  const decision = await readTaskRequestBatchDecision(tx, taskIds);
  if (!decision.allowed) throw new TaskCommandError(decision.code);
  return rows;
}

const maxVersion = 2147483647;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const fields = ["title", "description", "priority", "deadline"] as const;
function normalize(input: TaskDetailsCommand & { actorId: string; taskId: string }) {
  try {
    const actorId = input.actorId, taskId = input.taskId;
    if (typeof actorId !== "string" || typeof taskId !== "string" || !idPattern.test(actorId) || !idPattern.test(taskId)) throw new Error();
    const parsed = taskDetailsCommandSchema.parse({ operationId: input.operationId,
      expectedVersion: input.expectedVersion, changes: input.changes });
    const changes: TaskDetailsCommand["changes"] = {};
    if (parsed.changes.title !== undefined) changes.title = parsed.changes.title;
    if (parsed.changes.description !== undefined) changes.description = parsed.changes.description;
    if (parsed.changes.priority !== undefined) changes.priority = parsed.changes.priority;
    if (parsed.changes.deadline !== undefined) {
      changes.deadline = parsed.changes.deadline === null ? null : new Date(parsed.changes.deadline).toISOString();
    }
    if (Object.keys(changes).length === 0) throw new Error();
    const command = { actorId, taskId, operationId: parsed.operationId.toLowerCase(),
      expectedVersion: parsed.expectedVersion, changes };
    const fingerprint = fields.filter(field => changes[field] !== undefined).sort().map(field => [field, changes[field]]);
    return { ...command, requestHash: createHash("sha256")
      .update(JSON.stringify(["details.save.v1", command.taskId, fingerprint, command.expectedVersion])).digest("hex") };
  } catch { throw new TaskCommandError("INVALID_COMMAND"); }
}

/** Same task, authorization and Activity; this is not a new lifecycle or rank engine. */
export function createTaskCommandService(database: Pick<PrismaClient, "$transaction">) {
  return {
    saveDetails(raw: TaskDetailsCommand & { actorId: string; taskId: string }): Promise<TaskDetailsCommandResult> {
      const command = normalize(raw);
      return database.$transaction(async tx => {
        const operationKey = JSON.stringify(["task-details-v1", command.actorId, command.operationId]);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))::text AS locked`;
        const identity = await tx.task.findUnique({ where: { id: command.taskId },
          select: { id: true, projectId: true, columnId: true } });
        if (!identity) throw new NotFoundError();
        const projects = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Project" WHERE "id" = ${identity.projectId} FOR UPDATE
        `;
        if (projects.length === 0) throw new NotFoundError();
        const columns = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "ProjectColumn" WHERE "id" = ${identity.columnId} AND "projectId" = ${identity.projectId} FOR UPDATE
        `;
        if (columns.length === 0) throw new TaskCommandError("IDENTITY_CHANGED");
        const tasks = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Task" WHERE "id" = ${command.taskId} FOR UPDATE
        `;
        if (tasks.length === 0) throw new NotFoundError();
        const task = await tx.task.findUnique({ where: { id: command.taskId }, select: {
          id: true, projectId: true, columnId: true, version: true, title: true, description: true, priority: true, deadline: true,
        } });
        if (!task) throw new NotFoundError();
        if (task.projectId !== identity.projectId || task.columnId !== identity.columnId) throw new TaskCommandError("IDENTITY_CHANGED");
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${command.actorId} FOR SHARE`;
        const actor = await tx.user.findUnique({ where: { id: command.actorId }, select: { id: true, globalRole: true } });
        if (!actor) throw new NotFoundError();
        if (!(await getProjectAccess(actor, task.projectId, tx)).canWrite) throw new NotFoundError();
        const requestDecision = await readTaskRequestDecision(tx, task.id);
        if (!requestDecision.allowed) throw new TaskCommandError(requestDecision.code);

        if (command.changes.deadline !== undefined) {
          await requireTaskDeadlineExecutor(tx, command.actorId, task.id);
        }

        const receipt = await tx.taskCommandOperation.findUnique({ where: {
          actorId_operationId: { actorId: command.actorId, operationId: command.operationId },
        } });
        if (receipt) {
          if (receipt.requestHash !== command.requestHash) throw new TaskCommandError("OPERATION_ID_REUSED");
          if (receipt.actorId !== command.actorId || receipt.operationId !== command.operationId
            || receipt.taskId !== command.taskId || receipt.projectId !== task.projectId
            || receipt.expectedVersion !== command.expectedVersion || typeof receipt.changed !== "boolean"
            || !Number.isInteger(receipt.committedVersion) || receipt.committedVersion < 0 || receipt.committedVersion > maxVersion
            || receipt.committedVersion !== command.expectedVersion + (receipt.changed ? 1 : 0)) {
            throw new TaskCommandError("INVALID_RECEIPT");
          }
          return { ack: { taskId: task.id, projectId: task.projectId, version: receipt.committedVersion,
            changed: receipt.changed, replayed: true }, effects: null };
        }
        if (task.version !== command.expectedVersion) throw new TaskCommandError("STALE_TASK_VERSION");
        const old = { title: task.title, description: task.description, priority: task.priority,
          deadline: task.deadline?.toISOString() ?? null };
        const changedFields = fields.filter(field => command.changes[field] !== undefined && command.changes[field] !== old[field]);
        const changed = changedFields.length > 0;
        if (changed && task.version === maxVersion) throw new TaskCommandError("VERSION_EXHAUSTED");
        const version = task.version + (changed ? 1 : 0);
        const effects: TaskCommandEffects = {};
        if (changed) {
          const data: Prisma.TaskUpdateManyMutationInput = { version: { increment: 1 } };
          if (command.changes.title !== undefined) data.title = command.changes.title;
          if (command.changes.description !== undefined) data.description = command.changes.description;
          if (command.changes.priority !== undefined) data.priority = command.changes.priority;
          if (command.changes.deadline !== undefined) data.deadline = command.changes.deadline === null ? null : new Date(command.changes.deadline);
          const updated = await tx.task.updateMany({ where: { id: task.id, projectId: task.projectId,
            columnId: task.columnId, version: command.expectedVersion }, data });
          if (updated.count !== 1) throw new TaskCommandError("STALE_TASK_VERSION");
          for (const field of changedFields) {
            const newValue = command.changes[field];
            const action = field === "deadline"
              ? newValue === null ? "deadline_removed" : old.deadline === null ? "deadline_set" : "deadline_changed"
              : `${field}_changed`;
            await logActivityWithClient(tx, { taskId: task.id, userId: command.actorId, action,
              oldValue: { [field]: old[field] }, newValue: { [field]: newValue } });
          }
          if (changedFields.includes("priority") && command.changes.priority !== undefined) {
            effects.priority = { oldValue: old.priority, newValue: command.changes.priority };
          }
          if (changedFields.includes("deadline") && old.deadline === null && command.changes.deadline) {
            effects.deadlineSet = command.changes.deadline;
          }
        }
        await tx.taskCommandOperation.create({ data: { actorId: command.actorId, operationId: command.operationId,
          taskId: task.id, projectId: task.projectId, requestHash: command.requestHash,
          expectedVersion: command.expectedVersion, committedVersion: version, changed } });
        return { ack: { taskId: task.id, projectId: task.projectId, version, changed, replayed: false },
          effects: changed ? effects : null };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    },
  };
}
