import {projectChatMessage} from "@/lib/chat-message-projection";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import { patchTaskSchema, taskDetailsCommandSchema } from "@/lib/validators";
import { z } from "zod";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { getTaskReadWhere, requireTaskWrite } from "@/lib/project-access";
import { NotFoundError, ForbiddenError } from "@/lib/errors";
import { logActivityWithClient } from "@/lib/activity-logger";
import {
  emitTaskDeleted,
  emitTaskMoved,
  emitTaskUpdated,
  emitTaskMessageCreated,
} from "@/socket/board-events";
import { loadTaskWithRelations, TASK_WITH_RELATIONS_INCLUDE } from "@/lib/task-queries";
import { toTaskDetailForReader } from "@/lib/task-detail-for-reader";
import { readRequestQueueArrivalMap } from "@/lib/request-queue-unseen";
import { emitRequestQueueInvalidation } from "@/socket/request-queue-events";
import { readVisibleTaskAttachments } from "@/lib/attachments/task-port";
import { createTaskCommandService, TaskCommandError, type TaskDetailsCommandResult } from "@/lib/task-command";
import { readTaskRequestDecision } from "@/lib/task-request-guard";
import { requireTaskDeadlineExecutor } from "@/lib/task-field-policy";
import { taskRequestLifecycleCommandSchema } from "@/lib/task-request-marker-lifecycle";
import {
  createTaskLifecycleService,
  deleteTaskLifecycleAware,
  TaskLifecycleError,
} from "@/features/kanban/server/task-lifecycle-service";
import { readTelemetryJson, TelemetryHttpError } from "@/lib/telemetry/http";
import { withApiLogging } from "@/middleware/api-logger";
import { apiLogger } from "@/lib/logger";
import type { RequestLogContext } from "@/lib/request-context";
import { notifyTaskAssigned, notifyTaskStatusChanged, notifyTaskTakenOver } from "@/lib/notification-triggers";
import { processAutomationRules, statusChangeAutomationEvent } from "@/lib/automation-processor";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import {
  createCanonicalTaskRelocationPort,
  relocateTaskToColumn,
  TaskRelocationError,
  validateColumnDerivedStatusUpdate,
} from "@/features/kanban/server/task-relocation";
import {
  apiError,
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiNotFound,
  apiInvalidJson,
  apiValidationError,
  apiInternalError,
  apiForbidden,
} from "@/lib/api-response";
import { requireTrustedMutationOrigin } from "@/lib/mutation-origin";

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function requireCommandOrigin(request: Request): void {
  requireTrustedMutationOrigin(request);
}

function commandFailure(error: unknown, context: RequestLogContext): Response {
  if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
  if (error instanceof ForbiddenError) return noStore(apiError("FORBIDDEN", "Task request rejected", undefined, 403));
  if (error instanceof NotFoundError) return noStore(apiNotFound("Задача не найдена"));
  if (error instanceof TaskCommandError) {
    return noStore(apiError(error.code, "Task command rejected; refresh before a new action", undefined,
      error.code === "INVALID_COMMAND" ? 400 : 409));
  }
  if (error instanceof TelemetryHttpError) {
    if (error.status === 400) return noStore(apiInvalidJson());
    return noStore(apiError("INVALID_TASK_REQUEST", "Task request rejected", undefined, error.status));
  }
  try { apiLogger.error({ ...context, event: "task.command.failed", err: error }); }
  catch { /* No raw fallback logging. */ }
  return noStore(apiInternalError("Не удалось обновить задачу"));
}

async function commandEffects(result: TaskDetailsCommandResult, actorId: string, context: RequestLogContext): Promise<void> {
  if (result.effects === null) return;
  const safely = async (operation: () => unknown | Promise<unknown>) => {
    try { await operation(); }
    catch (error) {
      try { apiLogger.error({ ...context, event: "task.command.effects.failed", err: error }); }
      catch { /* A committed ACK survives diagnostics failures too. */ }
    }
  };
  await safely(async () => {
    const task = await loadTaskWithRelations(result.ack.taskId);
    if (!task) return;
    if (result.effects?.priority) {
      const priority = result.effects.priority;
      await safely(() => processAutomationRules({ trigger: "priority_changed", taskId: result.ack.taskId,
        projectId: result.ack.projectId, userId: actorId, oldValue: priority.oldValue, newValue: priority.newValue, task }));
    }
    if (result.effects?.deadlineSet) {
      const deadline = result.effects.deadlineSet;
      await safely(() => processAutomationRules({ trigger: "deadline_set", taskId: result.ack.taskId,
        projectId: result.ack.projectId, userId: actorId, newValue: new Date(deadline), task }));
    }
    const current = await loadTaskWithRelations(result.ack.taskId);
    if (current) await safely(() => emitTaskUpdated(result.ack.projectId, current));
  });
}

