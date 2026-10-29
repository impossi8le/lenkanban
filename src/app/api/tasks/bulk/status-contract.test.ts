import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRelocationError } from "@/features/kanban/server/task-relocation";

const mocks = vi.hoisted(() => ({
  automation: vi.fn(),
  emitTaskMoved: vi.fn(),
  emitTaskUpdated: vi.fn(),
  getServerSession: vi.fn(),
  prismaTaskFindMany: vi.fn(),
  prismaTaskFindFirst: vi.fn(),
  prismaTransaction: vi.fn(),
  rateLimitOrThrowKey: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));
vi.mock("@/lib/nextauth", () => ({
  nextAuthOptions: {},
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: {
      findMany: mocks.prismaTaskFindMany,
      findFirst: mocks.prismaTaskFindFirst,
    },
    $transaction: mocks.prismaTransaction,
  },
}));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: mocks.rateLimitOrThrowKey,
  rateLimitErrorResponse: vi.fn(),
}));
vi.mock("@/socket/board-events", () => ({
  emitTaskMoved: mocks.emitTaskMoved,
  emitTaskUpdated: mocks.emitTaskUpdated,
}));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processBulkMoveAutomation: mocks.automation,
}));

import { POST as bulkUpdatePost } from "../bulk-update/route";
import { PATCH as bulkPatch } from "./route";
import { PATCH as taskPatch } from "../[id]/route";

