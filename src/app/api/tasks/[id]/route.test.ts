import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRelocationError } from "@/features/kanban/server/task-relocation";

const mocks = vi.hoisted(() => ({
  emitTaskMoved: vi.fn(),
  emitTaskUpdated: vi.fn(),
  loadTaskWithRelations: vi.fn(),
  notifyTaskStatusChanged: vi.fn(),
  processAutomationRules: vi.fn(),
  rateLimit: vi.fn(),
  requireApiUser: vi.fn(),
  taskFindFirst: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findFirst: mocks.taskFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: mocks.rateLimit,
  rateLimitErrorResponse: vi.fn(),
}));
vi.mock("@/lib/task-queries", () => ({
  loadTaskWithRelations: mocks.loadTaskWithRelations,
}));
vi.mock("@/lib/notification-triggers", () => ({
  notifyTaskStatusChanged: mocks.notifyTaskStatusChanged,
}));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  // Keep the real shared `status_changed` builder; only the DB-backed
  // processor is replaced.
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processAutomationRules: mocks.processAutomationRules,
}));
vi.mock("@/socket/board-events", () => ({
  emitTaskMoved: mocks.emitTaskMoved,
  emitTaskUpdated: mocks.emitTaskUpdated,
  emitTaskDeleted: vi.fn(),
}));

import { PATCH } from "./route";