async function detailsGET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return withApiLogging(request, async (_request, logContext) => {
    try {
      const authenticated = await requireApiUser(request);
      logContext.actorId = authenticated.id;
      const query = new URL(request.url).searchParams;
      if (query.getAll("view").length !== 1 || query.get("view") !== "details"
        || [...query.keys()].some(key => key !== "view")) return noStore(apiBadRequest("Invalid task view"));
      const { id } = await context.params;
      const task = await prisma.$transaction(async tx => {
        const actor = await tx.user.findUnique({ where: { id: authenticated.id }, select: { id: true, globalRole: true } });
        if (!actor) throw new NotFoundError();
        const stored = await tx.task.findFirst({
          where: await getTaskReadWhere(actor, { id }, tx),
          include: TASK_WITH_RELATIONS_INCLUDE,
        });
        if (!stored) throw new NotFoundError();
        return toTaskDetailForReader(tx, actor, stored);
      });
      logContext.projectId = task.projectId;
      return noStore(apiSuccess(task));
    } catch (error) { return commandFailure(error, logContext); }
  }, { route: "/api/tasks/:id" });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (new URL(request.url).searchParams.has("view")) return detailsGET(request, context);
  try {
    const user = await requireApiUser(request);
    const { id } = await context.params;
    const select = {
        id: true,
        title: true,
        projectId: true,
        project: { select: { name: true } },
    } as const;
    const task = await prisma.task.findFirst({ where: await getTaskReadWhere(user, { id }), select });
    if (!task) return apiNotFound("Задача не найдена");
    const arrivals = await readRequestQueueArrivalMap(prisma, user.id, [task.id]);
    if (!arrivals.has(task.id)) return apiNotFound("Задача не найдена");
    return noStore(apiSuccess({ ...task, queueArrival: arrivals.get(task.id) ?? null }));
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) return apiUnauthorized();
    if (error instanceof NotFoundError) return apiNotFound("Задача не найдена");
    return apiInternalError("Не удалось загрузить задачу");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiLogging(request, async (_request, logContext) => {
    try {
      const user = await requireApiUser(request);
      logContext.actorId = user.id;
      const json = await readTelemetryJson(request, { maxBytes: 256 * 1024, requireJsonContentType: false });
      const instrumented = json !== null && typeof json === "object"
        && (Object.hasOwn(json, "operationId") || Object.hasOwn(json, "changes"));
      if (!instrumented) return legacyPATCH(request, context, json, user);
      requireCommandOrigin(request);
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") return noStore(apiError("INVALID_TASK_REQUEST", "JSON required", undefined, 415));
      const parsed = taskDetailsCommandSchema.safeParse(json);
      if (!parsed.success) return noStore(apiBadRequest("Invalid task command"));
      const { id } = await context.params;
      try { await rateLimitOrThrowKey("tasks:update", user.id); }
      catch (error) { return noStore(rateLimitErrorResponse(error)); }
      const result = await createTaskCommandService(prisma).saveDetails({ actorId: user.id, taskId: id, ...parsed.data });
      logContext.projectId = result.ack.projectId;
      await commandEffects(result, user.id, logContext);
      return noStore(apiSuccess(result.ack));
    } catch (error) { return commandFailure(error, logContext); }
  }, { route: "/api/tasks/:id" });
}

const lifecyclePayloadCodes = new Set<TaskLifecycleError["code"]>([
  "ASSIGNEE_REQUIRED",
  "REASON_REQUIRED",
  "RESPONSE_REQUIRED",
  "DESCRIPTION_REQUIRED",
  "ASSIGNEE_NOT_ELIGIBLE",
]);

