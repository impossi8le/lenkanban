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
  apiNotFound,
  apiForbidden,
  apiBadRequest,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const recurringTask = await prisma.recurringTask.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!recurringTask) {
      return apiNotFound();
    }

    // Check access
    const hasAccess =
      user.globalRole === "ADMIN" ||
      recurringTask.project.ownerId === user.id ||
      recurringTask.project.members.length > 0;

    if (!hasAccess) {
      return apiForbidden("Access denied");
    }

    return apiSuccess(recurringTask);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ event: "recurring.read.failed", err: error });
    return apiInternalError("Failed to fetch recurring task");
  }
}

export function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return withApiLogging(request, (input, context) => updateRecurringTask(input, params, context), { route: "/api/recurring-tasks/:id" });
}

async function updateRecurringTask(request: Request, params: Promise<{ id: string }>, context: RequestLogContext) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    context.actorId = user.id;
    const { id } = await params;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return apiBadRequest("Expected an object");
    }
    const body = json as Partial<Prisma.RecurringTaskUncheckedCreateInput>;

    return await prisma.$transaction(async tx => {
      const lockedProjects = await tx.$queryRaw<{ id: string }[]>`
        SELECT p."id"
        FROM "Project" AS p
        JOIN "RecurringTask" AS r ON r."projectId" = p."id"
        WHERE r."id" = ${id}
        FOR UPDATE OF p
      `;
      if (lockedProjects.length === 0) {
        return apiNotFound();
      }
      const lockedSchedules = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "RecurringTask"
        WHERE "id" = ${id} AND "projectId" = ${lockedProjects[0].id}
        FOR UPDATE
      `;
      if (lockedSchedules.length === 0) {
        return apiNotFound();
      }
      const recurringTask = await tx.recurringTask.findUnique({
        where: { id },
        include: {
          project: {
            select: {
              ownerId: true,
              members: {
                where: { userId: user.id },
                select: { userId: true },
              },
            },
          },
        },
      });
  
      if (!recurringTask) {
        return apiNotFound();
      }
  
      // Check access
      const hasAccess =
        user.globalRole === "ADMIN" ||
        recurringTask.project.ownerId === user.id ||
        recurringTask.project.members.length > 0;
  
      if (!hasAccess) {
        return apiForbidden("Access denied");
      }
  
      // Preserve nextRunAt for edits that do not change or reactivate the schedule.
      let nextRunAt: Date | undefined;
      let schedule: RecurringSchedule | undefined;
      let active = body.active;
      const scheduleChanged = (["frequency", "interval", "daysOfWeek", "dayOfMonth", "startDate", "endDate"] as const)
        .some(key => body[key] !== undefined);
      const reactivated = body.active === true && recurringTask.active === false;
      if (scheduleChanged || reactivated) {
        try {
          schedule = normalizeRecurringSchedule({
            frequency: body.frequency === undefined ? recurringTask.frequency : body.frequency,
            interval: body.interval === undefined ? recurringTask.interval : body.interval,
            daysOfWeek: body.daysOfWeek === undefined ? recurringTask.daysOfWeek : body.daysOfWeek,
            dayOfMonth: body.dayOfMonth === undefined ? recurringTask.dayOfMonth : body.dayOfMonth,
            startDate: body.startDate === undefined ? recurringTask.startDate : body.startDate,
            endDate: body.endDate === undefined ? recurringTask.endDate : body.endDate,
          });
        } catch {
          return apiBadRequest("Invalid recurring schedule");
        }
        let calendarChanged = true;
        try {
          const previous = normalizeRecurringSchedule(recurringTask);
          calendarChanged = previous.frequency !== schedule.frequency || previous.interval !== schedule.interval ||
            previous.startDate.getTime() !== schedule.startDate.getTime() || previous.endDate?.getTime() !== schedule.endDate?.getTime() ||
            previous.dayOfMonth !== schedule.dayOfMonth || previous.daysOfWeek.join(",") !== schedule.daysOfWeek.join(",");
        } catch { /* An explicitly supplied valid schedule may repair legacy data. */ }
        const storedOccurrenceValid = firstRecurringOccurrence(schedule, recurringTask.nextRunAt)?.getTime() === recurringTask.nextRunAt.getTime();
        if (calendarChanged || reactivated || !storedOccurrenceValid) {
          const candidate = firstRecurringOccurrence(schedule, new Date());
          if (!candidate && (body.active === undefined ? recurringTask.active : body.active) !== false) {
            return apiBadRequest("Schedule has no future occurrence");
          }
          if (candidate) {
            nextRunAt = candidate;
          } else {
            active = false;
          }
        }
      }
  
      const updated = await tx.recurringTask.update({
        where: { id },
        data: {
          name: body.name,
          description: body.description,
          taskTitle: body.taskTitle,
          taskDescription: body.taskDescription,
          priority: body.priority,
          tags: body.tags,
          checklistItems: body.checklistItems,
          assigneeIds: body.assigneeIds,
          frequency: schedule?.frequency,
          interval: schedule?.interval,
          daysOfWeek: schedule?.daysOfWeek,
          dayOfMonth: schedule?.dayOfMonth,
          startDate: schedule?.startDate,
          endDate: schedule ? schedule.endDate : undefined,
          active,
          ...(nextRunAt !== undefined ? { nextRunAt } : {}),
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
  
      return apiSuccess(updated);
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ ...context, event: "recurring.update.failed", err: error });
    return apiInternalError("Failed to update recurring task");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id } = await params;

    const recurringTask = await prisma.recurringTask.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            ownerId: true,
            members: {
              where: { userId: user.id },
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!recurringTask) {
      return apiNotFound();
    }

    // Check access
    const hasAccess =
      user.globalRole === "ADMIN" ||
      recurringTask.project.ownerId === user.id ||
      recurringTask.project.members.length > 0;

    if (!hasAccess) {
      return apiForbidden("Access denied");
    }

    await prisma.recurringTask.delete({
      where: { id },
    });

    return apiSuccess({ success: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    apiLogger.error({ event: "recurring.delete.failed", err: error });
    return apiInternalError("Failed to delete recurring task");
  }
}
