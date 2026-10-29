import { beforeEach, describe, expect, it, vi } from "vitest";
type Rule = { id: string; projectId: string; active: boolean; trigger: string; name: string; actions: unknown; conditions: unknown };
const stubs = vi.hoisted(() => ({ database: {} as object, deliver: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(stubs.database, key) }) }));
vi.mock("./notifications", async importOriginal => ({ ...await importOriginal<typeof import("./notifications")>(), deliverNotifications: stubs.deliver }));
vi.mock("./logger", () => ({ automationLogger: { debug: stubs.log, info: stubs.log, warn: stubs.log, error: stubs.log }, socketLogger: { error: stubs.log }, logAutomation: stubs.log }));
import { processAutomationRules } from "./automation-processor";
import {
  AUTOMATION_DEFERRED_MUTATION_ACTIONS,
  AUTOMATION_EXECUTION_POLICY,
  AutomationNotificationPlanError,
  planAutomationNotifications,
} from "./automation-notification-phase";

const notify = { type: "notify_assignees", params: {} };
function fixture() {
  const rules: Rule[] = [{ id: "rule", projectId: "project", active: true, trigger: "task_created", name: "synthetic-private-rule", conditions: [], actions: [notify] }];
  const task = { id: "task", projectId: "project", columnId: "column", title: "synthetic-current-title", priority: "HIGH", status: "TODO", version: 4, deadline: null as string | null,
    createdById: "creator" as string | null, assignees: [{ userId: "recipient-a" }, { userId: "recipient-b" }], tags: [] as unknown[], extra: "" as unknown };
  const state = { notifications: [] as Record<string, unknown>[] };
  const options = { actor: true, access: true, role: "USER", deniedRecipient: "", missingRecipient: "", marker: [] as unknown, markerFailure: false, insertFailureAt: 0, holdCommit: undefined as undefined | (() => Promise<void>) };
  const calls: string[] = []; let working = state;
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => { const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); return [{ id: "project" }]; }
      if (sql.includes('FROM "Task"')) { calls.push("task-lock"); return [{ id: "task", projectId: "project", priority: task.priority, version: task.version }]; }
      calls.push("actor-lock"); return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      calls.push(`user:${where.id}`); if (where.id === "actor") return options.actor ? { id: "actor", globalRole: options.role } : null;
      return where.id === options.missingRecipient ? null : { id: where.id, globalRole: "USER", isBlocked: false, blockedAt: null };
    }) },
    project: { findUnique: vi.fn(async ({ select }: { select: { members?: { where: { userId: string } } } }) => {
      const userId = select.members?.where.userId ?? "actor"; calls.push(`access:${userId}`);
      const allowed = userId === "actor" ? options.access : userId !== options.deniedRecipient;
      return { id: "project", ownerId: "someone", members: allowed ? [{ role: "MEMBER" }] : [] };
    }), update: vi.fn() },
    taskRequest: { findMany: vi.fn(async () => { calls.push("marker"); if (options.markerFailure) throw new Error("synthetic-private-storage"); return options.marker; }) },
    automationRule: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { calls.push("fresh-rule"); return rules.find(r => r.id === where.id) ?? null; }) },
    task: { findUnique: vi.fn(async () => { calls.push("fresh-task"); return task; }), findFirst: vi.fn(async () => ({ id: "task" })), update: vi.fn(), updateMany: vi.fn() },
    notification: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      calls.push("insert"); if (options.insertFailureAt === working.notifications.length + 1) throw new Error("synthetic-private-insert");
      const row = { ...data, id: `notification-${working.notifications.length + 1}`, createdAt: new Date("2026-10-21T12:00:00Z"), read: false };
      working.notifications.push(row); return row;
    }) },
    chatMessage: { create: vi.fn() }, taskTag: { create: vi.fn(), deleteMany: vi.fn() }, taskAssignee: { create: vi.fn() }, activity: { create: vi.fn() },
  };
  const database = {
    automationRule: { findMany: vi.fn(async () => rules.map(r => ({ id: r.id }))) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state); const result = await callback(tx); await options.holdCommit?.(); Object.assign(state, working); return result;
    },
  };
  stubs.database = database;
  const event = Object.freeze({ trigger: "task_created", taskId: "task", projectId: "project", userId: "actor", task: Object.freeze({ id: "forged-task", projectId: "foreign", title: "synthetic-stale-title", assignees: [{ userId: "forged-recipient" }] }) });
  return { rules, task, state, options, calls, tx, database, event, run: () => processAutomationRules(event) };
}
type Fixture = ReturnType<typeof fixture>;
function noWrites(f: Fixture) { expect(f.tx.notification.create).not.toHaveBeenCalled(); expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(f.tx.chatMessage.create).not.toHaveBeenCalled(); expect(f.tx.taskTag.create).not.toHaveBeenCalled(); expect(f.tx.taskTag.deleteMany).not.toHaveBeenCalled(); expect(f.tx.taskAssignee.create).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(stubs.deliver).not.toHaveBeenCalled(); }
beforeEach(() => { vi.clearAllMocks(); stubs.log.mockImplementation(() => {}); stubs.deliver.mockImplementation(() => {}); });