describe("compatibility PATCH task relocation", () => {
  beforeEach(() => {
    mocks.transaction.mockReset();
    mocks.emitTaskMoved.mockReset();
    mocks.emitTaskUpdated.mockReset();
    mocks.loadTaskWithRelations.mockReset().mockResolvedValue(null);
    mocks.notifyTaskStatusChanged.mockReset().mockResolvedValue(undefined);
    mocks.processAutomationRules.mockReset().mockResolvedValue(undefined);
    mocks.rateLimit.mockReset().mockResolvedValue(undefined);
    mocks.requireApiUser.mockReset().mockResolvedValue({
      id: "user-1",
      name: "User",
      email: "user@example.test",
      globalRole: "ADMIN",
    });
    mocks.taskFindFirst.mockReset().mockResolvedValue({
      id: "task-1",
      projectId: "project-1",
      columnId: "column-1",
      version: 4,
      status: "TODO",
      title: "Task",
      priority: "MEDIUM",
      deadline: null,
    });
  });

  it.each(["projectId", "createdById", "authorId", "executorId", "assigneeId", "assignees", "watchers", "createdAt", "updatedAt", "request", "attachments", "amount", "period", "channel"])("rejects forged %s together with a valid description before mutation", async field => {
    const response = await PATCH(new Request("http://localhost/api/tasks/task-1", {
      method: "PATCH", body: JSON.stringify({ description: "Synthetic description", [field]: "synthetic-private-value" }),
    }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/synthetic-private-value|Synthetic description/);
    expect(mocks.taskFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.emitTaskMoved).not.toHaveBeenCalled();
    expect(mocks.emitTaskUpdated).not.toHaveBeenCalled();
    expect(mocks.processAutomationRules).not.toHaveBeenCalled();
    expect(mocks.notifyTaskStatusChanged).not.toHaveBeenCalled();
  });

  it.each(["REQUEST_LIFECYCLE_NOT_ENABLED", "INVALID_REQUEST_MARKER"] as const)("maps canonical %s to409 with no external effects", async code => {
    mocks.transaction.mockRejectedValue(new TaskRelocationError(code));
    const response = await PATCH(new Request("http://localhost/api/tasks/task-1", { method: "PATCH", body: JSON.stringify({ columnId: "column-2" }) }), { params: Promise.resolve({ id: "task-1" }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code } });
    expect(mocks.emitTaskMoved).not.toHaveBeenCalled(); expect(mocks.emitTaskUpdated).not.toHaveBeenCalled(); expect(mocks.processAutomationRules).not.toHaveBeenCalled(); expect(mocks.notifyTaskStatusChanged).not.toHaveBeenCalled();
  });

  it.each([false, true])("commits a relocation with scalar edits=%s without duplicate move activity or inverted locks", async (scalarEdits) => {
    const locks: string[] = [];
    const movedTask = {
      id: "task-1",
      projectId: "project-1",
      columnId: "column-2",
      version: 5,
      status: "IN_PROGRESS",
      rank: "0|QZZZZZZZZZZZZZZZZZZZ",
      position: 3072,
      title: "Task", description: null, priority: "MEDIUM", deadline: null,
    };
    const tx = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "ADMIN" }) },
      taskRequest: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      async $queryRaw(query: TemplateStringsArray, value: string) {
        const sql = query.join("?");
        if (sql.includes("FOR UPDATE")) locks.push(sql.includes('FROM "Task"') ? "task" : "column");
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
              name: "В работе",
              workflowKey: "IN_PROGRESS",
            },
          ];
        }
        if (sql.includes('FROM "ProjectColumn"')) {
          return [{ id: value, projectId: "project-1" }];
        }
        return [{ id: value }];
      },
      task: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ rank: "0|HZZZZZZZZZZZZZZZZZZZ" })
          .mockResolvedValueOnce({ position: 2048 }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({ ...movedTask, priority: "HIGH" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(movedTask),
      },
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "project-1", ownerId: "user-1", members: [] }),
        update: vi.fn().mockResolvedValue({ boardRevision: 8 }),
      },
      activity: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    mocks.transaction.mockImplementation(
      async (operation: (client: typeof tx) => unknown) => operation(tx),
    );

    const response = await PATCH(
      new Request("http://localhost/api/tasks/task-1", {
        method: "PATCH",
        body: JSON.stringify({ columnId: "column-2", ...(scalarEdits ? { priority: "HIGH" } : {}) }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(locks[0]).toBe("column");
    expect(tx.activity.create.mock.calls.map(([input]) => input.data.action)).toEqual(scalarEdits ? ["moved", "priority_changed"] : ["moved"]);
    expect(tx.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "task-1", version: 4 },
        data: expect.objectContaining({ version: { increment: 1 } }),
      }),
    );
    expect(tx.project.update).toHaveBeenCalledOnce();
    expect(mocks.emitTaskMoved).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        boardRevision: 8,
        task: expect.objectContaining({
          id: "task-1",
          columnId: "column-2",
          version: 5,
        }),
      }),
    );
    // Same `status_changed` shape as the canonical move route.
    expect(mocks.processAutomationRules).toHaveBeenCalledWith({
      trigger: "status_changed",
      taskId: "task-1",
      projectId: "project-1",
      userId: "user-1",
      oldValue: "TODO",
      newValue: "IN_PROGRESS",
    });
  });

  it("builds no status_changed event when the derived status is unchanged", async () => {
    const movedTask = {
      id: "task-1", projectId: "project-1", columnId: "column-2", version: 5, status: "TODO",
      rank: "0|QZZZZZZZZZZZZZZZZZZZ", position: 3072,
      title: "Task", description: null, priority: "MEDIUM", deadline: null,
    };
    const tx = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "ADMIN" }) },
      taskRequest: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      async $queryRaw(query: TemplateStringsArray, value: string) {
        const sql = query.join("?");
        if (sql.includes('FROM "Task"')) {
          return [{ id: value, projectId: "project-1", columnId: "column-1", version: 4, status: "TODO" }];
        }
        if (sql.includes('"workflowKey"')) {
          return [{ id: value, projectId: "project-1", name: "Сделать", workflowKey: "TODO" }];
        }
        if (sql.includes('FROM "ProjectColumn"')) return [{ id: value, projectId: "project-1" }];
        return [{ id: value }];
      },
      task: {
        findFirst: vi.fn().mockResolvedValueOnce({ rank: "0|HZZZZZZZZZZZZZZZZZZZ" }).mockResolvedValueOnce({ position: 2048 }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue(movedTask),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(movedTask),
      },
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "project-1", ownerId: "user-1", members: [] }),
        update: vi.fn().mockResolvedValue({ boardRevision: 8 }),
      },
      activity: { create: vi.fn().mockResolvedValue({}) },
    };
    mocks.transaction.mockImplementation(async (operation: (client: typeof tx) => unknown) => operation(tx));

    const response = await PATCH(
      new Request("http://localhost/api/tasks/task-1", { method: "PATCH", body: JSON.stringify({ columnId: "column-2" }) }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.emitTaskMoved).toHaveBeenCalledOnce();
    expect(mocks.processAutomationRules).not.toHaveBeenCalled();
    expect(mocks.notifyTaskStatusChanged).not.toHaveBeenCalled();
  });
});