function requestWithJson(value: unknown): Request {
  return new Request("http://localhost/api/tasks/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("bulk task status contract", () => {
  beforeEach(() => {
    mocks.prismaTaskFindMany.mockReset();
    mocks.prismaTransaction.mockReset();
    mocks.emitTaskUpdated.mockReset();
    mocks.emitTaskMoved.mockReset();
    mocks.getServerSession.mockResolvedValue({
      user: { id: "user-1" },
    });
    mocks.requireApiUser.mockResolvedValue({
      id: "user-1",
      globalRole: "ADMIN",
    });
    mocks.rateLimitOrThrowKey.mockResolvedValue(undefined);
  });

  it.each(["PATCH", "POST"].flatMap(method => ["REQUEST_LIFECYCLE_NOT_ENABLED", "INVALID_REQUEST_MARKER"].map(code => ({ method, code }))))("maps $method canonical $code to409 without postcommit effects", async ({ method, code }) => {
    mocks.prismaTaskFindMany.mockResolvedValue([{ id: "cm0000000000000000000001", projectId: "project-1", columnId: "column-1", status: "TODO", version: 4, project: { id: "project-1", ownerId: "user-1", members: [] } }]);
    mocks.prismaTransaction.mockRejectedValue(new TaskRelocationError(code as "REQUEST_LIFECYCLE_NOT_ENABLED" | "INVALID_REQUEST_MARKER"));
    const request = requestWithJson({ taskIds: ["cm0000000000000000000001"], updates: { columnId: "column-2" } });
    const response = method === "PATCH" ? await bulkPatch(request) : await bulkUpdatePost(request as never);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code } }); expect(mocks.emitTaskMoved).not.toHaveBeenCalled(); expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
    expect(mocks.automation).not.toHaveBeenCalled();
  });

  it("maps single-task PATCH INVALID_MOVE_ROUTE to typed 422 without effects", async () => {
    mocks.prismaTaskFindFirst.mockResolvedValue({ id: "task", projectId: "project-1", columnId: "column-1", status: "TODO", version: 4 });
    mocks.prismaTransaction.mockRejectedValue(new TaskRelocationError("INVALID_MOVE_ROUTE"));
    const response = await taskPatch(requestWithJson({ columnId: "column-2" }), { params: Promise.resolve({ id: "task" }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_MOVE_ROUTE" } });
    expect(mocks.emitTaskMoved).not.toHaveBeenCalled(); expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
    expect(mocks.automation).not.toHaveBeenCalled();
  });

  it.each(["PATCH", "POST"])("maps %s INVALID_MOVE_ROUTE to typed 422 without effects", async method => {
    mocks.prismaTaskFindMany.mockResolvedValue([{ id: "cm0000000000000000000001", projectId: "project-1", columnId: "column-1", status: "TODO", version: 4, project: { id: "project-1", ownerId: "user-1", members: [] } }]);
    mocks.prismaTransaction.mockRejectedValue(new TaskRelocationError("INVALID_MOVE_ROUTE"));
    const request = requestWithJson({ taskIds: ["cm0000000000000000000001"], updates: { columnId: "column-2" } });
    const response = method === "PATCH" ? await bulkPatch(request) : await bulkUpdatePost(request as never);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_MOVE_ROUTE" } });
    expect(mocks.emitTaskMoved).not.toHaveBeenCalled(); expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
    expect(mocks.automation).not.toHaveBeenCalled();
  });

  it("rejects standalone status in PATCH /api/tasks/bulk with a stable 422", async () => {
    const response = await bulkPatch(
      requestWithJson({
        taskIds: ["cm0000000000000000000001"],
        updates: { status: "DONE" },
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "STATUS_REQUIRES_COLUMN" },
    });
  });

  it("rejects standalone status in POST /api/tasks/bulk-update with a stable 422", async () => {
    const response = await bulkUpdatePost(
      requestWithJson({
        taskIds: ["task-1"],
        updates: { status: "DONE" },
      }) as never,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "STATUS_REQUIRES_COLUMN" },
    });
  });

  it.each([
    {
      name: "PATCH /api/tasks/bulk",
      invoke: (request: Request) => bulkPatch(request),
    },
    {
      name: "POST /api/tasks/bulk-update",
      invoke: (request: Request) => bulkUpdatePost(request as never),
    },
  ])("accepts CRITICAL priority through $name", async ({ invoke }) => {
    const task = {
      id: "cm0000000000000000000001",
      projectId: "project-1",
      columnId: "column-1",
      status: "TODO",
      priority: "MEDIUM",
      version: 4,
      project: {
        id: "project-1",
        ownerId: "user-1",
        members: [],
      },
    };
    const updatedTask = { ...task, priority: "CRITICAL" };
    mocks.prismaTaskFindMany
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([updatedTask]);
    const update = vi.fn().mockResolvedValue(updatedTask);
    const tx = {
      async $queryRaw(query: TemplateStringsArray) {
        const sql = query.join("?");
        if (sql.includes('FROM "Project"')) return [{ id: task.projectId }];
        if (sql.includes('FROM "Task"')) return [{ id: task.id, projectId: task.projectId, priority: task.priority, version: task.version }];
        if (sql.includes('FROM "User"')) return [{ id: "user-1" }];
        throw new Error("Unexpected scalar batch lock");
      },
      user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "ADMIN" }) },
      project: { findUnique: vi.fn().mockResolvedValue({ id: task.projectId, ownerId: "user-1", members: [] }) },
      taskRequest: { findMany: vi.fn().mockResolvedValue([]) },
      task: { update, findMany: vi.fn().mockResolvedValue([updatedTask]) },
      activity: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    mocks.prismaTransaction.mockImplementation(
      async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
    );

    const response = await invoke(
      requestWithJson({
        taskIds: [task.id],
        updates: { priority: "CRITICAL" },
      }),
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: task.id },
        data: { priority: "CRITICAL" },
      }),
    );
  });

  it.each([
    {
      name: "PATCH /api/tasks/bulk",
      invoke: (request: Request) => bulkPatch(request),
    },
    {
      name: "POST /api/tasks/bulk-update",
      invoke: (request: Request) => bulkUpdatePost(request as never),
    },
  ])(
    "moves tasks through a transaction with derived status and append ordering in $name",
    async ({ invoke }) => {
      const task = {
        id: "cm0000000000000000000001",
        projectId: "project-1",
        columnId: "column-1",
        status: "TODO",
        priority: "MEDIUM",
        version: 4,
        project: {
          id: "project-1",
          ownerId: "user-1",
          members: [],
        },
      };
      const updatedTask = {
        ...task,
        columnId: "column-2",
        status: "IN_REVIEW",
        rank: "0|QZZZZZZZZZZZZZZZZZZZ",
        position: 3072,
        version: 5,
      };
      mocks.prismaTaskFindMany
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([updatedTask]);

      const update = vi.fn().mockResolvedValue(updatedTask);
      const tx = {
        user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "ADMIN" }) },
        taskRequest: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
        async $queryRaw(query: TemplateStringsArray, value: string) {
          const sql = query.join("?");
          if (sql.includes('FROM "Task"')) {
            return [
              {
                id: value,
                projectId: "project-1",
                columnId: "column-1",
                version: 4,
                status: "TODO",
              },
            ];
          }
          if (sql.includes('"workflowKey"')) {
            return [
              {
                id: value,
                projectId: "project-1",
                workflowKey: "REVIEW",
              },
            ];
          }
          if (sql.includes('FROM "ProjectColumn"')) {
            return [{ id: value, projectId: "project-1" }];
          }
          return [{ id: value }];
        },
        task: {
          async findFirst(input: {
            orderBy: { rank?: "desc"; position?: "desc" };
          }) {
            return "position" in input.orderBy
              ? { position: 2048 }
              : { rank: "0|HZZZZZZZZZZZZZZZZZZZ" };
          },
          async findMany() {
            return [updatedTask];
          },
          update,
          async findUnique() {
            return updatedTask;
          },
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            ...updatedTask,
          }),
        },
        project: {
          findUnique: vi.fn().mockResolvedValue({ id: "project-1", ownerId: "user-1", members: [] }),
          update: vi.fn().mockResolvedValue({ boardRevision: 8 }),
        },
        activity: {
          create: vi.fn().mockResolvedValue({}),
        },
      };
      mocks.prismaTransaction.mockImplementation(
        async (operation: (client: typeof tx) => unknown) => operation(tx),
      );

      const response = await invoke(
        requestWithJson({
          taskIds: [task.id],
          updates: {
            status: "DONE",
            columnId: "column-2",
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks.prismaTransaction).toHaveBeenCalledOnce();
      expect(tx.task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: task.id,
            version: 4,
          }),
          data: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
      expect(tx.project.update).toHaveBeenCalledOnce();
      expect(mocks.emitTaskMoved).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({
          boardRevision: 8,
          task: expect.objectContaining({
            id: task.id,
            columnId: "column-2",
            version: 5,
          }),
        }),
      );
    },
  );

  it("captures final PATCH results inside transaction before commit without a global response reread", async () => {
    const task = {
      id: "cm0000000000000000000001",
      projectId: "project-1",
      columnId: "column-1",
      status: "TODO",
      priority: "MEDIUM",
      version: 4,
      project: {
        id: "project-1",
        ownerId: "user-1",
        members: [],
      },
    };
    const columns = [
      { id: "column-1", projectId: "project-1", name: "Source", workflowKey: "TODO", position: 10 },
      { id: "column-2", projectId: "project-1", name: "Destination", workflowKey: "DONE", position: 30 },
    ];
    const transactionTimeTask = {
      ...task,
      columnId: "column-2",
      status: "DONE",
      rank: "0|QZZZZZZZZZZZZZZZZZZZ",
      position: 3072,
    };
    const postRebalanceTask = {
      ...transactionTimeTask,
      rank: "0|BZZZZZZZZZZZZZZZZZZZ",
    };
    mocks.prismaTaskFindMany
      .mockResolvedValueOnce([task])
      .mockRejectedValue(new Error("Unexpected global response reread"));

    let transactionActive = false;
    const responseSnapshot = vi.fn(async () => {
      expect(transactionActive).toBe(true);
      return [postRebalanceTask];
    });

    const tx = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "ADMIN" }) },
      taskRequest: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      async $queryRaw(query: TemplateStringsArray, value: string) {
        const sql = query.join("?");
        if (sql.includes('FROM "Task"')) {
          return [
            {
              id: value,
              projectId: "project-1",
              columnId: "column-1",
              status: "TODO",
              version: 4,
            },
          ];
        }
        if (sql.includes('"workflowKey"')) {
          return columns.filter(c => c.id === value).map(column => ({
            ...column,
            precedingColumnId: columns.filter(c => c.projectId === column.projectId && c.position < column.position)
              .sort((a, b) => b.position - a.position)[0]?.id ?? null,
          }));
        }
        if (sql.includes('FROM "ProjectColumn"')) {
          return [{ id: value, projectId: "project-1" }];
        }
        return [{ id: value }];
      },
      task: {
        async findFirst(input: {
          orderBy: { rank?: "desc"; position?: "desc" };
        }) {
          return "position" in input.orderBy
            ? { position: 2048 }
            : { rank: "0|HZZZZZZZZZZZZZZZZZZZ" };
        },
        findMany: responseSnapshot,
        update: vi.fn().mockResolvedValue(transactionTimeTask),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(transactionTimeTask),
      },
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "project-1", ownerId: "user-1", members: [] }),
        update: vi.fn().mockResolvedValue({ boardRevision: 8 }),
      },
      activity: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    mocks.prismaTransaction.mockImplementation(
      async (operation: (client: typeof tx) => unknown) => {
        transactionActive = true;
        try { return await operation(tx); } finally { transactionActive = false; }
      },
    );

    const response = await bulkPatch(
      requestWithJson({
        taskIds: [task.id],
        updates: { columnId: "column-2" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.prismaTaskFindMany).toHaveBeenCalledOnce();
    expect(responseSnapshot).toHaveBeenCalledOnce();
    expect(body.data.tasks[0].rank).toBe(postRebalanceTask.rank);
    expect(mocks.emitTaskUpdated).toHaveBeenCalledWith(
      "project-1",
      postRebalanceTask,
    );
  });
});