function lifecycleFailure(error: unknown, context: RequestLogContext): Response {
  if (error instanceof UnauthorizedError) return noStore(apiUnauthorized());
  if (error instanceof ForbiddenError) return noStore(apiError("FORBIDDEN", "Task request rejected", undefined, 403));
  if (error instanceof NotFoundError) return noStore(apiNotFound("Задача не найдена"));
  if (error instanceof TaskLifecycleError) {
    const status = error.code === "FORBIDDEN_ROLE" ? 403
      : error.code === "NOT_A_REQUEST" ? 404
        : lifecyclePayloadCodes.has(error.code) ? 422
          : error.code === "INVALID_COMMAND" || error.code === "INVALID_LIFECYCLE_ACTION" ? 400 : 409;
    return noStore(apiError(error.code, "Task lifecycle command rejected; refresh before a new action", undefined, status));
  }
  if (error instanceof TelemetryHttpError) {
    if (error.status === 400) return noStore(apiInvalidJson());
    return noStore(apiError("INVALID_TASK_REQUEST", "Task request rejected", undefined, error.status));
  }
  try { apiLogger.error({ ...context, event: "task.lifecycle.failed", err: error }); }
  catch { /* No raw fallback logging. */ }
  return noStore(apiInternalError("Не удалось изменить заявку"));
}

/** POST /api/tasks/[id] — one closed lifecycle transition for a marked request. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withApiLogging(request, async (_request, logContext) => {
    try {
      const user = await requireApiUser(request);
      logContext.actorId = user.id;
      const json = await readTelemetryJson(request, { maxBytes: 256 * 1024, requireJsonContentType: false });
      requireCommandOrigin(request);
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return noStore(apiError("INVALID_TASK_REQUEST", "JSON required", undefined, 415));
      }
      const parsed = taskRequestLifecycleCommandSchema.safeParse(json);
      if (!parsed.success) return noStore(apiBadRequest("Invalid task lifecycle command"));
      const { id } = await context.params;
      try { await rateLimitOrThrowKey("tasks:update", user.id); }
      catch (error) { return noStore(rateLimitErrorResponse(error)); }
      const result = await createTaskLifecycleService(prisma).transition({
        actorId: user.id,
        taskId: id,
        ...parsed.data,
      });
      logContext.projectId = result.ack.projectId;
      const effects = result.effects;
      if (effects !== null) {
        const safely = async (operation: () => unknown | Promise<unknown>) => {
          try { await operation(); }
          catch (error) {
            try { apiLogger.error({ ...logContext, event: "task.lifecycle.effects.failed", err: error }); }
            catch { /* A committed ACK survives diagnostics failures. */ }
          }
        };
        if(effects.reasonMessageId&&result.ack.changed&&!result.ack.replayed){
          await safely(async()=>{
            const message=await prisma.chatMessage.findFirst({where:{id:effects.reasonMessageId,taskId:result.ack.taskId},include:{author:{select:{id:true,name:true,email:true,avatarUrl:true}}}});
            if(message)await emitTaskMessageCreated(result.ack.projectId,{...projectChatMessage(message),visibility:"PUBLIC",isInternal:false});
          });
        }
        await safely(async () => {
          const current = await loadTaskWithRelations(result.ack.taskId);
          if (!current) return;
          // Both effects follow the commit independently: a broken board bridge
          // must not prevent the new executor's existing notification channel.
          await safely(() => emitTaskUpdated(result.ack.projectId, current));
          const assigneeId = effects.executorId;
          if (effects.action === "take_over" && result.ack.changed && !result.ack.replayed
            && effects.previousExecutorId !== null && assigneeId !== effects.previousExecutorId) {
            const previousExecutorId = effects.previousExecutorId;
            await safely(async () => {
              const actor = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
              await notifyTaskTakenOver({ taskId: result.ack.taskId, projectId: result.ack.projectId,
                previousExecutorId, actorId: user.id, actorName: actor?.name?.trim() || "Участник" });
            });
          }
          if (effects.action === "assign" && result.ack.changed && !result.ack.replayed
            && assigneeId !== null && assigneeId !== effects.previousExecutorId) {
            await safely(async () => {
              const actor = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
              await notifyTaskAssigned({
                taskId: result.ack.taskId,
                taskTitle: current.title,
                projectId: result.ack.projectId,
                assigneeId,
                assignedById: user.id,
                assignedByName: actor?.name?.trim() || "Участник",
              });
            });
          }
        });
      }
      return noStore(apiSuccess(result.ack));
    } catch (error) { return lifecycleFailure(error, logContext); }
  }, { route: "/api/tasks/:id" });
}

