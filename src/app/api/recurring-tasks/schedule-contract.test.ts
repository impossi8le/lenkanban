import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  txActor: vi.fn(), txProject: vi.fn(),
  project: { findFirst: vi.fn() },
  recurringTask: { create: vi.fn(), findMany: vi.fn() },
  txRecurringTask: { findUnique: vi.fn(), update: vi.fn() },
  raw: vi.fn(), column: vi.fn(), receipt: { findUnique: vi.fn(), create: vi.fn() },
  task: { create: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  transaction: vi.fn(),
  checklist: vi.fn(),
  assignees: vi.fn(),
  tag: { upsert: vi.fn() },
  taskTag: vi.fn(),
  emit: vi.fn(),
  rank: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {
  project: mocks.project, recurringTask: mocks.recurringTask,
  $transaction: mocks.transaction,
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.user, UnauthorizedError: class extends Error {},
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mocks.logger }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: mocks.emit }));
vi.mock("@/features/kanban/server/append-task-rank", async original => ({
  ...await original<typeof import("@/features/kanban/server/append-task-rank")>(),
  allocateAppendRank: mocks.rank,
}));

import { POST } from "./route";
import { PATCH } from "./[id]/route";
import { POST as processDue } from "./process/route";

const NOW = new Date("2027-02-28T10:30:00.000Z");
function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: "recurring-1", projectId: "project-1", createdById: "user-1",
    name: "Synthetic schedule", taskTitle: "Synthetic task", priority: "MEDIUM",
    frequency: "monthly", interval: 1, daysOfWeek: [], dayOfMonth: null,
    startDate: new Date("2027-01-31T10:00:00.000Z"), endDate: null,
    nextRunAt: new Date("2027-02-28T10:00:00.000Z"), active: true,
    tags: [], checklistItems: [], assigneeIds: [],
    project: { ownerId: "user-1", members: [], columns: [{ id: "column-1", workflowKey: "TODO" }] },
    ...overrides,
  };
}
function input(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1", name: "Synthetic schedule", taskTitle: "Synthetic task",
    frequency: "monthly", startDate: "2027-01-31T10:00:00.000Z", ...overrides,
  };
}
function request(body: unknown, method = "POST") {
  return new Request("http://localhost/api/recurring-tasks", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function patch(body: unknown) {
  return PATCH(request(body, "PATCH"), { params: Promise.resolve({ id: "recurring-1" }) });
}
function cron() {
  return processDue(new Request("http://localhost/api/recurring-tasks/process", {
    method: "POST", headers: { authorization: "Bearer synthetic-cron-contract" },
  }));
}
function cronWithAuthorization(authorization?: string) {
  return processDue(new Request("http://localhost/api/recurring-tasks/process", {
    method: "POST", headers: authorization === undefined ? {} : { authorization },
  }));
}
interface DueQuery {
  where: {
    active: boolean;
    nextRunAt: { lte: Date };
    OR?: Array<{ endDate: null | { gte: Date } }>;
  };
}
// Evaluate the actual query predicate: a preselected row would hide the old
// endDate >= now filter, which silently discarded valid delayed occurrences.
function returnMatchingDueRow(row: Omit<ReturnType<typeof stored>, "endDate"> & { endDate: Date | null }) {
  mocks.txRecurringTask.findUnique.mockResolvedValue(row);
  mocks.recurringTask.findMany.mockImplementation(async ({ where }: DueQuery) => {
    const matchesEnd = !where.OR || where.OR.some(({ endDate }) =>
      endDate === null ? row.endDate === null :
        row.endDate instanceof Date && row.endDate >= endDate.gte,
    );
    return row.active === where.active && row.nextRunAt <= where.nextRunAt.lte && matchesEnd ? [row] : [];
  });
}
function dueRow(row: ReturnType<typeof stored>) {
  mocks.txRecurringTask.findUnique.mockResolvedValue(row);
  mocks.recurringTask.findMany.mockResolvedValue([{ id: row.id, projectId: row.projectId, nextRunAt: row.nextRunAt }]);
}
function assertNoWrites() {
  for (const spy of [mocks.recurringTask.create, mocks.txRecurringTask.update,
    mocks.task.create, mocks.checklist, mocks.assignees,
    mocks.tag.upsert, mocks.taskTag, mocks.receipt.create, mocks.emit]) expect(spy).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CRON_SECRET", "synthetic-cron-contract");
  mocks.user.mockResolvedValue({ id: "user-1", globalRole: "USER" });
  mocks.txActor.mockResolvedValue({ id: "user-1", globalRole: "USER" });
  mocks.txProject.mockResolvedValue({ ownerId: "user-1", members: [], applicantPolicyConfig: null,
    responsibleGroup: null, columns: [{ id: "column-1" }] });
  mocks.project.findFirst.mockResolvedValue({ id: "project-1" });
  mocks.txRecurringTask.findUnique.mockResolvedValue(stored());
  mocks.recurringTask.findMany.mockResolvedValue([]);
  mocks.recurringTask.create.mockImplementation(async ({ data }) => ({ id: "new-recurring", ...data }));
  mocks.txRecurringTask.update.mockImplementation(async ({ data }) => ({
    ...await mocks.txRecurringTask.findUnique(),
    ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
  }));
  mocks.task.create.mockResolvedValue({ id: "task-1" });
  mocks.task.findFirst.mockResolvedValue(null);
  mocks.task.findUniqueOrThrow.mockResolvedValue({ id: "task-1" });
  mocks.rank.mockResolvedValue("0|0000000000000000002S");
  mocks.raw.mockResolvedValue([{ id: "project-1" }]);
  mocks.column.mockResolvedValue({ id: "column-1", workflowKey: "TODO" });
  mocks.receipt.findUnique.mockResolvedValue(null);
  mocks.transaction.mockImplementation(async (operation) => operation({
    $queryRaw: mocks.raw, recurringTask: mocks.txRecurringTask,
    user: { findUnique: mocks.txActor }, project: { findUnique: mocks.txProject },
    recurringTaskOccurrence: mocks.receipt, projectColumn: { findFirst: mocks.column },
    task: mocks.task, taskChecklistItem: { createMany: mocks.checklist },
    taskAssignee: { createMany: mocks.assignees }, tag: mocks.tag, taskTag: { create: mocks.taskTag },
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("recurring schedule consumer contracts with real calculator", () => {
  it.each([undefined, "", "   "])("cron fails closed with missing/blank configuration %j before reads", async (secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    expect((await cron()).status).toBe(503);
    expect(mocks.recurringTask.findMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    assertNoWrites();
  });

  it.each([undefined, "Bearer wrong-synthetic-token"])("cron rejects missing/wrong bearer %j before reads", async (authorization) => {
    expect((await cronWithAuthorization(authorization)).status).toBe(401);
    expect(mocks.recurringTask.findMany).not.toHaveBeenCalled();
    assertNoWrites();
  });

  it.each([
    "bearer synthetic-cron-contract",
    "Bearer  synthetic-cron-contract",
    "Bearersynthetic-cron-contract",
    "Bearer synthetic-cron-contract-extra",
    "Basic synthetic-cron-contract",
  ])("cron rejects a non-exact bearer %j before reads", async (authorization) => {
    expect((await cronWithAuthorization(authorization)).status).toBe(401);
    expect(mocks.recurringTask.findMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    assertNoWrites();
  });

  it("cron accepts valid bearer with an empty due queue", async () => {
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { processed: 0, results: [] } });
    expect(mocks.recurringTask.findMany).toHaveBeenCalledTimes(1);
    assertNoWrites();
  });

  it("POST keeps an eligible future start as the first occurrence", async () => {
    const response = await POST(request(input({ startDate: "2027-05-20T11:47:23.456Z" })));
    expect(response.status).toBe(201);
    expect(mocks.recurringTask.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      nextRunAt: new Date("2027-05-20T11:47:23.456Z"),
    }) }));
  });

  it("POST restores the January31 anchor after February rather than drifting to March28", async () => {
    expect((await POST(request(input()))).status).toBe(201);
    expect(mocks.recurringTask.create.mock.calls[0][0].data.nextRunAt).toEqual(new Date("2027-03-31T10:00:00.000Z"));
  });

  it.each([
    { interval: null }, { interval: 0 }, { interval: 2147483648 },
    { startDate: "2027-02-30" }, { endDate: "2027-01-01" },
    { frequency: "unsupported" }, { startDate: null },
  ])("POST rejects invalid schedule %j before any write", async (invalid) => {
    expect((await POST(request(input(invalid)))).status).toBe(400);
    assertNoWrites();
  });

  it("POST rejects an exhausted schedule", async () => {
    expect((await POST(request(input({ endDate: "2027-02-27" })))).status).toBe(400);
    assertNoWrites();
  });

  it("PATCH rename preserves the exact scheduled occurrence", async () => {
    const response = await patch({ name: "Renamed" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { nextRunAt: stored().nextRunAt.toISOString() } });
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).not.toHaveProperty("nextRunAt");
  });

  it("PATCH active:true on an already active schedule preserves its due occurrence", async () => {
    const response = await patch({ active: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { nextRunAt: stored().nextRunAt.toISOString() } });
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).not.toHaveProperty("nextRunAt");
  });

  it("PATCH equivalent ISO offset preserves the occurrence instead of skipping overdue work", async () => {
    const response = await patch({ startDate: "2027-01-31T13:00:00+03:00", interval: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { nextRunAt: stored().nextRunAt.toISOString() } });
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).not.toHaveProperty("nextRunAt");
  });

  it("PATCH equivalent weekday ordering preserves a valid overdue weekly occurrence", async () => {
    const due = new Date("2027-02-17T10:00:00Z");
    mocks.txRecurringTask.findUnique.mockResolvedValue(stored({
      frequency: "weekly", interval: 2, daysOfWeek: [3, 1],
      startDate: new Date("2027-01-04T10:00:00Z"), nextRunAt: due,
    }));
    const response = await patch({ daysOfWeek: [1, 3] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { nextRunAt: due.toISOString() } });
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).not.toHaveProperty("nextRunAt");
  });

  it("PATCH an explicit valid interval can repair an invalid legacy schedule", async () => {
    mocks.txRecurringTask.findUnique.mockResolvedValue(stored({ interval: 0 }));
    expect((await patch({ interval: 1 })).status).toBe(200);
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).toMatchObject({
      interval: 1, nextRunAt: new Date("2027-03-31T10:00:00Z"),
    });
  });

  it("PATCH explicit unchanged schedule repairs an off-anchor stored occurrence", async () => {
    mocks.txRecurringTask.findUnique.mockResolvedValue(stored({ nextRunAt: new Date("2027-02-27T10:00:00Z") }));
    expect((await patch({ interval: 1 })).status).toBe(200);
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data.nextRunAt).toEqual(new Date("2027-03-31T10:00:00Z"));
  });

  it("PATCH endDate:null clears the limit instead of merging the old end", async () => {
    mocks.txRecurringTask.findUnique.mockResolvedValue(stored({ endDate: new Date("2027-02-27T23:59:59.999Z") }));
    expect((await patch({ endDate: null })).status).toBe(200);
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).toMatchObject({
      endDate: null, nextRunAt: new Date("2027-03-31T10:00:00.000Z"),
    });
  });

  it("PATCH interval merges the stored anchor and restores March31", async () => {
    expect((await patch({ interval: 2 })).status).toBe(200);
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).toMatchObject({
      frequency: "monthly", interval: 2, startDate: stored().startDate,
      nextRunAt: new Date("2027-03-31T10:00:00.000Z"),
    });
  });

  it("PATCH changed start merges the stored interval rather than defaulting it", async () => {
    mocks.txRecurringTask.findUnique.mockResolvedValue(stored({ interval: 2 }));
    expect((await patch({ startDate: "2027-02-15T12:00:00Z" })).status).toBe(200);
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data.nextRunAt).toEqual(new Date("2027-04-15T12:00:00Z"));
  });

  it.each([{ interval: null }, { interval: 2147483648 }, { endDate: "2027-01-01" }])(
    "PATCH validates merged schedule %j before write", async (invalid) => {
      expect((await patch(invalid)).status).toBe(400);
      assertNoWrites();
    },
  );

  it("PATCH rejects reactivation of an exhausted schedule", async () => {
    mocks.txRecurringTask.findUnique.mockResolvedValue(stored({ active: false, endDate: new Date("2027-02-27T23:59:59.999Z") }));
    expect((await patch({ active: true })).status).toBe(400);
    assertNoWrites();
  });

  it("PATCH disabled exhausted schedule can retain its final nextRunAt", async () => {
    const response = await patch({ active: false, endDate: "2027-02-27" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { nextRunAt: stored().nextRunAt.toISOString() } });
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).toMatchObject({ active: false });
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).not.toHaveProperty("nextRunAt");
  });

  it("cron advances from scheduledAt, preserving a backlog occurrence instead of skipping to now", async () => {
    dueRow(stored({ nextRunAt: new Date("2027-01-31T10:00:00Z") }));
    expect((await cron()).status).toBe(200);
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).toMatchObject({
      nextRunAt: new Date("2027-02-28T10:00:00Z"), active: true,
    });
    expect(mocks.task.create).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.txActor).toHaveBeenCalledExactlyOnceWith({
      where: { id: "user-1" }, select: { id: true, globalRole: true },
    });
    expect(mocks.txProject).toHaveBeenCalledWith({ where: { id: "project-1" }, select: {
      ownerId: true, members: { where: { userId: "user-1" }, select: { role: true }, take: 1 },
      applicantPolicyConfig: { select: { policy: true } },
      department: { select: { id: true, archivedAt: true } },
    } });
  });

  it.each(["deleted_creator", "revoked_creation", "missing_initial_column"])("cron denies fresh %s without task, receipt or schedule writes", async denial => {
    dueRow(stored());
    if (denial === "deleted_creator") mocks.txActor.mockResolvedValue(null);
    else mocks.txProject.mockResolvedValue({
      ownerId: denial === "revoked_creation" ? "other" : "user-1", members: [],
      applicantPolicyConfig: null, responsibleGroup: null,
      columns: denial === "missing_initial_column" ? [] : [{ id: "column-1" }],
    });
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { results: [{ success: false, error: "Recurring occurrence failed" }] } });
    expect(mocks.txActor).toHaveBeenCalledExactlyOnceWith({ where: { id: "user-1" }, select: { id: true, globalRole: true } });
    assertNoWrites();
    expect(mocks.rank).not.toHaveBeenCalled();
  });

  it("cron deactivates after the last inclusive occurrence and keeps its timestamp", async () => {
    dueRow(stored({ endDate: new Date("2027-02-28T23:59:59.999Z") }));
    expect((await cron()).status).toBe(200);
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data).toMatchObject({
      active: false, nextRunAt: stored().nextRunAt,
    });
    expect(mocks.task.create).toHaveBeenCalledTimes(1);
  });

  it("delayed cron processes one valid due occurrence even when now is beyond endDate", async () => {
    vi.setSystemTime(new Date("2027-03-02T12:00:00Z"));
    returnMatchingDueRow(stored({ endDate: new Date("2027-02-28T23:59:59.999Z") }));
    expect((await cron()).status).toBe(200);
    expect(mocks.task.create).toHaveBeenCalledTimes(1);
    expect(mocks.txRecurringTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      active: false, nextRunAt: new Date("2027-02-28T10:00:00Z"),
    }) }));
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it("cron deactivates stale nextRunAt beyond endDate without creating a Task", async () => {
    vi.setSystemTime(new Date("2027-03-02T12:00:00Z"));
    returnMatchingDueRow(stored({
      nextRunAt: new Date("2027-03-01T10:00:00Z"), endDate: new Date("2027-02-28T23:59:59.999Z"),
    }));
    expect((await cron()).status).toBe(200);
    expect(mocks.txRecurringTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ active: false }) }));
    for (const spy of [mocks.task.create, mocks.checklist,
      mocks.assignees, mocks.tag.upsert, mocks.taskTag, mocks.emit]) expect(spy).not.toHaveBeenCalled();
  });

  it("cron rejects invalid legacy schedules without task/relation/schedule writes", async () => {
    dueRow(stored({ interval: 0 }));
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { results: [{ success: false, error: "Recurring occurrence failed" }] } });
    assertNoWrites();
  });

  it.each([
    "2027-01-01T10:00:00Z",
    "2027-02-27T10:00:00Z",
    "2027-02-28T10:00:00.001Z",
  ])("cron refuses before-start/off-anchor stored occurrence %s before any write", async (nextRunAt) => {
    dueRow(stored({ nextRunAt: new Date(nextRunAt) }));
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { results: [{ success: false, error: "Recurring occurrence failed" }] } });
    assertNoWrites();
    expect(mocks.rank).not.toHaveBeenCalled();
  });

  it("cron never returns raw repository error text", async () => {
    dueRow(stored());
    mocks.transaction.mockRejectedValue(new Error("synthetic-sensitive-database-detail"));
    const response = await cron();
    expect(await response.text()).not.toContain("synthetic-sensitive-database-detail");
    expect(mocks.txRecurringTask.update).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("cron uses the freshly locked template instead of stale fields in the outer due list", async () => {
    dueRow(stored({ taskTitle: "Fresh authoritative template" }));
    mocks.recurringTask.findMany.mockResolvedValue([{
      id: "recurring-1", projectId: "project-1", nextRunAt: stored().nextRunAt,
      taskTitle: "Stale outer template", interval: 0,
    }]);
    expect((await cron()).status).toBe(200);
    expect(mocks.task.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: "Fresh authoritative template" }) }));
    expect(mocks.txRecurringTask.findUnique).toHaveBeenCalledWith({ where: { id: "recurring-1" } });
    expect(mocks.raw).toHaveBeenCalledTimes(2);
    expect(mocks.receipt.create).toHaveBeenCalledWith({ data: {
      recurringTaskId: "recurring-1", scheduledAt: stored().nextRunAt, taskId: "task-1",
    } });
  });

  it("cron returns an existing occurrence receipt without creating or emitting another Task", async () => {
    dueRow(stored());
    mocks.receipt.findUnique.mockResolvedValue({ taskId: "already-created-task" });
    const response = await cron();
    expect(await response.json()).toMatchObject({ data: { results: [{
      success: true, status: "already_processed", taskId: "already-created-task",
    }] } });
    expect(mocks.task.create).not.toHaveBeenCalled();
    expect(mocks.receipt.create).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.txRecurringTask.update.mock.calls[0][0].data.nextRunAt).toEqual(new Date("2027-03-31T10:00:00Z"));
  });

  it("cron returns a generic failure and emits nothing when transaction completion rejects after Task creation", async () => {
    dueRow(stored());
    const performOperation = mocks.transaction.getMockImplementation()!;
    mocks.transaction.mockImplementation(async (...args: unknown[]) => {
      await performOperation(...args);
      throw new Error("synthetic-sensitive-commit-failure");
    });
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { results: [{
      success: false, error: "Recurring occurrence failed",
    }] } });
    expect(mocks.task.create).toHaveBeenCalledTimes(1);
    expect(mocks.emit).not.toHaveBeenCalled();
    // This mock proves the API boundary, not actual PostgreSQL rollback.
  });

  it("cron emits only after the transaction completion promise resolves", async () => {
    dueRow(stored());
    let releaseCommit!: () => void;
    let operationFinished!: () => void;
    const commit = new Promise<void>(resolve => { releaseCommit = resolve; });
    const finished = new Promise<void>(resolve => { operationFinished = resolve; });
    const performOperation = mocks.transaction.getMockImplementation()!;
    mocks.transaction.mockImplementation(async (...args: unknown[]) => {
      const result = await performOperation(...args);
      operationFinished();
      await commit;
      return result;
    });
    const responsePromise = cron();
    await finished;
    expect(mocks.task.create).toHaveBeenCalledTimes(1);
    expect(mocks.emit).not.toHaveBeenCalled();
    releaseCommit();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { results: [{ success: true, taskId: "task-1" }] } });
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith("project-1", { id: "task-1" });
  });
});
