import { decodeLifecycleColumnMap, validateLifecycleColumnTargets, LifecycleColumnConfigurationError } from "@/lib/task-request-columns";
import { encodeRequestDescription, isBeznalProject } from "@/lib/request-presentation";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTaskReadWhere } from "@/lib/project-access";
import { readTaskUrgencyPage, taskUrgencyWhere, TASK_CREATED_ORDER } from "@/lib/task-urgency-page";
import { readTaskVisibleWorkPage } from "@/lib/task-visible-work-order";
import { normalizeTaskSearch, taskSearchPredicate } from "@/lib/task-search";
import { taskListVisibilityWhere } from "@/lib/task-list-visibility";
import { readRequestQueueArrivalMap, readRequestQueueUnseenWhere } from "@/lib/request-queue-unseen";
import { getProjectCreationPolicy, isCreationColumnAllowed } from "@/lib/project-creation-policy";
import { lockProjectCreationDepartment } from "@/lib/project-create-department-lock";
import { createTaskSchema } from "@/lib/validators";
import { audienceRecipientIds, validateRequestRecipients } from "@/lib/request-audience-input";
import { z } from "zod";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { emitTaskCreated } from "@/socket/board-events";
import { processAutomationRules } from "@/lib/automation-processor";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import {
  TaskRankMaintenanceError,
} from "@/features/kanban/server/append-task-rank";
import { prepareLegacyTaskCreation } from "@/features/kanban/server/task-creation-port";
import { ownTaskProjectIds } from "@/lib/access-policy";
import { derivedTaskStatus } from "@/features/kanban/server/move-contract";
import { apiLogger } from "@/lib/logger";
import { readVisibleTaskAttachments, effectiveBeznalPhase } from "@/lib/attachments/task-port";
import { readVisibleMessageCounts } from "@/lib/task-visible-message-counts";
import {
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  TASK_SEARCH_LIMIT,
} from "@/lib/task-list-limits";
import { BadRequestError, NotFoundError, ForbiddenError } from "@/lib/errors";
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