async function legacyPATCH(request: Request, context: { params: Promise<{ id: string }> }, json: unknown,
  user: Awaited<ReturnType<typeof requireApiUser>>) {

  try {
    const params = await context.params;
    // patchTaskSchema is shared with legacy callers and strips unknown keys.
    // Reject them at this HTTP boundary before parsing can hide an attempt to
    // replace identity, assignment, attachments or request lifecycle metadata.
    const allowedFields = new Set([
      "title", "description", "status", "priority", "position", "deadline",
      "columnId", "expectedVersion",
    ]);
    if (json !== null && typeof json === "object" && !Array.isArray(json)
      && Object.keys(json).some(field => !allowedFields.has(field))) {
      return apiBadRequest("Invalid task fields");
    }
    const parsed = patchTaskSchema.parse(json);

    try {
      validateColumnDerivedStatusUpdate(parsed);
    } catch (error) {
      if (!(error instanceof TaskRelocationError)) {
        throw error;
      }
      return apiError(
        "STATUS_REQUIRES_COLUMN",
        "status can only be changed by selecting a column",
        undefined,
        422,
      );
    }

    // Rate limiting
    try {
      await rateLimitOrThrowKey("tasks:update", user.id);
    } catch (e) {
      return rateLimitErrorResponse(e);
    }

    const existing = await prisma.task.findFirst({
      where: await getTaskReadWhere(user, { id: params.id }),
      select: {
        id: true,
        projectId: true,
        columnId: true,
        version: true,
        status: true,
        title: true,
        priority: true,
        deadline: true,
      },
    });
    if (!existing) {
      return apiNotFound("Задача не найдена");
    }

    const ranks = createBase36RankService();
    let transactionResult;
    try {
      transactionResult = await prisma.$transaction(async (tx) => {
        if (parsed.columnId === undefined) {
          const projects = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Project" WHERE "id" = ${existing.projectId} FOR UPDATE
          `;
          if (projects.length === 0) throw new NotFoundError();
          const tasks = await tx.$queryRaw<{ id: string; projectId: string }[]>`
            SELECT "id", "projectId" FROM "Task" WHERE "id" = ${params.id} FOR UPDATE
          `;
          const current = tasks[0];
          if (!current) throw new NotFoundError();
          if (current.projectId !== existing.projectId) throw new TaskCommandError("IDENTITY_CHANGED");
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR SHARE`;
          const actor = await tx.user.findUnique({ where: { id: user.id }, select: { id: true, globalRole: true } });
          if (!actor) throw new NotFoundError();
          await requireTaskWrite(actor, current.id, current.projectId, tx);
          const decision = await readTaskRequestDecision(tx, current.id);
          if (!decision.allowed) throw new TaskCommandError(decision.code);
        }
        const auditedFields = ["title", "description", "priority", "deadline"] as const;
        const hasAuditedChange = auditedFields.some(field => parsed[field] !== undefined);
        const canonicalMove =
          parsed.columnId === undefined
            ? null
            : await relocateTaskToColumn({
                taskId: params.id,
                expectedProjectId: existing.projectId,
                toColumnId: parsed.columnId,
                expectedVersion:
                  parsed.expectedVersion ?? existing.version,
                operationId: randomUUID(),
                port: createCanonicalTaskRelocationPort(
                  tx,
                  ranks,
                  user.id,
                ),
                ranks,
              });
        let beforeChange = null;
        if (hasAuditedChange) {
          // Preserve relocation's column-before-task lock order on combined PATCH.
          // Relocation does not change these scalar fields.
          await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${params.id} FOR UPDATE`;
          beforeChange = await tx.task.findUniqueOrThrow({
            where: { id: params.id },
            select: { title: true, description: true, priority: true, deadline: true },
          });
        }
        if (parsed.deadline !== undefined) {
          await requireTaskDeadlineExecutor(tx, user.id, params.id);
        }
        const scalarData = { ...parsed };
        delete scalarData.columnId;
        delete scalarData.expectedVersion;
        delete scalarData.status;
        if (parsed.columnId !== undefined) {
          delete scalarData.position;
        }
        const include = {
          assignees: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  avatarUrl: true,
                },
              },
            },
          },
          tags: {
            include: {
              tag: true,
            },
          },
          checklistItems: {
            orderBy: { position: "asc" as const },
          },
          _count: {
            select: { messages: true },
          },
        };
        const task =
          Object.keys(scalarData).length > 0
            ? await tx.task.update({
                where: { id: params.id },
                data: scalarData,
                include,
              })
            : await tx.task.findUniqueOrThrow({
                where: { id: params.id },
                include,
              });
        if (beforeChange) {
          for (const field of auditedFields) {
            if (parsed[field] === undefined) continue;
            const oldValue = field === "deadline" ? beforeChange.deadline?.toISOString() ?? null : beforeChange[field];
            const newValue = field === "deadline" ? task.deadline?.toISOString() ?? null : task[field];
            if (oldValue === newValue) continue;
            const action = field === "deadline"
              ? newValue === null ? "deadline_removed" : oldValue === null ? "deadline_set" : "deadline_changed"
              : `${field}_changed`;
            await logActivityWithClient(tx, {
              taskId: params.id, userId: user.id, action,
              oldValue: { [field]: oldValue }, newValue: { [field]: newValue },
            });
          }
        }
        return {
          task,
          canonicalMove,
          updateData: {
            ...scalarData,
            ...(canonicalMove
              ? {
                  columnId: canonicalMove.task.columnId,
                  status: canonicalMove.task.status,
                }
              : {}),
          },
        };
      });
    } catch (error) {
      if (error instanceof TaskRelocationError) {
        if (error.code === "REQUEST_LIFECYCLE_NOT_ENABLED" || error.code === "INVALID_REQUEST_MARKER") {
          return apiError(error.code, "Перемещение задачи недоступно", undefined, 409);
        }
        if (error.code === "INVALID_MOVE_ROUTE") {
          return apiError(error.code, "Недопустимый маршрут перемещения задачи", undefined, 422);
        }
        if (error.code === "TASK_NOT_FOUND") {
          return apiNotFound("Задача не найдена");
        }
        if (error.code === "STALE_TASK_VERSION") {
          return apiError(
            error.code,
            "Задача была изменена. Обновите доску и повторите попытку",
            undefined,
            409,
          );
        }
        return apiBadRequest("Колонка не принадлежит этому проекту");
      }
      throw error;
    }
    const { task, canonicalMove, updateData } = transactionResult;

    // Send notification if status changed. The shared builder is the single
    // `status_changed` event shape for move, PATCH and bulk; an unchanged
    // status (same-column reorder or the same workflow key) yields no event.
    const statusEvent = statusChangeAutomationEvent({
      taskId: params.id,
      projectId: existing.projectId,
      userId: user.id,
      previousStatus: existing.status,
      nextStatus: updateData.status ?? existing.status,
    });
    if (statusEvent) {
      const changerName = user.name || user.email;
      notifyTaskStatusChanged({
        taskId: params.id,
        taskTitle: existing.title,
        projectId: existing.projectId,
        oldStatus: existing.status,
        newStatus: updateData.status ?? existing.status,
        changedById: user.id,
        changedByName: changerName,
      }).catch((err) => console.error("Failed to send notification:", err));

      // Process automation rules for status change
      processAutomationRules(statusEvent).catch((err) => console.error("Failed to process automation rules:", err));
    }

    // Process automation rules for priority change
    if (parsed.priority && parsed.priority !== existing.priority) {
      processAutomationRules({
        trigger: "priority_changed",
        taskId: params.id,
        projectId: existing.projectId,
        userId: user.id,
        oldValue: existing.priority,
        newValue: parsed.priority,
        task,
      }).catch((err) => console.error("Failed to process automation rules:", err));
    }

    // Process automation rules for deadline set
    if (parsed.deadline && !existing.deadline) {
      processAutomationRules({
        trigger: "deadline_set",
        taskId: params.id,
        projectId: existing.projectId,
        userId: user.id,
        newValue: parsed.deadline,
        task,
      }).catch((err) => console.error("Failed to process automation rules:", err));
    }

    // Emit real-time event to all users viewing this project
    // Reload task with full relations to include _count.messages
    const fullTask = await loadTaskWithRelations(params.id);
    if (canonicalMove) {
      await emitTaskMoved(existing.projectId, canonicalMove);
    }
    if (fullTask) {
      emitTaskUpdated(fullTask.project.id, fullTask);
    }

    const attachments = await readVisibleTaskAttachments(prisma, user, existing.projectId, task.attachments);
    return apiSuccess(attachments === undefined ? task : { ...task, attachments });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) {
      return apiNotFound("Задача не найдена");
    }
    if (error instanceof TaskCommandError) {
      return apiError(error.code, "Task command rejected; refresh before a new action", undefined, 409);
    }
    if (
      error instanceof TaskRelocationError &&
      error.code === "STALE_TASK_VERSION"
    ) {
      return apiError(
        error.code,
        "Задача была изменена. Обновите доску и повторите попытку",
        undefined,
        409,
      );
    }
    return apiInternalError("Не удалось обновить задачу");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const params = await context.params;
    const user = await requireApiUser(request);

    // Rate limiting
    try {
      await rateLimitOrThrowKey("tasks:delete", user.id);
    } catch (e) {
      return rateLimitErrorResponse(e);
    }

    const existing = await prisma.task.findFirst({
      where: await getTaskReadWhere(user, { id: params.id }),
      select: { id: true, projectId: true },
    });
    if (!existing) {
      return apiNotFound("Задача не найдена");
    }

    const actorId = user.id;
    const result = await prisma.$transaction(async tx => {
      const outcome = await deleteTaskLifecycleAware({
        tx,
        actorId,
        taskId: params.id,
        expectedProjectId: existing.projectId,
      });
      if (!outcome.logical) {
        const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true } });
        if (!actor) throw new NotFoundError();
        await requireTaskWrite(actor, params.id, existing.projectId, tx);
        await tx.task.delete({ where: { id: params.id } });
      }
      return {
        projectId: existing.projectId,
        taskId: params.id,
        actorId,
        logical: outcome.logical,
        ...(outcome.previousQueueRecipientIds !== undefined ? { previousQueueRecipientIds: outcome.previousQueueRecipientIds } : {}),
      };
    });

    if (result.previousQueueRecipientIds !== undefined) {
      try { await emitRequestQueueInvalidation({ taskId: result.taskId, projectId: result.projectId,
        previousRecipientIds: result.previousQueueRecipientIds }); }
      catch { /* A committed deletion survives cache invalidation failures. */ }
    }

    // Emit real-time event to all users viewing this project. A marked request
    // is logically cancelled, so the card still exists and is updated instead.
    try {
      if (result.logical) {
        const current = await loadTaskWithRelations(result.taskId);
        if (current) await emitTaskUpdated(result.projectId, current);
      } else {
        await emitTaskDeleted(result.projectId, result.taskId, result.actorId);
      }
    } catch (error) {
      try { apiLogger.warn({ event: "task.delete.realtime.failed", route: "/api/tasks/:id", err: error }); }
      catch { /* A diagnostic failure cannot replace committed deletion. */ }
    }

    return apiSuccess(
      result.logical ? { deleted: true, logical: true } : { deleted: true },
      undefined,
      200,
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof NotFoundError) return apiNotFound("Задача не найдена");
    if (error instanceof TaskCommandError) return apiError(error.code, "Task deletion rejected; refresh before a new action", undefined, 409);
    if (error instanceof TaskLifecycleError) {
      const status = error.code === "FORBIDDEN_ROLE" ? 403
        : lifecyclePayloadCodes.has(error.code) ? 422
          : error.code === "INVALID_COMMAND" || error.code === "INVALID_LIFECYCLE_ACTION" ? 400 : 409;
      return apiError(error.code, "Task deletion rejected; refresh before a new action", undefined, status);
    }
    return apiInternalError("Не удалось удалить задачу");
  }
}
