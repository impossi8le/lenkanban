import { beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({ database: {} as object, deliver: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(stubs.database, key) }) }));
vi.mock("./notifications", async importOriginal => ({ ...await importOriginal<typeof import("./notifications")>(), deliverNotifications: stubs.deliver }));
vi.mock("./logger", () => ({
  automationLogger: { debug: stubs.log, info: stubs.log, warn: stubs.log, error: stubs.log },
  socketLogger: { error: stubs.log },
}));
import {
  bulkMoveAutomationEvents,
  moveAutomationEvent,
  processBulkMoveAutomation,
  processMoveAutomation,
  statusChangeAutomationEvent,
} from "./automation-processor";

const rule = {
  id: "rule", projectId: "project", active: true, trigger: "status_changed", name: "synthetic-private-rule",
  conditions: [], actions: [{ type: "notify_assignees", params: {} }],
};
const task = {
  id: "task", projectId: "project", columnId: "done", title: "synthetic-current-title", priority: "MEDIUM",
  status: "DONE", version: 5, deadline: null as string | null, createdById: "creator" as string | null,
  assignees: [{ userId: "recipient" }], tags: [] as unknown[],
};

function fixture(options: { rules?: { id: string }[]; insertFailureAt?: number } = {}) {
  const state = { notifications: [] as Record<string, unknown>[] };
  const calls: string[] = [];
  const locked = { taskIds: ["task"] };
  let target = state.notifications;
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); return [{ id: "project" }]; }
      if (sql.includes('FROM "Task"')) {
        calls.push("task-lock");
        return locked.taskIds.map(id => ({ id, projectId: "project", priority: "MEDIUM", version: 5 }));
      }
      calls.push("actor-lock"); return [{ id: "actor" }];
    }),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        calls.push(`user:${where.id}`);
        return { id: where.id, globalRole: "USER", isBlocked: false, blockedAt: null };
      }),
    },
    project: {
      findMany: vi.fn(async () => [{ id: "project" }]),
      findUnique: vi.fn(async ({ select }: { select: { members?: { where: { userId: string } } } }) => {
        const userId = select.members?.where.userId ?? "actor";
        calls.push(`access:${userId}`);
        return { id: "project", ownerId: "someone", members: [{ role: "MEMBER" }] };
      }),
    },
    taskRequest: { findMany: vi.fn(async () => { calls.push("marker"); return []; }), findUnique: vi.fn(async () => null) },
    automationRule: { findUnique: vi.fn(async () => { calls.push("fresh-rule"); return rule; }) },
    task: {
      findFirst: vi.fn(async (query: object): Promise<{ id: string } | null> => { expect(query).toHaveProperty("where"); return { id: task.id }; }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        calls.push("fresh-task");
        return { ...task, id: where.id };
      }),
      update: vi.fn(), updateMany: vi.fn(),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("insert");
        if (options.insertFailureAt === target.length + 1) throw new Error("synthetic-private-insert");
        const row = { ...data, id: `notification-${target.length + 1}`, createdAt: new Date("2026-10-21T12:00:00Z"), read: false };
        target.push(row);
        return row;
      }),
    },
    activity: { create: vi.fn() },
    chatMessage: { create: vi.fn() },
    taskTag: { create: vi.fn(), deleteMany: vi.fn() },
    taskAssignee: { create: vi.fn() },
  };
  const database = {
    automationRule: { findMany: vi.fn(async () => options.rules ?? [{ id: "rule" }]) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      target = [...state.notifications];
      const result = await callback(tx);
      state.notifications = target;
      return result;
    }),
  };
  stubs.database = database;
  return { state, calls, tx, database, locked };
}
type Fixture = ReturnType<typeof fixture>;
function noTaskEffects(f: Fixture) {
  expect(f.tx.task.update).not.toHaveBeenCalled();
  expect(f.tx.task.updateMany).not.toHaveBeenCalled();
  expect(f.tx.activity.create).not.toHaveBeenCalled();
  expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
  expect(f.tx.taskTag.create).not.toHaveBeenCalled();
  expect(f.tx.taskTag.deleteMany).not.toHaveBeenCalled();
  expect(f.tx.taskAssignee.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.log.mockImplementation(() => {});
  stubs.deliver.mockImplementation(() => {});
});