function positiveIntParam(value: string | null): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  const search = normalizeTaskSearch(searchParams.get("search"));
  const assignedToMe = searchParams.get("assignedToMe") === "true";
  const requestScope = searchParams.get("requestScope");
  const status = searchParams.get("status");
  const columnId = searchParams.get("columnId");
  const unseenOnly = searchParams.get("unseen") === "1";
  const page = positiveIntParam(searchParams.get("page")) ?? 1;
  const limit = Math.min(
    TASK_LIST_MAX_LIMIT,
    positiveIntParam(searchParams.get("limit")) ?? TASK_LIST_DEFAULT_LIMIT,
  );
  const pageSize = search ? TASK_SEARCH_LIMIT : limit;

  try {
    const user = await requireApiUser(request);

      // Actor quota covers every list/search variant before policy or task reads.
      // An unavailable limiter fails closed through the existing safe 500 path.
      try {
        await rateLimitOrThrowKey("tasks:list", user.id);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && error.status === 429) {
          return rateLimitErrorResponse(error);
        }
        throw error;
      }

      // Build where clause with all filters
      const whereConditions: Prisma.TaskWhereInput = {};

      // Client project selection can only narrow the server policy below.
      if (projectId) {
        whereConditions.projectId = projectId;
      }

      // assignedToMe is a voluntary narrowing filter on top of the server
      // predicate, never a read grant. "Assigned" means the single canonical
      // executor of a marked request, or the legacy single assignee. A legacy
      // row with several assignees is deliberately excluded (migration policy:
      // ambiguous old assignments grant nothing until reconciled).
      if (assignedToMe) {
        whereConditions.OR = [
          { request: { is: { contractVersion: 1, executorId: user.id, deletedAt: null } } },
          { request: { is: null }, assignees: { some: { userId: user.id } } },
        ];
      }

      // These scopes narrow the shared read policy; a query never grants access.
      if (requestScope === "mine" || requestScope === "reply") {
        if (requestScope === "reply") {
          whereConditions.request = { is: { contractVersion: 1, authorId: user.id, state: "NEEDS_INFO", deletedAt: null } };
        } else {
          whereConditions.AND = [{ OR: [
            { request: { is: { contractVersion: 1, authorId: user.id, deletedAt: null } } },
            { request: { is: null }, createdById: user.id },
          ] }];
        }
      }

      // Add status filter with validation
      if (status) {
        const validStatuses = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"];
        if (!validStatuses.includes(status)) {
          return apiBadRequest("Invalid status value");
        }
        whereConditions.status = status;
      }
      if (columnId) {
        whereConditions.columnId = columnId;
      }

      // Add search filter
      const filteredWhere = search
        ? {
            AND: [
              whereConditions,
              taskSearchPredicate(search),
            ],
          }
        : whereConditions;

      // Project membership is only the legacy branch of the shared policy.
      // OWN authors/watchers can read a task without board membership.
      const readableWhere = await getTaskReadWhere(user, filteredWhere, prisma, projectId ? { projectId } : undefined);
      // Lists, search and recent requests omit saved drafts even for their
      // author or ADMIN. Direct draft reads and submit retries keep their ACL.
      const listWhere: Prisma.TaskWhereInput = { AND: [readableWhere, taskListVisibilityWhere()] };
      const whereClause = unseenOnly
        ? await readRequestQueueUnseenWhere(prisma, user.id, listWhere)
        : listWhere;

      // One extra row is the sentinel that tells us whether another page exists
      // without a second COUNT query.
      const listInclude = {
          createdBy: { select: { id: true, name: true, primaryDepartment: { select: { name: true } } } },
          request: { select: { state: true, executorId: true, audienceUserIds: true, beznalPhase: true,
            author: { select: { id: true, name: true } }, executor: { select: { id: true, name: true } },
          } },
          assignees: {
            select: {
              id: true,
              userId: true,
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
          project: {
            select: {
              id: true,
              name: true,
            },
          },
          column: {
            select: {
              id: true,
              name: true,
              color: true,
            },
          },
          tags: {
            select: {
              id: true,
              tag: {
                select: {
                  id: true,
                  name: true,
                  color: true,
                },
              },
            },
          },
          // The board only renders "completed of total"; the item rows belong to
          // the card detail request (`/api/tasks/:id?view=details`).
          _count: {
            select: { messages: true, checklistItems: true },
          },
      } satisfies Prisma.TaskInclude;
      const beznal = projectId ? isBeznalProject((await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }))?.name) : false;
      const workPage = beznal && projectId ? await readTaskVisibleWorkPage({ db: prisma, actor: user, projectId,
        where: whereClause, offset: search ? 0 : (page - 1) * limit, pageSize }) : null;
      const visibleWorkAt = new Map(workPage?.map(row => [row.id, row.lastVisibleWorkAt]) ?? []);
      const rows = workPage ? await (async () => {
        if (!workPage.length) return [];
        const selectedWhere = await getTaskReadWhere(user, { AND: [whereClause, { id: { in: workPage.map(row => row.id) } }] }, prisma, { projectId: projectId! });
        const hydrated = await prisma.task.findMany({ where: selectedWhere, include: listInclude });
        const byId = new Map(hydrated.map(task => [task.id, task]));
        return workPage.flatMap(row => { const task = byId.get(row.id); return task ? [task] : []; });
      })() : await readTaskUrgencyPage({
        offset: search ? 0 : (page - 1) * limit,
        pageSize,
        countUrgent: () => prisma.task.count({ where: taskUrgencyWhere(whereClause, true) }),
        read: (urgent, skip, take) => prisma.task.findMany({
          where: taskUrgencyWhere(whereClause, urgent), include: listInclude,
          orderBy: TASK_CREATED_ORDER, skip, take,
        }),
      });

      const hasMore = rows.length > pageSize;
      const tasks = hasMore ? rows.slice(0, pageSize) : rows;

      // Calculate unread count efficiently using aggregation
      const taskIds = tasks.map(t => t.id);
      const queueArrivals = await readRequestQueueArrivalMap(prisma, user.id, taskIds);
      const visibleMessageCounts = await readVisibleMessageCounts(prisma, user, taskIds);
      const completedChecklistByTask = new Map<string, number>();

      if (taskIds.length > 0) {
        // Use raw query for efficient aggregation
        const completedChecklistCounts = await prisma.taskChecklistItem.groupBy({
            by: ["taskId"],
            where: { taskId: { in: taskIds }, completed: true },
            _count: { _all: true },
          });
        for (const row of completedChecklistCounts) {
          completedChecklistByTask.set(row.taskId, row._count._all);
        }
      }

      // A revoked row omitted by the fresh reader projection is never restored
      // from the earlier page snapshot. Projection failure rejects this response.
      const tasksWithUnread = await Promise.all(tasks.filter(task => queueArrivals.has(task.id) && visibleMessageCounts.has(task.id)).map(async (task) => {
        const attachments = await readVisibleTaskAttachments(prisma, user, task.projectId, task.attachments);
        return {
          ...task,
          _count: { ...task._count, messages: visibleMessageCounts.get(task.id)!.total },
          ...(visibleWorkAt.has(task.id) ? { lastVisibleWorkAt: visibleWorkAt.get(task.id)! } : {}),
          ...(attachments === undefined ? {} : { attachments }),
          queueArrival: queueArrivals.get(task.id) ?? null,
          request: task.request ? {
            state: task.request.state,
            executorId: task.request.executorId,
            beznalPhase: isBeznalProject(task.project.name) ? effectiveBeznalPhase(task.request.beznalPhase, task.attachments) : null,
            isPersonal: task.request.audienceUserIds.length > 0,
            author: task.request.author ? { id: task.request.author.id, name: task.request.author.name } : null,
            executor: task.request.executor ? { id: task.request.executor.id, name: task.request.executor.name } : null,
          } : null,
          checklist: {
            total: task._count.checklistItems,
            completed: completedChecklistByTask.get(task.id) ?? 0,
          },
          unreadCount: visibleMessageCounts.get(task.id)!.unread,
        };
      }));

    const response = apiSuccess(tasksWithUnread, { page: search ? 1 : page, limit: pageSize, hasMore });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof BadRequestError) return apiBadRequest("Недопустимые параметры списка");
    if (error instanceof NotFoundError) return apiNotFound("Обращения недоступны");
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить задачи");
  }
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    // Keep the legacy creation vocabulary, but never silently discard a
    // forged author, executor, marker or attachment metadata.
    const parsed = createTaskSchema.safeExtend({ operationId: z.string().uuid().optional() }).strict().parse(json);
    const canonicalCreate = parsed.requestDetails !== undefined || parsed.audience !== undefined;
    const audienceUserIds = audienceRecipientIds(parsed.audience);
    const user = await requireApiUser(request);
    const description = encodeRequestDescription(parsed.description, parsed.requestDetails);
    if (description && description.length > 50000) return apiBadRequest("Сократите подробности обращения");

    // Rate limiting
    try {
      await rateLimitOrThrowKey("tasks:create", user.id);
    } catch (e) {
      return rateLimitErrorResponse(e);
    }

    const project = await prisma.project.findFirst({
      where: { id: parsed.projectId },
      select: { id: true, ...(canonicalCreate ? {
        lifecycleColumnMap: true, columns: { select: { id: true, projectId: true, workflowKey: true } },
      } : {}) },
    });
    if (!project) {
      return apiNotFound("Проект не найден");
    }

    const defaultCreationPolicy = (parsed.columnId && !canonicalCreate) ? null : await getProjectCreationPolicy(user, parsed.projectId);
    if (defaultCreationPolicy && !defaultCreationPolicy.canCreate) return apiNotFound("Проект не найден");
    if (defaultCreationPolicy?.allowedColumnIds?.length === 0) return apiForbidden();
    if (canonicalCreate) {
      const map = decodeLifecycleColumnMap(project.lifecycleColumnMap ?? null);
      if (!map) throw new LifecycleColumnConfigurationError("LIFECYCLE_COLUMNS_REQUIRED");
      validateLifecycleColumnTargets(map, project.columns ?? [], parsed.projectId);
    }

    const creationColumnId = parsed.columnId ?? defaultCreationPolicy?.allowedColumnIds?.[0];
    const selectedColumn = creationColumnId
      ? await prisma.projectColumn.findFirst({
          where: { id: creationColumnId, projectId: parsed.projectId },
          select: { id: true, workflowKey: true },
        })
      : await prisma.projectColumn.findFirst({
          where: { projectId: parsed.projectId },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: { id: true, workflowKey: true },
        });

    if (!selectedColumn) {
      if (parsed.columnId) {
        return apiBadRequest("Колонка не принадлежит этому проекту");
      }
      return apiBadRequest("У проекта нет колонок");
    }

    // Structured requests start as private drafts; legacy clients retain their
    // compatibility path. The author is always the authenticated server actor.
    const markedBoard = canonicalCreate || ownTaskProjectIds(
      process.env.LENKANBAN_OWN_TASK_PROJECT_IDS,
    ).includes(parsed.projectId);

    const operationId = parsed.operationId?.toLowerCase();
    const requestHash = operationId ? createHash("sha256")
      .update(JSON.stringify({ kind: "create_task", actorId: user.id, ...parsed, ...(parsed.audience ? { audience: { mode: parsed.audience.mode, userIds: audienceUserIds } } : {}), operationId })).digest("hex") : null;
    const result = await prisma.$transaction(async (tx) => {
      if (operationId) {
        // Share the operation lock namespace with other HTTP commands. Authority
        // is refreshed before reading receipts; replay never runs rank maintenance.
        const operationKey = JSON.stringify(["task-http-operation-v1", operationId]);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))::text AS locked`;
        const projects = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Project" WHERE "id" = ${parsed.projectId} FOR UPDATE`;
        if (projects.length !== 1) throw new NotFoundError();
        const columns = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ProjectColumn" WHERE "id" = ${selectedColumn.id} AND "projectId" = ${parsed.projectId} FOR UPDATE`;
        if (columns.length !== 1) throw new BadRequestError();
        // Match the creation port's resource-before-actor lock order even when
        // rank maintenance is needed after the receipt lookup.
        await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "columnId" = ${selectedColumn.id} ORDER BY "id" FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR SHARE`;
        const actor = await tx.user.findUnique({ where: { id: user.id }, select: { id: true, globalRole: true } });
        if (!actor || actor.id !== user.id || (actor.globalRole !== "USER" && actor.globalRole !== "ADMIN")) throw new NotFoundError();
        await lockProjectCreationDepartment(tx, parsed.projectId);
        const creationPolicy = await getProjectCreationPolicy(actor, parsed.projectId, tx);
        if (!creationPolicy.canCreate) throw new NotFoundError();
        if (!isCreationColumnAllowed(creationPolicy, selectedColumn.id)) throw new ForbiddenError();
        await validateRequestRecipients(tx, parsed.projectId, audienceUserIds);
        const receipt = await tx.taskMoveOperation.findUnique({ where: { operationId } });
        if (receipt) {
          if (receipt.requestHash !== requestHash) return { conflict: true } as const;
          const stored = z.object({ taskId: z.string(), projectId: z.string(), version: z.literal(0), replayed: z.literal(false) }).strict().safeParse(receipt.response);
          if (!stored.success || stored.data.taskId !== receipt.taskId || stored.data.projectId !== receipt.projectId
            || receipt.projectId !== parsed.projectId) throw new Error("Invalid create receipt");
          return { replay: stored.data } as const;
        }
      }
      const ranks = createBase36RankService();
      const { column, rank } = await prepareLegacyTaskCreation(tx, ranks, {
        actorId: user.id,
        projectId: parsed.projectId,
        columnId: selectedColumn.id,
      });
      if (!operationId) await validateRequestRecipients(tx, parsed.projectId, audienceUserIds);
      if (canonicalCreate) {
        // The creation port holds Project/column locks. Revalidate after waiting
        // so a concurrent administrator change cannot leave a stranded draft.
        const configured = await tx.project.findUnique({ where: { id: parsed.projectId }, select: {
          lifecycleColumnMap: true, columns: { select: { id: true, projectId: true, workflowKey: true } },
        } });
        const map = decodeLifecycleColumnMap(configured?.lifecycleColumnMap ?? null);
        if (!map) throw new LifecycleColumnConfigurationError("LIFECYCLE_COLUMNS_REQUIRED");
        validateLifecycleColumnTargets(map, configured?.columns ?? [], parsed.projectId);
      }
      const lastTask = await tx.task.findFirst({
        where: { projectId: parsed.projectId, columnId: column.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      const created = await tx.task.create({
        data: {
          title: parsed.title,
          description,
          status: derivedTaskStatus(column.workflowKey),
          priority: parsed.priority ?? "MEDIUM",
          projectId: parsed.projectId,
          columnId: column.id,
          position: lastTask ? lastTask.position + 1024 : 1024,
          rank,
          createdById: user.id,
        },
        include: {
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
          _count: {
            select: { messages: true },
          },
        },
      });

      const destination=await tx.project.findUnique({where:{id:parsed.projectId},select:{name:true}});
      const beznalDestination=isBeznalProject(destination?.name);
      if (markedBoard || beznalDestination) {
        // Same transaction as the Task row: no task exists without its marker
        // and no marker without its task. The draft starts private to its author.
        await tx.taskRequest.create({
          data: {
            taskId: created.id,
            contractVersion: 1,
            state: "DRAFT",
            authorId: user.id,
            audienceUserIds,
            ...(beznalDestination?{beznalPhase:"WAITING"}:{}),
          },
        });
      }

      await tx.activity.create({ data: { taskId: created.id, userId: user.id, action: "created" } });
      if (operationId) {
        await tx.taskMoveOperation.create({ data: {
          operationId, taskId: created.id, projectId: created.projectId,
          requestHash: requestHash!, response: { taskId: created.id, projectId: created.projectId, version: 0, replayed: false },
        } });
      }
      return { task: created } as const;
    });
    if ("conflict" in result) return apiError("OPERATION_ID_REUSED", "Operation ID already used", undefined, 409);
    if ("replay" in result) {
      return apiSuccess({ ...result.replay, replayed: true }, undefined, 201);
    }
    const task = result.task;

    // Serialize the committed snapshot before handing independent copies to effects.
    const response = apiSuccess(operationId
      ? { taskId: task.id, projectId: task.projectId, version: task.version, replayed: false }
      : task, undefined, 201);
    const runEffect = async (
      event: "task.create.realtime.failed" | "task.create.automation.failed",
      operation: () => unknown,
    ) => {
      try {
        await operation();
      } catch {
        try {
          await apiLogger.warn({ event, route: "/api/tasks" });
        } catch { /* Diagnostics cannot replace committed success. */ }
      }
    };

    void runEffect("task.create.realtime.failed", () =>
      emitTaskCreated(task.projectId, structuredClone(task)),
    );
    void runEffect("task.create.automation.failed", () =>
      processAutomationRules({
        trigger: "task_created",
        taskId: task.id,
        projectId: task.projectId,
        userId: user.id,
        task: structuredClone(task),
      }),
    );

    return response;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return apiNotFound("Проект не найден");
    }
    if (error instanceof BadRequestError) {
      return apiBadRequest("Колонка не принадлежит этому проекту");
    }
    if (error instanceof LifecycleColumnConfigurationError) return apiError(error.code, "Lifecycle columns are not configured", undefined, 409);
    if (error instanceof TaskRankMaintenanceError) {
      return apiError(error.code, "Создание задачи недоступно", undefined, 409);
    }
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof ForbiddenError) return apiForbidden();
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось создать задачу");
  }
}
