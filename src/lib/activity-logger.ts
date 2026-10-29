import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { dbLogger } from "./logger";

export interface LogActivityParams {
  taskId: string;
  userId: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export type ActivityWriter = Pick<
  Prisma.TransactionClient,
  "activity"
>;

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function logActivityWithClient(
  client: ActivityWriter,
  {
    taskId,
    userId,
    action,
    oldValue,
    newValue,
  }: LogActivityParams,
): Promise<void> {
  await client.activity.create({
    data: {
      taskId,
      userId,
      action,
      oldValue: toJsonValue(oldValue),
      newValue: toJsonValue(newValue),
    },
  });
}

export async function logActivity(
  params: LogActivityParams,
): Promise<void> {
  try {
    await logActivityWithClient(prisma, params);
  } catch (error) {
    dbLogger.error(
      {
        taskId: params.taskId,
        userId: params.userId,
        action: params.action,
        err: error,
      },
      "Failed to log activity",
    );
    // Don't throw - activity logging should not break the main operation
  }
}

export { getActivityDescription } from "./activity-description";
export type { ActivityValue } from "./activity-description";