describe("transactional notification-only automation phase", () => {
  it("ignores caller task content and delivers only exact committed rows", async () => {
    const f = fixture(); stubs.deliver.mockImplementation(rows => { expect(rows).toEqual(f.state.notifications); expect(rows).toHaveLength(2); });
    await f.run(); expect(f.state.notifications.map(n => n.userId)).toEqual(["recipient-a", "recipient-b"]);
    expect(JSON.stringify(f.state.notifications)).toContain("synthetic-current-title"); expect(JSON.stringify(f.state.notifications)).not.toContain("synthetic-stale-title");
    expect(f.event.task.id).toBe("forged-task"); expect(f.calls.indexOf("marker")).toBeLessThan(f.calls.indexOf("fresh-task"));
    expect(f.tx.taskRequest.findMany).toHaveBeenCalledOnce(); expect(f.calls.indexOf("actor-lock")).toBeLessThan(f.calls.indexOf("marker"));
  });
  it.each(["add_tag", "remove_tag", "add_comment", "unknown"])("rejects whole supported-prefix + %s rule without writes", async type => {
    const f = fixture(); f.rules[0].actions = [notify, { type, params: {} }];
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); noWrites(f);
  });
  it.each([null, {}, [], [{ type: "notify_creator", params: { userId: "secret" } }]].map(actions => ({ actions })))("rejects malformed stored actions %#", async ({ actions }) => {
    const f = fixture(); f.rules[0].actions = actions; await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); noWrites(f);
  });
  it.each(["inactive", "project", "trigger", "missing"])("does not execute a fresh %s rule", async scenario => {
    const f = fixture();
    f.database.automationRule.findMany.mockResolvedValueOnce([{ id: "rule" }]);
    if (scenario === "inactive") f.rules[0].active = false; if (scenario === "project") f.rules[0].projectId = "foreign";
    if (scenario === "trigger") f.rules[0].trigger = "other"; if (scenario === "missing") f.rules.splice(0);
    await f.run(); noWrites(f);
  });
  it.each(["actor", "access", "marker", "malformed", "storage"])("denies current %s before notification work", async scenario => {
    const f = fixture(); if (scenario === "actor") f.options.actor = false; if (scenario === "access") f.options.access = false;
    if (scenario === "marker") f.options.marker = [{ taskId: "task", contractVersion: 1, state: "DRAFT", authorId: "author", executorId: null }];
    if (scenario === "malformed") f.options.marker = undefined; if (scenario === "storage") f.options.markerFailure = true;
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); noWrites(f);
    if (["actor", "access"].includes(scenario)) expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });
  it("does not infer a creator from actor, owner or assignees", async () => {
    const f = fixture(); f.rules[0].actions = [{ type: "notify_creator", params: {} }]; f.task.createdById = null;
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); noWrites(f);
  });
  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"])("ADMIN cannot bypass current %s marker", async state => {
    const f = fixture(); f.options.role = "ADMIN";
    f.options.marker = [{ taskId: "task", contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" }];
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); noWrites(f);
  });
  it("uses only actual stored creator for creator notification", async () => {
    const f = fixture(); f.rules[0].actions = [{ type: "notify_creator", params: {} }];
    await f.run(); expect(f.state.notifications.map(row => row.userId)).toEqual(["creator"]);
    expect(f.tx.user.findUnique).toHaveBeenCalledWith({ where: { id: "creator" }, select: { id: true, globalRole: true } });
  });
  it.each(["missing", "denied"])("rejects whole rule when a current recipient is %s", async scenario => {
    const f = fixture(); if (scenario === "missing") f.options.missingRecipient = "recipient-b"; else f.options.deniedRecipient = "recipient-b";
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); expect(f.state.notifications).toEqual([]); noWrites(f);
  });
  it("permits empty current assignee set with zero persisted notifications", async () => {
    const f = fixture(); f.task.assignees = []; await f.run(); expect(f.tx.notification.create).not.toHaveBeenCalled(); expect(f.state.notifications).toEqual([]);
  });
  it("keeps overdue null distinct from boolean false and preserves primitive event hints", async () => {
    const f = fixture(); f.rules[0].conditions = [{ field: "is_overdue", operator: "equals", value: null }];
    await f.run(); expect(f.state.notifications).toHaveLength(2);
    f.rules[0].conditions = [{ field: "is_overdue", operator: "equals", value: false }];
    await f.run(); expect(f.state.notifications).toHaveLength(2);
    f.rules[0].conditions = [{ field: "old_value", operator: "equals", value: 0 }, { field: "new_value", operator: "equals", value: false }];
    await processAutomationRules({ ...f.event, oldValue: 0, newValue: false }); expect(f.state.notifications).toHaveLength(4);
  });
  it("rolls back the fake rule transaction if the second notification insert fails", async () => {
    const f = fixture(); f.options.insertFailureAt = 2;
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); expect(f.tx.notification.create).toHaveBeenCalledTimes(2); expect(f.state.notifications).toEqual([]); expect(stubs.deliver).not.toHaveBeenCalled();
  });
  it("delivers nothing until the transaction promise commits", async () => {
    const f = fixture(); let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(r => { entered = r; }); f.options.holdCommit = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const pending = f.run(); await waiting; expect(stubs.deliver).not.toHaveBeenCalled(); expect(f.state.notifications).toEqual([]);
    release(); await pending; expect(stubs.deliver).toHaveBeenCalledWith(f.state.notifications);
  });
  it("continues independent rules after an unsupported rule, aggregating failure", async () => {
    const f = fixture(); f.rules[0].actions = [{ type: "add_comment", params: { comment: "synthetic-private-comment" } }];
    f.rules.push({ ...f.rules[0], id: "good-rule", actions: [notify] });
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" }); expect(f.state.notifications).toHaveLength(2); expect(stubs.deliver).toHaveBeenCalledOnce(); expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
  });
  it("never exposes storage content/rule names/notification text in diagnostics or aggregate failure", async () => {
    const f = fixture(); f.options.markerFailure = true;
    const failure = await f.run().catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "AutomationProcessingError", failures: [expect.objectContaining({ message: expect.any(String) })] });
    expect(JSON.stringify(stubs.log.mock.calls)).not.toMatch(/synthetic-private|synthetic-current-title|synthetic-stale-title/);
    expect(String((failure as { failures: Error[] }).failures[0])).not.toContain("synthetic-private");
  });
  it("continues the next rule after a hostile thrown value without inspecting it unsafely", async () => {
    const f = fixture(); f.rules.push({ ...f.rules[0], id: "second-rule" });
    f.tx.automationRule.findUnique.mockRejectedValueOnce(new Proxy({}, { getPrototypeOf: () => { throw new Error("synthetic-private-proxy"); }, get: () => { throw new Error("synthetic-private-getter"); } }));
    await expect(f.run()).rejects.toMatchObject({ name: "AutomationProcessingError" });
    expect(f.state.notifications).toHaveLength(2); expect(stubs.deliver).toHaveBeenCalledOnce(); expect(JSON.stringify(stubs.log.mock.calls)).not.toContain("synthetic-private");
  });
  it("keeps committed result despite delivery and diagnostic sink failure", async () => {
    const f = fixture(); stubs.deliver.mockImplementation(() => { throw new Error("synthetic-private-delivery"); }); stubs.log.mockImplementation(() => { throw new Error("sink"); });
    await expect(f.run()).resolves.toBeUndefined(); expect(f.state.notifications).toHaveLength(2);
  });
  it.each([
    { field: "priority", operator: "equals", value: "HIGH", send: true },
    { field: "priority", operator: "equals", value: "high", send: false },
    { field: "assignee_count", operator: "greater_than", value: "1", send: true },
    { field: "extra", operator: "is_empty", value: "ignored", send: true },
    { field: "extra", operator: "contains", value: "", send: true },
    { field: "old_value", operator: "equals", value: undefined, send: true },
    { field: "new_value", operator: "is_not_empty", value: "", send: false },
    { field: "assignee_count", operator: "less_than", value: "not-a-number", send: false },
  ])("retains condition coercion $field/$operator/$value", async ({ field, operator, value, send }) => {
    const f = fixture(); f.rules[0].conditions = [{ field, operator, value }]; await f.run(); expect(f.state.notifications).toHaveLength(send ? 2 : 0);
  });
});

