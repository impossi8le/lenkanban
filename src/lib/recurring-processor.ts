import type { Prisma, PrismaClient, RecurringTask } from "@prisma/client";
import { ForbiddenError } from "./errors";
import { getProjectCreationPolicy } from "./project-creation-policy";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import {
  allocateAppendRank,
  createGuardedAppendTaskRankPort,
} from "@/features/kanban/server/append-task-rank";
import { derivedTaskStatus } from "@/features/kanban/server/move-contract";
import {
  firstRecurringOccurrence,
  nextRecurringOccurrence,
  normalizeRecurringSchedule,
} from "./recurring-schedule";

const completeTaskInclude = {
  assignees: {
    include: {
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
  },
  tags: { include: { tag: true } },
  checklistItems: { orderBy: { position: "asc" } },
} satisfies Prisma.TaskInclude;

export type CompleteRecurringTask = Prisma.TaskGetPayload<{
  include: typeof completeTaskInclude;
}>;

export interface RecurringOccurrenceCandidate {
  id: string;
  projectId: string;
  scheduledAt: Date;
}

export type RecurringOccurrenceResult =
  | {
      status: "created";
      recurringTaskId: string;
      projectId: string;
      task: CompleteRecurringTask;
    }
  | {
      status: "already_processed";
      recurringTaskId: string;
      taskId: string | null;
    }
  | { status: "expired"; recurringTaskId: string }
  | {
      status: "skipped";
      recurringTaskId: string;
      reason: "missing" | "inactive" | "changed" | "not_due" | "missing_column";
    };

export class RecurringProcessingError extends Error {
  constructor(readonly code: "INVALID_TEMPLATE" | "INVALID_STORED_OCCURRENCE") {
    super(code);
    this.name = "RecurringProcessingError";
  }
}

function normalizeTemplateArrays(template: Pick<RecurringTask, "tags" | "assigneeIds" | "checklistItems">): {
  tags: string[];
  assigneeIds: string[];
  checklistItems: { text: string }[];
} {
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
      throw new RecurringProcessingError("INVALID_TEMPLATE");
    }
    // Duplicate names/IDs in legacy JSON represent the same relation.
    return [...new Set(value as string[])];
  };
  const tags = strings(template.tags);
  const assigneeIds = strings(template.assigneeIds);
  if (!Array.isArray(template.checklistItems)) {
    throw new RecurringProcessingError("INVALID_TEMPLATE");
  }
  const checklistItems = template.checklistItems.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.text !== "string"
      || (item.completed !== undefined && typeof item.completed !== "boolean")) {
      throw new RecurringProcessingError("INVALID_TEMPLATE");
    }
    return { text: item.text };
  });
  return { tags, assigneeIds, checklistItems };
}

