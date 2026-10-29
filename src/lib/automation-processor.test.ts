import { beforeEach, describe, expect, it, vi } from "vitest";

// Unsupported actions fail the entire rule; admitted mutations use shared services.
const mocks = vi.hoisted(() => ({ rules: vi.fn(), transaction: vi.fn(), update: vi.fn(), chat: vi.fn(), notification: vi.fn(), deliver: vi.fn(), emit: vi.fn(), emitUpdated: vi.fn(), log: vi.fn(), saveDetails: vi.fn(), assign: vi.fn(), move: vi.fn(), commandFactory: vi.fn() }));
vi.mock("./task-command", async importOriginal => ({ ...await importOriginal<typeof import("./task-command")>(), createTaskCommandService: mocks.commandFactory }));
vi.mock("./task-assignees", () => ({ replaceTaskAssigneesWithClient: mocks.assign }));
vi.mock("@/features/kanban/server/move-task-service", async importOriginal => ({ ...await importOriginal<typeof import("@/features/kanban/server/move-task-service")>(), moveTask: mocks.move }));
vi.mock("./task-queries", () => ({ loadTaskWithRelations: async () => ({ id: "task-1", project: { id: "project-1" } }) }));
vi.mock("@/lib/prisma", () => ({ prisma: { automationRule: { findMany: mocks.rules }, $transaction: mocks.transaction } }));
vi.mock("./notifications", async importOriginal => ({ ...await importOriginal<typeof import("./notifications")>(), deliverNotifications: mocks.deliver }));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: mocks.emit, emitTaskUpdated: mocks.emitUpdated }));
vi.mock("./logger", () => ({ automationLogger: { info: mocks.log, debug: mocks.log, error: mocks.log }, socketLogger: { error: mocks.log } }));
import { processAutomationRules, processMoveAutomation } from "./automation-processor";