describe("canonical move automation trigger (#35)", () => {
  it("builds the same status_changed event as PATCH for a workflow change", () => {
    const patchStyleEvent = {
      trigger: "status_changed", taskId: "task", projectId: "project", userId: "actor",
      oldValue: "TODO", newValue: "DONE",
    };
    expect(statusChangeAutomationEvent({
      taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO", nextStatus: "DONE",
    })).toEqual(patchStyleEvent);
    expect(moveAutomationEvent({
      taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO",
      result: { task: { id: "task", status: "DONE" } },
    })).toEqual(patchStyleEvent);
  });

  it.each([
    { scenario: "same-column reorder", previousStatus: "TODO", status: "TODO", resultId: "task" },
    { scenario: "cross-column with the same workflow status", previousStatus: "IN_REVIEW", status: "IN_REVIEW", resultId: "task" },
    { scenario: "bulk-style unchanged status row", previousStatus: "DONE", status: "DONE", resultId: "task" },
  ])("stays silent for $scenario", ({ previousStatus, status, resultId }) => {
    expect(moveAutomationEvent({
      taskId: "task", projectId: "project", userId: "actor", previousStatus,
      result: { task: { id: resultId, status } },
    })).toBeNull();
  });

  it("stays silent for a stored operationId replay", () => {
    expect(moveAutomationEvent({
      taskId: "task", projectId: "project", userId: "actor", previousStatus: "DONE",
      result: { task: { id: "task", status: "DONE" } }, replayed: true,
    })).toBeNull();
  });

  it.each([
    { scenario: "foreign result task", input: { taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO", result: { task: { id: "other", status: "DONE" } } } },
    { scenario: "missing task identity", input: { taskId: "", projectId: "project", userId: "actor", previousStatus: "TODO", result: { task: { id: "", status: "DONE" } } } },
    { scenario: "missing actor", input: { taskId: "task", projectId: "project", userId: "", previousStatus: "TODO", result: { task: { id: "task", status: "DONE" } } } },
  ])("fails closed for $scenario", ({ input }) => {
    expect(moveAutomationEvent(input)).toBeNull();
  });

  it("does not touch the database for a silent move", async () => {
    const f = fixture();
    await processMoveAutomation({
      taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO",
      result: { task: { id: "task", status: "TODO" } },
    });
    expect(f.database.automationRule.findMany).not.toHaveBeenCalled();
    expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(stubs.deliver).not.toHaveBeenCalled();
  });

  it("discovers only status_changed rules and delivers one notification set", async () => {
    const f = fixture();
    await processMoveAutomation({
      taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO",
      result: { task: { id: "task", status: "DONE" } },
    });
    expect(f.database.automationRule.findMany).toHaveBeenCalledWith({
      where: { projectId: "project", active: true, trigger: "status_changed" },
      select: { id: true },
    });
    expect(f.state.notifications.map(row => row.userId)).toEqual(["recipient"]);
    expect(stubs.deliver).toHaveBeenCalledOnce();
    noTaskEffects(f);
  });

  it("does not persist automation notifications when the shared task read cap denies a recipient", async () => {
    const f = fixture();
    f.tx.task.findFirst.mockResolvedValue(null);
    await processMoveAutomation({ taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO", result: { task: { id: "task", status: "DONE" } } });
    expect(f.tx.task.findFirst).toHaveBeenCalledOnce();
    const query = f.tx.task.findFirst.mock.calls[0][0];
    expect(JSON.stringify(query)).toContain("audienceUserIds");
    expect(f.state.notifications).toEqual([]);
    expect(f.tx.notification.create).not.toHaveBeenCalled();
    noTaskEffects(f);
  });

  it("does not duplicate notifications when the same operationId is retried", async () => {
    const f = fixture();
    const committedMove = {
      taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO",
      result: { task: { id: "task", status: "DONE" } },
    };
    await processMoveAutomation(committedMove);
    // A retry re-reads the task after the first commit: it is already DONE.
    await processMoveAutomation({ ...committedMove, previousStatus: "DONE" });
    expect(f.database.automationRule.findMany).toHaveBeenCalledOnce();
    expect(f.state.notifications).toHaveLength(1);
    expect(stubs.deliver).toHaveBeenCalledOnce();
  });

  it("leaves no notification or task effects when the rule transaction rolls back", async () => {
    const f = fixture({ insertFailureAt: 1 });
    await expect(processMoveAutomation({
      taskId: "task", projectId: "project", userId: "actor", previousStatus: "TODO",
      result: { task: { id: "task", status: "DONE" } },
    })).rejects.toMatchObject({ name: "AutomationProcessingError" });
    expect(f.state.notifications).toEqual([]);
    expect(stubs.deliver).not.toHaveBeenCalled();
    noTaskEffects(f);
  });
});

describe("move, PATCH, bulk and automation parity (#35)", () => {
  const actor = { taskId: "task", projectId: "project", userId: "actor" };
  it("move, PATCH and bulk produce an identical status_changed event for a real workflow change", () => {
    const fromPatch = { trigger: "status_changed", ...actor, oldValue: "TODO", newValue: "IN_PROGRESS" };
    const fromMove = moveAutomationEvent({ ...actor, previousStatus: "TODO", result: { task: { id: "task", status: "IN_PROGRESS" } } });
    const fromBulk = bulkMoveAutomationEvents([{ ...actor, previousStatus: "TODO", result: { task: { id: "task", status: "IN_PROGRESS" } } }]);
    expect(fromMove).toEqual(fromPatch);
    expect(fromBulk).toEqual([fromPatch]);
  });
  it("move, PATCH and bulk all stay silent when the status does not change", () => {
    expect(statusChangeAutomationEvent({ ...actor, previousStatus: "TODO", nextStatus: "TODO" })).toBeNull();
    expect(moveAutomationEvent({ ...actor, previousStatus: "TODO", result: { task: { id: "task", status: "TODO" } } })).toBeNull();
    expect(bulkMoveAutomationEvents([
      { ...actor, previousStatus: "TODO", result: { task: { id: "task", status: "TODO" } } },
      { ...actor, previousStatus: "DONE", result: { task: { id: "task", status: "DONE" } } },
    ])).toEqual([]);
  });
  it("bulk keeps only changed rows and de-duplicates repeated task IDs", () => {
    const events = bulkMoveAutomationEvents([
      { ...actor, previousStatus: "TODO", result: { task: { id: "task", status: "DONE" } } },
      { ...actor, previousStatus: "TODO", result: { task: { id: "task", status: "DONE" } } },
      { ...actor, taskId: "task-2", previousStatus: "TODO", result: { task: { id: "task-2", status: "DONE" } } },
      { ...actor, taskId: "task-3", previousStatus: "DONE", result: { task: { id: "task-3", status: "DONE" } } },
    ]);
    expect(events.map(event => event.taskId)).toEqual(["task", "task-2"]);
  });
  it("bulk processing is independent per task: one failing rule set does not stop the rest", async () => {
    const f = fixture();
    f.database.automationRule.findMany
      .mockImplementationOnce(async () => {
        f.locked.taskIds = ["task-2"];
        throw new Error("synthetic-private-discovery");
      })
      .mockResolvedValueOnce([{ id: "rule" }]);
    await expect(processBulkMoveAutomation([
      { ...actor, previousStatus: "TODO", result: { task: { id: "task", status: "DONE" } } },
      { ...actor, taskId: "task-2", previousStatus: "TODO", result: { task: { id: "task-2", status: "DONE" } } },
    ])).rejects.toMatchObject({ name: "AutomationProcessingError" });
    expect(f.database.automationRule.findMany).toHaveBeenCalledTimes(2);
    expect(stubs.deliver).toHaveBeenCalledOnce();
    noTaskEffects(f);
  });
});