/** One candidate, one transaction. Network/realtime work belongs after commit. */
export async function processRecurringOccurrence({
  database,
  candidate,
  now,
}: {
  database: Pick<PrismaClient, "$transaction">;
  candidate: RecurringOccurrenceCandidate;
  now: Date;
}): Promise<RecurringOccurrenceResult> {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(candidate.scheduledAt.getTime())) {
    throw new RecurringProcessingError("INVALID_STORED_OCCURRENCE");
  }

  return database.$transaction(async tx => {
    // Existing rank allocation also locks Project -> ProjectColumn. Acquire
    // Project before the schedule so project deletion cannot invert that order.
    const projects = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Project" WHERE "id" = ${candidate.projectId} FOR UPDATE
    `;
    if (projects.length === 0) {
      return { status: "skipped", recurringTaskId: candidate.id, reason: "missing" };
    }
    const schedules = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "RecurringTask"
      WHERE "id" = ${candidate.id} AND "projectId" = ${candidate.projectId}
      FOR UPDATE
    `;
    if (schedules.length === 0) {
      return { status: "skipped", recurringTaskId: candidate.id, reason: "missing" };
    }

    // Never use the template copied by the initial due-list query. PATCH and
    // concurrent processors serialize on this row; all decisions use fresh data.
    const recurringTask = await tx.recurringTask.findUnique({ where: { id: candidate.id } });
    if (!recurringTask || recurringTask.projectId !== candidate.projectId) {
      return { status: "skipped", recurringTaskId: candidate.id, reason: "missing" };
    }
    if (!recurringTask.active) {
      return { status: "skipped", recurringTaskId: candidate.id, reason: "inactive" };
    }
    if (recurringTask.nextRunAt.getTime() !== candidate.scheduledAt.getTime()) {
      return { status: "skipped", recurringTaskId: candidate.id, reason: "changed" };
    }
    if (recurringTask.nextRunAt > now) {
      return { status: "skipped", recurringTaskId: candidate.id, reason: "not_due" };
    }

    const schedule = normalizeRecurringSchedule(recurringTask);
    if (schedule.endDate && recurringTask.nextRunAt > schedule.endDate) {
      await tx.recurringTask.update({ where: { id: candidate.id }, data: { active: false } });
      return { status: "expired", recurringTaskId: candidate.id };
    }
    if (firstRecurringOccurrence(schedule, recurringTask.nextRunAt)?.getTime() !== recurringTask.nextRunAt.getTime()) {
      throw new RecurringProcessingError("INVALID_STORED_OCCURRENCE");
    }
    const nextRunAt = nextRecurringOccurrence(schedule, recurringTask.nextRunAt);
    const occurrence = await tx.recurringTaskOccurrence.findUnique({
      where: {
        recurringTaskId_scheduledAt: {
          recurringTaskId: candidate.id,
          scheduledAt: recurringTask.nextRunAt,
        },
      },
    });
    if (occurrence) {
      // A historical pointer reset is not a new occurrence, even when the Task
      // has since been deleted (receipt.taskId is then null).
      await tx.recurringTask.update({
        where: { id: candidate.id },
        data: { nextRunAt: nextRunAt ?? recurringTask.nextRunAt, active: nextRunAt !== null },
      });
      return { status: "already_processed", recurringTaskId: candidate.id, taskId: occurrence.taskId };
    }

    const template = normalizeTemplateArrays(recurringTask);
    const actor = await tx.user.findUnique({ where: { id: recurringTask.createdById }, select: { id: true, globalRole: true } });
    if (!actor) throw new ForbiddenError();
    const creationPolicy = await getProjectCreationPolicy(actor, recurringTask.projectId, tx);
    if (!creationPolicy.canCreate || creationPolicy.allowedColumnIds?.length === 0) throw new ForbiddenError();
    const firstColumn = await tx.projectColumn.findFirst({
      where: { projectId: recurringTask.projectId, ...(creationPolicy.allowedColumnIds === null ? {} : { id: creationPolicy.allowedColumnIds[0] }) },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true, workflowKey: true },
    });
    if (!firstColumn) {
      return { status: "skipped", recurringTaskId: candidate.id, reason: "missing_column" };
    }
    const ranks = createBase36RankService();
    const rank = await allocateAppendRank({
      columnId: firstColumn.id,
      port: createGuardedAppendTaskRankPort(tx, ranks),
      ranks,
    });
    const lastTask = await tx.task.findFirst({
      where: { columnId: firstColumn.id },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const task = await tx.task.create({
      data: {
        title: recurringTask.taskTitle,
        description: recurringTask.taskDescription,
        priority: recurringTask.priority,
        status: derivedTaskStatus(firstColumn.workflowKey),
        position: lastTask ? lastTask.position + 1 : 0,
        rank,
        projectId: recurringTask.projectId,
        columnId: firstColumn.id,
        createdById: recurringTask.createdById,
      },
    });
    if (template.checklistItems.length > 0) {
      await tx.taskChecklistItem.createMany({
        data: template.checklistItems.map((item, position) => ({
          taskId: task.id,
          text: item.text,
          completed: false,
          position,
        })),
      });
    }
    for (const name of template.tags) {
      const colors = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981", "#06b6d4", "#3b82f6", "#0ea5e9", "#ec4899"];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const tag = await tx.tag.upsert({
        where: { projectId_name: { projectId: recurringTask.projectId, name } },
        create: { projectId: recurringTask.projectId, name, color },
        update: {},
      });
      await tx.taskTag.create({ data: { taskId: task.id, tagId: tag.id } });
    }
    if (template.assigneeIds.length > 0) {
      await tx.taskAssignee.createMany({
        data: template.assigneeIds.map(userId => ({ taskId: task.id, userId })),
      });
    }
    await tx.recurringTaskOccurrence.create({
      data: { recurringTaskId: candidate.id, scheduledAt: recurringTask.nextRunAt, taskId: task.id },
    });
    await tx.recurringTask.update({
      where: { id: candidate.id },
      data: {
        lastRunAt: now,
        nextRunAt: nextRunAt ?? recurringTask.nextRunAt,
        active: nextRunAt !== null,
      },
    });
    const completeTask = await tx.task.findUniqueOrThrow({
      where: { id: task.id },
      include: completeTaskInclude,
    });
    return {
      status: "created",
      recurringTaskId: candidate.id,
      projectId: recurringTask.projectId,
      task: completeTask,
    };
  });
}