function txFixture(actions: unknown) {
  return {
    async $queryRaw(parts: TemplateStringsArray) {
      const sql = parts.join("?");
      if (sql.includes('FROM "Task"')) return [{ id: "task-1", projectId: "project-1", priority: "MEDIUM", version: 4 }];
      return [{ id: sql.includes('FROM "Project"') ? "project-1" : "user-1" }];
    },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "USER", isBlocked: false, blockedAt: null }) },
    project: { findUnique: vi.fn().mockResolvedValue({ id: "project-1", ownerId: "user-1", members: [] }) },
    taskRequest: { findMany: vi.fn().mockResolvedValue([]) },
    automationRule: { findUnique: vi.fn().mockResolvedValue({ id: "rule-1", projectId: "project-1", active: true, trigger: "task_created", name: "synthetic-private-rule", conditions: [], actions }) },
    task: { findFirst: vi.fn().mockResolvedValue({ id: "task-1" }), update: mocks.update, updateMany: mocks.update },
    chatMessage: { create: mocks.chat }, notification: { create: mocks.notification },
  };
}
const event = { trigger: "task_created", taskId: "task-1", projectId: "project-1", userId: "user-1", task: Object.freeze({ id: "task-1", columnId: "column-1", status: "TODO", version: 4 }) };
beforeEach(() => { vi.clearAllMocks(); mocks.rules.mockResolvedValue([{ id: "rule-1" }]); });
describe("stored unsupported actions fail closed", () => {
  it.each(["add_tag", "remove_tag", "add_comment", "unknown_action"])("rejects stored %s with no task/child/notification effects", async type => {
    const tx = txFixture([{ type, params: { columnId: "foreign-column" } }]);
    mocks.transaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    await expect(processAutomationRules(event)).rejects.toMatchObject({ name: "AutomationProcessingError", message: "Automation processing failed" });
    expect(mocks.transaction).toHaveBeenCalledOnce(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.notification).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("blocks the entire old failed-move then comment array instead of continuing into comment", async () => {
    const tx = txFixture([{ type: "move_to_column", params: { columnId: "foreign-column" } }, { type: "add_comment", params: { comment: "Action after failed move" } }]);
    mocks.transaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    const error = await processAutomationRules(event).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "AutomationProcessingError", message: "Automation processing failed" }); expect(error).not.toHaveProperty("retryable");
    expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.notification).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });
  it.each(["revoked", "marked"])("still checks fresh %s event actor before stored action execution", async scenario => {
    const tx = txFixture([{ type: "move_to_column", params: { columnId: "column-2" } }]);
    if (scenario === "revoked") tx.project.findUnique.mockResolvedValue({ id: "project-1", ownerId: "other", members: [] });
    else tx.taskRequest.findMany.mockResolvedValue([{ taskId: "task-1", contractVersion: 1, state: "DRAFT", authorId: "author", executorId: null }]);
    mocks.transaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    await expect(processAutomationRules(event)).rejects.toMatchObject({ name: "AutomationProcessingError" });
    expect(tx.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-1" } }));
    if (scenario === "revoked") expect(tx.taskRequest.findMany).not.toHaveBeenCalled();
    expect(tx.automationRule.findUnique).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("surfaces transaction failure without a safe-retry claim or side effects", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("database unavailable"));
    const error = await processAutomationRules(event).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "AutomationProcessingError", message: "Automation processing failed" }); expect(error).not.toHaveProperty("retryable");
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe("atomic move automation replay claim (#35/#41)", () => {
  const preRead = { status: "TODO", version: 4 };
  const committedResult = {
    operationId: "11111111-1111-4111-8111-111111111111",
    task: { id: "task-1", status: "DONE", version: 5 },
  };
  const move = {
    taskId: "task-1", projectId: "project-1", userId: "user-1", previousStatus: preRead.status,
    result: committedResult,
    // Both requests read version 4 before the move committed.
    replayed: committedResult.task.version <= preRead.version,
  };

  function claimFixture() {
    const receipts = new Set<string>();
    const pending = new Map<string, Promise<void>>();
    const notifications: object[] = [];
    const options = { failInsert: false };
    let releaseCommit!: () => void;
    let firstInserted!: () => void;
    let secondWaiting!: () => void;
    const inserted = new Promise<void>(resolve => { firstInserted = resolve; });
    const waiting = new Promise<void>(resolve => { secondWaiting = resolve; });
    const hold = new Promise<void>(resolve => { releaseCommit = resolve; });
    const claims = vi.fn();
    // Model unique INSERT ON CONFLICT: an overlapping insert waits for the
    // transaction owning the key, then observes its commit or rollback.
    mocks.transaction.mockImplementation(async (callback: (tx: object) => Promise<unknown>) => {
      const base = txFixture([{ type: "notify_creator", params: {} }]);
      const local: object[] = [];
      let key: string | undefined;
      let unlock: (() => void) | undefined;
      const tx = {
        ...base,
        automationRule: { findUnique: vi.fn().mockResolvedValue({
          id: "rule-1", projectId: "project-1", active: true, trigger: "status_changed",
          conditions: [], actions: [{ type: "notify_creator", params: {} }],
        }) },
        task: { ...base.task, findUnique: vi.fn().mockResolvedValue({
          id: "task-1", projectId: "project-1", title: "Task", status: "DONE", version: 5,
          createdById: "user-1", assignees: [], tags: [],
        }) },
        taskMoveOperation: { createMany: async (args: { data: { operationId: string }[]; skipDuplicates: boolean }) => {
          claims(args);
          expect(args.skipDuplicates).toBe(true);
          const requestedKey = args.data[0].operationId;
          while (pending.has(requestedKey)) {
            secondWaiting();
            await pending.get(requestedKey);
          }
          if (receipts.has(requestedKey)) return { count: 0 };
          key = requestedKey;
          pending.set(key, new Promise<void>(resolve => { unlock = resolve; }));
          return { count: 1 };
        } },
        notification: { create: async ({ data }: { data: object }) => {
          if (options.failInsert) { options.failInsert = false; throw new Error("insert failed"); }
          const row = { ...data, id: "notification", createdAt: new Date(), read: false };
          local.push(row);
          firstInserted();
          return row;
        } },
      };
      try {
        const result = await callback(tx);
        if (local.length) await hold;
        if (key) receipts.add(key);
        notifications.push(...local);
        return result;
      } finally {
        if (key) pending.delete(key);
        unlock?.();
      }
    });
    return { receipts, notifications, options, claims, inserted, waiting, release: () => releaseCommit() };
  }

  it("allows only one notification transaction for overlapping requests with the same pre-read version", async () => {
    const f = claimFixture();
    const first = processMoveAutomation(move);
    await f.inserted;
    const second = processMoveAutomation(structuredClone(move));
    await f.waiting;
    expect(f.notifications).toEqual([]);
    expect(mocks.deliver).not.toHaveBeenCalled();
    f.release();
    await Promise.all([first, second]);
    expect(f.claims).toHaveBeenCalledTimes(2);
    expect(f.claims.mock.calls[0][0]).toEqual(f.claims.mock.calls[1][0]);
    expect(f.receipts.size).toBe(1);
    expect(f.notifications).toHaveLength(1);
    expect(mocks.deliver).toHaveBeenCalledOnce();
    expect(mocks.deliver).toHaveBeenCalledWith(f.notifications);
  });

  it("rolls back the claim with a failed notification insert and permits retry", async () => {
    const f = claimFixture();
    f.options.failInsert = true;
    await expect(processMoveAutomation(move)).rejects.toMatchObject({ name: "AutomationProcessingError" });
    expect(f.receipts.size).toBe(0);
    expect(f.notifications).toEqual([]);
    expect(mocks.deliver).not.toHaveBeenCalled();
    f.release();
    await processMoveAutomation(move);
    expect(f.receipts.size).toBe(1);
    expect(f.notifications).toHaveLength(1);
    expect(mocks.deliver).toHaveBeenCalledOnce();
  });
});

describe("shared mutation orchestration (#41)", () => {
  function fixture(actions: unknown) {
    const state = { priority: "MEDIUM", version: 4, notifications: [] as object[], claims: [] as string[] };
    let working = structuredClone(state);
    const task = () => ({ id: "task-1", projectId: "project-1", columnId: "column-1", status: "TODO",
      title: "Task", createdById: "user-1", assignees: [], tags: [], priority: working.priority, version: working.version });
    const base = txFixture(actions);
    const tx = { ...base,
      task: { ...base.task, findUnique: vi.fn(async () => task()), findUniqueOrThrow: vi.fn(async () => task()),
        findFirst: vi.fn().mockResolvedValue({ id: "last-task" }) },
      taskAssignee: { findMany: vi.fn().mockResolvedValue([{ userId: "existing-user" }]) },
      taskMoveOperation: { createMany: vi.fn(async ({ data }: { data: { operationId: string }[] }) => {
        const key = data[0].operationId;
        if (working.claims.includes(key)) return { count: 0 };
        working.claims.push(key); return { count: 1 };
      }) },
      notification: { create: vi.fn(async ({ data }: { data: object }) => {
        const row = { ...data, id: "notification", createdAt: new Date(), read: false };
        working.notifications.push(row); return row;
      }) },
    };
    mocks.transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state);
      const result = await run(tx);
      Object.assign(state, working); return result;
    });
    mocks.commandFactory.mockImplementation(() => ({ saveDetails: mocks.saveDetails }));
    mocks.saveDetails.mockImplementation(async ({ changes }: { changes: { priority: string } }) => {
      working.priority = changes.priority; working.version++;
      return { ack: { changed: true, replayed: false, version: working.version }, effects: { priority: { oldValue: "MEDIUM", newValue: changes.priority } } };
    });
    mocks.assign.mockResolvedValue({ added: ["new-user"] });
    mocks.move.mockResolvedValue({ operationId: "move-result", boardRevision: 9, task: { id: "task-1", columnId: "column-2", status: "DONE", version: 5 } });
    const input = { ...event, operationId: "source-operation" };
    return { tx, state, input, run: () => processAutomationRules(input) };
  }

  it("passes expectedVersion and stable operationId to the card command service", async () => {
    const f = fixture([{ type: "change_priority", params: { priority: "HIGH" } }]);
    await f.run();
    expect(mocks.saveDetails).toHaveBeenCalledExactlyOnceWith({ taskId: "task-1", actorId: "user-1",
      operationId: expect.stringMatching(/^[a-f0-9-]{36}$/), expectedVersion: 4, changes: { priority: "HIGH" } });
    const joined = mocks.commandFactory.mock.calls[0][0];
    await joined.$transaction(async (tx: unknown) => expect(tx).toBe(f.tx));
    expect(mocks.emitUpdated).toHaveBeenCalledOnce();
  });

  it("uses the shared HTTP assignee guard and preserves existing assignments", async () => {
    const f = fixture([{ type: "assign_user", params: { userId: "new-user" } }]);
    await f.run();
    expect(mocks.assign).toHaveBeenCalledExactlyOnceWith({ tx: f.tx, actorId: "user-1", taskId: "task-1",
      projectId: "project-1", userIds: ["existing-user", "new-user"] });
    expect(mocks.emitUpdated).toHaveBeenCalledOnce();
  });

  it("appends via canonical move with neighbors, version, rank service and postcommit revision", async () => {
    const f = fixture([{ type: "move_to_column", params: { columnId: "column-2" } }]);
    mocks.emit.mockImplementation(() => { expect(f.state.claims).toHaveLength(1); });
    await f.run();
    expect(mocks.move).toHaveBeenCalledExactlyOnceWith({ taskId: "task-1", request: {
      toColumnId: "column-2", beforeTaskId: "last-task", afterTaskId: null,
      operationId: expect.stringMatching(/^[a-f0-9-]{36}$/), expectedVersion: 4,
    }, repository: expect.any(Object), ranks: expect.any(Object) });
    expect(mocks.emit).toHaveBeenCalledWith("project-1", expect.objectContaining({ boardRevision: 9 }));
  });

  it("does not discover a priority_changed second rule after automated change_priority", async () => {
    const f = fixture([{ type: "change_priority", params: { priority: "HIGH" } }]);
    // Discovery would return another rule if generated priority_changed were admitted.
    mocks.rules.mockImplementation(async ({ where }: { where: { trigger: string } }) =>
      where.trigger === "priority_changed" ? [{ id: "second-rule" }] : [{ id: "rule-1" }]);
    await f.run();
    expect(f.state.priority).toBe("HIGH");
    expect(mocks.rules).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: expect.objectContaining({ trigger: "task_created" }) }));
    await processAutomationRules({ ...f.input, trigger: "priority_changed", origin: "automation" });
    expect(mocks.rules).toHaveBeenCalledOnce();
    expect(mocks.saveDetails).toHaveBeenCalledOnce();
  });

  it("rolls back notification rows, prior change and receipt when move fails; retry can succeed", async () => {
    const f = fixture([{ type: "notify_creator", params: {} }, { type: "change_priority", params: { priority: "HIGH" } },
      { type: "move_to_column", params: { columnId: "column-2" } }]);
    mocks.move.mockRejectedValueOnce(new Error("synthetic-private-move-failure"));
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" });
    expect(f.tx.notification.create).toHaveBeenCalledOnce();
    expect(mocks.saveDetails).toHaveBeenCalledOnce();
    expect(f.state).toEqual({ priority: "MEDIUM", version: 4, notifications: [], claims: [] });
    expect(mocks.deliver).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled(); expect(mocks.emitUpdated).not.toHaveBeenCalled();
    const operationId = mocks.saveDetails.mock.calls[0][0].operationId;
    await f.run();
    expect(mocks.saveDetails.mock.calls[1][0].operationId).toBe(operationId);
    expect(f.state.priority).toBe("HIGH"); expect(f.state.version).toBe(5);
    expect(f.state.notifications).toHaveLength(1); expect(f.state.claims).toHaveLength(1);
  });

  it("does not invoke any mutation or redeliver notifications on same event retry", async () => {
    const f = fixture([{ type: "notify_creator", params: {} }, { type: "change_priority", params: { priority: "HIGH" } },
      { type: "assign_user", params: { userId: "new-user" } }, { type: "move_to_column", params: { columnId: "column-2" } }]);
    await f.run(); await f.run();
    expect(mocks.saveDetails).toHaveBeenCalledOnce(); expect(mocks.assign).toHaveBeenCalledOnce(); expect(mocks.move).toHaveBeenCalledOnce();
    expect(f.state.version).toBe(5); expect(f.state.claims).toHaveLength(1); expect(f.state.notifications).toHaveLength(1);
    expect(mocks.deliver).toHaveBeenCalledOnce(); expect(mocks.emit).toHaveBeenCalledOnce(); expect(mocks.emitUpdated).toHaveBeenCalledOnce();
    expect(f.tx.taskMoveOperation.createMany).toHaveBeenCalledTimes(2);
  });
});
