import { describe, expect, it } from "vitest";
import {
  ColumnDeletionError,
  createColumnDeletionPort,
  deleteProjectColumn,
  type ColumnDeletionPort,
} from "./column-deletion";

function createPort(input?: {
  columnExists?: boolean;
  columnCount?: number;
  taskCount?: number;
  deleteError?: unknown;
}) {
  const events: string[] = [];
  const port: ColumnDeletionPort = {
    async lockProject() {
      events.push("lock:project");
    },
    async lockColumn() {
      events.push("lock:column");
      return input?.columnExists ?? true;
    },
    async countColumns() {
      events.push("count:columns");
      return input?.columnCount ?? 2;
    },
    async countTasks() {
      events.push("count:tasks");
      return input?.taskCount ?? 0;
    },
    async deleteColumn() {
      events.push("delete");
      if (input?.deleteError !== undefined) {
        throw input.deleteError;
      }
    },
  };
  return { events, port };
}

describe("serialized project column deletion", () => {
  it("rejects deletion of an empty mapped lifecycle column under project/column locks", async () => {
    const queries: string[] = [];
    let deleted = false;
    const map = { contractVersion: 1, submittedColumnId: "new", inProgressColumnId: "work", needsInfoColumnId: "wait", completedColumnId: "resolved", closedColumnId: "closed" };
    const client = {
      $queryRaw: async (sql: TemplateStringsArray) => { queries.push(sql.join("?")); return [{ id: "wait" }]; },
      projectColumn: { findUnique: async () => ({ projectId: "board" }), count: async () => 5, delete: async () => { deleted = true; } },
      project: { findUnique: async () => ({ lifecycleColumnMap: map }) }, task: { count: async () => 0 },
    };
    await expect(deleteProjectColumn({ projectId: "board", columnId: "wait", port: createColumnDeletionPort(client as never) })).rejects.toMatchObject({ code: "LIFECYCLE_COLUMN" });
    expect(deleted).toBe(false);
    expect(queries[0]).toContain('FROM "Project"'); expect(queries[1]).toContain('FROM "ProjectColumn"');
  });
  it("locks project and column before rechecking and deleting", async () => {
    const { events, port } = createPort();

    await expect(
      deleteProjectColumn({
        projectId: "project-1",
        columnId: "column-1",
        port,
      }),
    ).resolves.toBeUndefined();
    expect(events).toEqual([
      "lock:project",
      "lock:column",
      "count:columns",
      "count:tasks",
      "delete",
    ]);
  });

  it("rejects a missing column while holding the project lock", async () => {
    const { events, port } = createPort({ columnExists: false });

    await expect(
      deleteProjectColumn({
        projectId: "project-1",
        columnId: "missing",
        port,
      }),
    ).rejects.toMatchObject({ code: "COLUMN_NOT_FOUND" });
    expect(events).toEqual(["lock:project", "lock:column"]);
  });

  it("rejects deletion of the last project column", async () => {
    const { events, port } = createPort({ columnCount: 1 });

    await expect(
      deleteProjectColumn({
        projectId: "project-1",
        columnId: "column-1",
        port,
      }),
    ).rejects.toMatchObject({ code: "LAST_COLUMN" });
    expect(events).toEqual([
      "lock:project",
      "lock:column",
      "count:columns",
    ]);
  });

  it("rejects a canonical non-empty column", async () => {
    const { events, port } = createPort({ taskCount: 1 });

    await expect(
      deleteProjectColumn({
        projectId: "project-1",
        columnId: "column-1",
        port,
      }),
    ).rejects.toMatchObject({ code: "COLUMN_NOT_EMPTY" });
    expect(events).toEqual([
      "lock:project",
      "lock:column",
      "count:columns",
      "count:tasks",
    ]);
  });

  it("maps a foreign-key race during delete to COLUMN_NOT_EMPTY", async () => {
    const { port } = createPort({
      deleteError: { code: "P2003" },
    });

    await expect(
      deleteProjectColumn({
        projectId: "project-1",
        columnId: "column-1",
        port,
      }),
    ).rejects.toEqual(
      new ColumnDeletionError("COLUMN_NOT_EMPTY"),
    );
  });

  it("adapts a Prisma transaction to scoped project and column locks", async () => {
    const queries: string[] = [];
    const client = {
      async $queryRaw(query: TemplateStringsArray) {
        const sql = query.join("?");
        queries.push(sql);
        return [{ id: "locked" }];
      },
      projectColumn: {
        findUnique: async () => ({ projectId: "project-1" }),
        count: async () => 2,
        delete: async () => ({ id: "column-1" }),
      },
      task: {
        count: async () => 0,
      },
      project: { findUnique: async () => ({ lifecycleColumnMap: null }) },
    };
    const port = createColumnDeletionPort(client as never);

    await port.lockProject("project-1");
    await expect(
      port.lockColumn("project-1", "column-1"),
    ).resolves.toBe(true);
    await expect(port.countColumns("project-1")).resolves.toBe(2);
    await expect(
      port.countTasks("project-1", "column-1"),
    ).resolves.toBe(0);
    await expect(port.deleteColumn("column-1")).resolves.toBeUndefined();

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('FROM "Project"');
    expect(queries[0]).toContain("FOR UPDATE");
    expect(queries[1]).toContain('FROM "ProjectColumn"');
    expect(queries[1]).toContain('"projectId"');
    expect(queries[1]).toContain("FOR UPDATE");
  });
});