describe("closed action catalog and shared-write deferral (#41)", () => {
  const task = { id: "task", projectId: "project", title: "synthetic-title", createdById: "creator" as string | null, assignees: [{ userId: "a" }, { userId: "a" }, { userId: "b" }] };
  it("declares shared mutation execution with no chaining", () => {
    expect([...AUTOMATION_DEFERRED_MUTATION_ACTIONS]).toEqual([]);
    expect(AUTOMATION_EXECUTION_POLICY).toMatchObject({ phase: "shared_mutations", chaining: "none", retry: "caller_event", conditionSnapshot: "rule_transaction" });
    expect([...AUTOMATION_EXECUTION_POLICY.deferredMutations]).toEqual([...AUTOMATION_DEFERRED_MUTATION_ACTIONS]);
  });
  it("plans exactly one row per distinct recipient and returns no task write instruction", () => {
    const plan = planAutomationNotifications([{ type: "notify_assignees", params: {} }, { type: "notify_creator", params: {} }], task);
    expect(plan.notifications.map(row => row.userId)).toEqual(["a", "b", "creator"]);
    expect(plan.recipients).toEqual(["a", "b", "creator"]);
    expect(Object.keys(plan)).toEqual(["recipients", "notifications"]);
    expect(plan.notifications.every(row => row.type === "automation_rule")).toBe(true);
  });
  it("plans notification rows while leaving admitted mutations to the shared services", () => {
    const plan = planAutomationNotifications([
      { type: "move_to_column", params: { columnId: "column-2" } },
      { type: "change_priority", params: { priority: "HIGH" } },
      { type: "assign_user", params: { userId: "member" } },
      { type: "notify_creator", params: {} },
    ], task);
    expect(plan.recipients).toEqual(["creator"]);
    expect(plan.notifications).toHaveLength(1);
    expect(plan.notifications[0]).toMatchObject({ userId: "creator", metadata: { ruleType: "notify_creator" } });
  });
  it("fails closed when the creator is unavailable instead of inferring one", () => {
    expect(() => planAutomationNotifications([{ type: "notify_creator", params: {} }], { ...task, createdById: null }))
      .toThrow(AutomationNotificationPlanError);
    expect(() => planAutomationNotifications([{ type: "notify_creator", params: {} }], { ...task, createdById: "" }))
      .toThrow(AutomationNotificationPlanError);
  });
  it("never writes Task/version/boardRevision/Activity/realtime task state for a committed rule", async () => {
    const f = fixture(); f.rules[0].actions = [{ type: "notify_assignees", params: {} }, { type: "notify_creator", params: {} }];
    await f.run();
    expect(f.state.notifications).toHaveLength(3);
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.tx.activity.create).not.toHaveBeenCalled();
    expect(f.tx.project.update).not.toHaveBeenCalled();
  });
  it("produces no second event from its own delivery, so rules cannot chain", async () => {
    const f = fixture();
    const seen: unknown[] = [];
    stubs.deliver.mockImplementation(rows => { seen.push(...rows); });
    await f.run();
    expect(seen).toHaveLength(2);
    // Delivery rows carry only notification metadata; no task event payload exists.
    expect(JSON.stringify(seen)).not.toMatch(/status_changed|priority_changed|trigger/);
    expect(f.database.automationRule.findMany).toHaveBeenCalledOnce();
  });
});
