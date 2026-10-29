import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, TaskChecklistItem } from "@prisma/client";
import { logActivityWithClient } from "./activity-logger";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import type { RequestLogContext } from "./request-context";
import { validCorrelationId } from "./telemetry-sanitize";
import { getProjectAccess } from "./project-access";
import { readTaskRequestDecision } from "./task-request-guard";

export interface ChecklistItemUpdate {
  text?: string;
  completed?: boolean;
  position?: number;
}

export interface ChecklistUpdateResult {
  item: TaskChecklistItem;
  projectId: string;
  changed: boolean;
  replayed: boolean;
  receiptId?: string;
}

async function authorizeChecklistChildMutation(
  tx: Prisma.TransactionClient,
  actorId: string,
  taskId: string,
): Promise<string> {
  const identity = await tx.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!identity) throw new NotFoundError();
  const projects = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Project" WHERE "id" = ${identity.projectId} FOR UPDATE
  `;
  if (projects.length === 0) throw new NotFoundError();
  const tasks = await tx.$queryRaw<{ id: string; projectId: string }[]>`
    SELECT "id", "projectId" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  const task = tasks[0];
  if (!task) throw new NotFoundError();
  if (task.projectId !== identity.projectId) throw new ConflictError("Task identity changed");
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true } });
  if (!actor || !(await getProjectAccess(actor, task.projectId, tx)).canWrite) throw new NotFoundError();
  const decision = await readTaskRequestDecision(tx, taskId);
  if (!decision.allowed) throw new ConflictError(decision.code);
  return task.projectId;
}

export async function createChecklistItem({ database, actorId, taskId, text }: {
  database: Pick<PrismaClient, "$transaction">;
  actorId: string;
  taskId: string;
  text: string;
}): Promise<{ item: TaskChecklistItem; projectId: string }> {
  return database.$transaction(async tx => {
    const projectId = await authorizeChecklistChildMutation(tx, actorId, taskId);
    const lastItem = await tx.taskChecklistItem.findFirst({
      where: { taskId }, orderBy: { position: "desc" },
    });
    const item = await tx.taskChecklistItem.create({
      data: { taskId, text, position: lastItem ? lastItem.position + 1 : 0 },
    });
    await logActivityWithClient(tx, {
      taskId, userId: actorId, action: "checklist_item_added",
      newValue: { itemId: item.id, text: item.text, completed: item.completed },
    });
    return { item, projectId };
  });
}

export async function deleteChecklistItem({ database, actorId, taskId, itemId }: {
  database: Pick<PrismaClient, "$transaction">;
  actorId: string;
  taskId: string;
  itemId: string;
}): Promise<{ projectId: string }> {
  return database.$transaction(async tx => {
    const projectId = await authorizeChecklistChildMutation(tx, actorId, taskId);
    const item = await tx.taskChecklistItem.findFirst({ where: { id: itemId, taskId } });
    if (!item) throw new NotFoundError();
    await tx.taskChecklistItem.delete({ where: { id: itemId } });
    await logActivityWithClient(tx, {
      taskId, userId: actorId, action: "checklist_item_deleted",
      oldValue: { itemId: item.id, text: item.text, completed: item.completed },
    });
    return { projectId };
  });
}

/** Mutations and required business history commit together; no network side effects. */
export async function updateChecklistItem({
  database,
  actorId,
  taskId,
  itemId,
  update,
  operationId,
  context,
}: {
  database: Pick<PrismaClient, "$transaction">;
  actorId: string;
  taskId: string;
  itemId: string;
  update: ChecklistItemUpdate;
  operationId?: string;
  context?: Pick<RequestLogContext, "actionId" | "requestId" | "projectId">;
}): Promise<ChecklistUpdateResult> {
  if (operationId !== undefined && (!validCorrelationId(operationId)
    || typeof update.completed !== "boolean"
    || Object.keys(update).some(key => key !== "completed"))) {
    throw new BadRequestError("Invalid checklist operation");
  }
  const normalizedOperationId = operationId?.toLowerCase();

  return database.$transaction(async tx => {
    if (normalizedOperationId !== undefined) {
      // Serialize a key across every resource, before taking resource locks.
      // Casting the PostgreSQL void result avoids Prisma void deserialization.
      const lockKey = JSON.stringify(["checklist-toggle-v1", actorId, normalizedOperationId]);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS locked`;
    }

    const identity = await tx.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!identity) throw new NotFoundError();
    const projectId = identity.projectId;
    const projects = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE
    `;
    if (projects.length === 0) throw new NotFoundError();
    const tasks = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Task" WHERE "id" = ${taskId} AND "projectId" = ${projectId} FOR UPDATE
    `;
    if (tasks.length === 0) throw new NotFoundError();

    // Recheck current identity and the shared project policy after waiting for
    // resource locks; no cached pre-lock role or separate permission matrix.
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true } });
    if (!actor) throw new NotFoundError();
    const access = await getProjectAccess(actor, projectId, tx);
    if (!access.canWrite) throw new NotFoundError();
    const requestDecision = await readTaskRequestDecision(tx, taskId);
    if (!requestDecision.allowed) throw new ConflictError(requestDecision.code);
    if (context) context.projectId = projectId;

    const receipt = normalizedOperationId === undefined ? null : await tx.checklistOperationReceipt.findUnique({
      where: { actorId_operationId: { actorId, operationId: normalizedOperationId } },
    });
    if (receipt && (receipt.taskId !== taskId || receipt.itemId !== itemId
      || receipt.projectId !== projectId || receipt.completed !== update.completed)) {
      throw new ConflictError("Operation ID already belongs to a different checklist command");
    }

    const item = await tx.taskChecklistItem.findFirst({ where: { id: itemId, taskId } });
    if (!item) throw new NotFoundError();
    if (receipt) {
      // Return current state. A replay must never undo a later completed toggle.
      return { item, projectId, changed: false, replayed: true, receiptId: receipt.id };
    }

    const changed = (update.completed !== undefined && update.completed !== item.completed)
      || (update.text !== undefined && update.text !== item.text)
      || (update.position !== undefined && update.position !== item.position);
    // Preserve the legacy update DTO/updatedAt behavior; instrumented no-ops do
    // not mutate the item and produce only their durable idempotency receipt.
    const result = normalizedOperationId !== undefined && !changed
      ? item
      : await tx.taskChecklistItem.update({ where: { id: itemId }, data: update });
    if (item.completed !== result.completed || item.text !== result.text) {
      const action = item.completed !== result.completed
        ? result.completed ? "checklist_item_completed" : "checklist_item_reopened"
        : "checklist_item_updated";
      await logActivityWithClient(tx, {
        taskId, userId: actorId, action,
        oldValue: { itemId: item.id, text: item.text, completed: item.completed },
        newValue: { itemId: result.id, text: result.text, completed: result.completed },
      });
    }

    const createdReceipt = normalizedOperationId === undefined ? null : await tx.checklistOperationReceipt.create({
      data: {
        actorId, operationId: normalizedOperationId, taskId, itemId, projectId,
        completed: result.completed, changed, eventId: randomUUID(),
        ...(validCorrelationId(context?.actionId) ? { actionId: context.actionId.toLowerCase() } : {}),
        ...(validCorrelationId(context?.requestId) ? { requestId: context.requestId.toLowerCase() } : {}),
      },
      select: { id: true },
    });
    return { item: result, projectId, changed, replayed: false,
      ...(createdReceipt ? { receiptId: createdReceipt.id } : {}) };
  });
}
