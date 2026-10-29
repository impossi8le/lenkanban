import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { apiLogger } from "@/lib/logger";
import type { RequestLogContext } from "@/lib/request-context";
import { withApiLogging } from "@/middleware/api-logger";
import { normalizeRecurringSchedule, firstRecurringOccurrence, type RecurringSchedule } from "@/lib/recurring-schedule";
import {
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiForbidden,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return apiBadRequest("projectId is required");
    }

    // Check if user has access to this project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
    });

    if (!project && user.globalRole !== "ADMIN") {
      return apiForbidden("Access denied");
    }

    const recurringTasks = await prisma.recurringTask.findMany({
      where: { projectId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return apiSuccess(recurringTasks);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ event: "recurring.list.failed", err: error });
    return apiInternalError("Failed to fetch recurring tasks");
  }
}

export function POST(request: Request) {
  return withApiLogging(request, createRecurringTask, { route: "/api/recurring-tasks" });
}

async function createRecurringTask(request: Request, context: RequestLogContext) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    context.actorId = user.id;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return apiBadRequest("Expected an object");
    }
    const body = json as Partial<Prisma.RecurringTaskUncheckedCreateInput>;

    const {
      projectId,
      name,
      description,
      taskTitle,
      taskDescription,
      priority,
      tags,
      checklistItems,
      assigneeIds,
      frequency,
      interval,
      daysOfWeek,
      dayOfMonth,
      startDate,
      endDate,
    } = body;

    if (!projectId || !name || !taskTitle || !frequency || !startDate) {
      return apiBadRequest("Missing required fields");
    }

    // Check if user has access to this project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
    });

    if (!project && user.globalRole !== "ADMIN") {
      return apiForbidden("Access denied");
    }

    let schedule: RecurringSchedule;
    try {
      schedule = normalizeRecurringSchedule({ frequency, interval, daysOfWeek, dayOfMonth, startDate, endDate });
    } catch {
      return apiBadRequest("Invalid recurring schedule");
    }
    const nextRunAt = firstRecurringOccurrence(schedule, new Date());
    if (!nextRunAt) return apiBadRequest("Schedule has no future occurrence");

    const recurringTask = await prisma.recurringTask.create({
      data: {
        projectId,
        name,
        description: description || null,
        taskTitle,
        taskDescription: taskDescription || null,
        priority: priority || "MEDIUM",
        tags: tags || [],
        checklistItems: checklistItems || [],
        assigneeIds: assigneeIds || [],
        frequency: schedule.frequency,
        interval: schedule.interval,
        daysOfWeek: schedule.daysOfWeek,
        dayOfMonth: schedule.dayOfMonth,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        nextRunAt,
        createdById: user.id,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return apiSuccess(recurringTask, undefined, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ ...context, event: "recurring.create.failed", err: error });
    return apiInternalError("Failed to create recurring task");
  }
}
