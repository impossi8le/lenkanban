import type { Prisma } from "@prisma/client";
import { decodeLifecycleColumnMap, lifecycleColumnFields } from "@/lib/task-request-columns";

export type ColumnDeletionErrorCode =
  | "COLUMN_NOT_FOUND"
  | "LAST_COLUMN"
  | "LIFECYCLE_COLUMN"
  | "COLUMN_NOT_EMPTY";

export class ColumnDeletionError extends Error {
  constructor(readonly code: ColumnDeletionErrorCode) {
    super(code);
    this.name = "ColumnDeletionError";
  }
}

export interface ColumnDeletionPort {
  lockProject(projectId: string): Promise<void>;
  lockColumn(projectId: string, columnId: string): Promise<boolean>;
  countColumns(projectId: string): Promise<number>;
  countTasks(projectId: string, columnId: string): Promise<number>;
  deleteColumn(columnId: string): Promise<void>;
}

export function createColumnDeletionPort(
  client: Prisma.TransactionClient,
): ColumnDeletionPort {
  return {
    async lockProject(projectId) {
      await client.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Project"
        WHERE "id" = ${projectId}
        FOR UPDATE
      `;
    },
    async lockColumn(projectId, columnId) {
      const columns = await client.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "ProjectColumn"
        WHERE "id" = ${columnId}
          AND "projectId" = ${projectId}
        FOR UPDATE
      `;
      return columns.length > 0;
    },
    countColumns(projectId) {
      return client.projectColumn.count({
        where: { projectId },
      });
    },
    countTasks(projectId, columnId) {
      return client.task.count({
        where: { projectId, columnId },
      });
    },
    async deleteColumn(columnId) {
      const column = await client.projectColumn.findUnique({ where: { id: columnId }, select: { projectId: true } });
      if (!column) throw new ColumnDeletionError("COLUMN_NOT_FOUND");
      const project = await client.project.findUnique({ where: { id: column.projectId }, select: { lifecycleColumnMap: true } });
      const map = decodeLifecycleColumnMap(project?.lifecycleColumnMap ?? null);
      if (map && lifecycleColumnFields.some(key => map[key] === columnId)) throw new ColumnDeletionError("LIFECYCLE_COLUMN");
      await client.projectColumn.delete({
        where: { id: columnId },
      });
    },
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2003"
  );
}

export async function deleteProjectColumn(input: {
  projectId: string;
  columnId: string;
  port: ColumnDeletionPort;
}): Promise<void> {
  await input.port.lockProject(input.projectId);
  const columnExists = await input.port.lockColumn(
    input.projectId,
    input.columnId,
  );
  if (!columnExists) {
    throw new ColumnDeletionError("COLUMN_NOT_FOUND");
  }

  const columnCount = await input.port.countColumns(input.projectId);
  if (columnCount <= 1) {
    throw new ColumnDeletionError("LAST_COLUMN");
  }

  const taskCount = await input.port.countTasks(
    input.projectId,
    input.columnId,
  );
  if (taskCount > 0) {
    throw new ColumnDeletionError("COLUMN_NOT_EMPTY");
  }

  try {
    await input.port.deleteColumn(input.columnId);
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new ColumnDeletionError("COLUMN_NOT_EMPTY");
    }
    throw error;
  }
}
