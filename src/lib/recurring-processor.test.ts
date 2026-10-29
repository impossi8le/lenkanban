import type { PrismaClient, RecurringTask } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { processRecurringOccurrence, RecurringProcessingError } from "./recurring-processor";

const scheduledAt = new Date("2026-01-10T10:00:00Z");
const now = new Date("2026-01-10T11:00:00Z");
const candidate = { id: "recurring-1", projectId: "project-1", scheduledAt };
function stored(overrides: Partial<RecurringTask> = {}): RecurringTask {
  return {
    id: candidate.id, name: "Synthetic recurrence", description: null, projectId: candidate.projectId,
    taskTitle: "Synthetic task", taskDescription: null, priority: "HIGH", tags: [], checklistItems: [], assigneeIds: [],
    frequency: "daily", interval: 1, daysOfWeek: [], dayOfMonth: null,
    startDate: scheduledAt, endDate: null, nextRunAt: scheduledAt, active: true, lastRunAt: null,
    createdById: "user-1", createdAt: scheduledAt, updatedAt: scheduledAt, ...overrides,
  };
}
function harness() {
  const tx = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "USER" }) },
    project: { findUnique: vi.fn().mockResolvedValue({ ownerId: "user-1", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{id: "column-1"}] }) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked", projectId: candidate.projectId }]),
    taskRequest: { findMany: vi.fn().mockResolvedValue([]) },
    recurringTask: { findUnique: vi.fn().mockResolvedValue(stored()), update: vi.fn().mockResolvedValue({}) },
    recurringTaskOccurrence: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    projectColumn: { findFirst: vi.fn().mockResolvedValue({ id: "column-1", workflowKey: "TODO" }) },
    task: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "new-task" }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "new-task", projectId: candidate.projectId, assignees: [], tags: [], checklistItems: [] }) },
    taskChecklistItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    tag: { upsert: vi.fn().mockResolvedValue({ id: "tag-1" }) },
    taskTag: { create: vi.fn().mockResolvedValue({}) },
    taskAssignee: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
  const database = { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">;
  const run = () => processRecurringOccurrence({ database, candidate, now });
  const assertNoCreation = () => {
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.taskChecklistItem.createMany).not.toHaveBeenCalled();
    expect(tx.tag.upsert).not.toHaveBeenCalled();
    expect(tx.taskTag.create).not.toHaveBeenCalled();
    expect(tx.taskAssignee.createMany).not.toHaveBeenCalled();
    expect(tx.recurringTaskOccurrence.create).not.toHaveBeenCalled();
  };
  return { tx, database, transaction, run, assertNoCreation };
}

describe("recurring applicant initial-column guard", () => {
  it("uses the canonical initial column rather than arbitrary position ordering", async () => {
    const f = harness(); await f.run();
    expect(f.tx.projectColumn.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: candidate.projectId, id: "column-1" },
    }));
  });
  it("does not create tasks or occurrences when the applicant has no initial column", async () => {
    const f = harness();
    f.tx.project.findUnique.mockResolvedValue({ ownerId: "user-1", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [] });
    await expect(f.run()).rejects.toMatchObject({ name: "ForbiddenError" });
    f.assertNoCreation(); expect(f.tx.recurringTask.update).not.toHaveBeenCalled();
  });
});
/**
 * Transactional in-memory harness. Writes are buffered and committed only when
 * the callback resolves, and transactions are serialized the way PostgreSQL
 * serializes them on the locked Project row. This proves the service's control
 * flow for concurrent retry and rollback; it is not a PostgreSQL proof.
 */
function transactionalHarness() {
  const state = {
    nextRunAt: new Date(scheduledAt),
    lastRunAt: null as Date | null,
    active: true,
    occurrences: [] as { scheduledAt: number; taskId: string | null }[],
    tasks: [] as { id: string; rank: string }[],
    failLedgerInsert: null as Error | null,
  };
  let tail: Promise<void> = Promise.resolve();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
  const transaction = vi.fn(async (callback: (client: unknown) => Promise<unknown>) => {
    return serialize(async () => {
      const pending = {
        nextRunAt: undefined as Date | undefined,
        lastRunAt: undefined as Date | null | undefined,
        active: undefined as boolean | undefined,
        occurrences: [] as { scheduledAt: number; taskId: string | null }[],
        tasks: [] as { id: string; rank: string }[],
      };
      const tx = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: "user-1", globalRole: "USER" }) },
    project: { findUnique: vi.fn().mockResolvedValue({ ownerId: "user-1", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{id: "column-1"}] }) },
        $queryRaw: vi.fn(async () => [{ id: "locked", projectId: candidate.projectId }]),
        recurringTask: {
          findUnique: vi.fn(async () => ({
            ...stored(),
            nextRunAt: new Date(state.nextRunAt),
            lastRunAt: state.lastRunAt,
            active: state.active,
          })),
          update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (data.nextRunAt instanceof Date) pending.nextRunAt = data.nextRunAt;
            if (typeof data.active === "boolean") pending.active = data.active;
            if ("lastRunAt" in data) pending.lastRunAt = data.lastRunAt as Date;
            return {};
          }),
        },
        recurringTaskOccurrence: {
          findUnique: vi.fn(async ({ where }: { where: { recurringTaskId_scheduledAt: { scheduledAt: Date } } }) => {
            const at = where.recurringTaskId_scheduledAt.scheduledAt.getTime();
            const found = state.occurrences.find(occurrence => occurrence.scheduledAt === at);
            return found ? { taskId: found.taskId } : null;
          }),
          create: vi.fn(async ({ data }: { data: { scheduledAt: Date; taskId: string | null } }) => {
            if (state.failLedgerInsert) throw state.failLedgerInsert;
            pending.occurrences.push({ scheduledAt: data.scheduledAt.getTime(), taskId: data.taskId });
            return {};
          }),
        },
        projectColumn: { findFirst: vi.fn(async () => ({ id: "column-1", workflowKey: "TODO" })) },
        task: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async ({ data }: { data: { rank: string } }) => {
            const id = `task-${state.tasks.length + pending.tasks.length + 1}`;
            pending.tasks.push({ id, rank: data.rank });
            return { id };
          }),
          findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
            id: where.id, projectId: candidate.projectId, assignees: [], tags: [], checklistItems: [],
          })),
        },
        taskChecklistItem: { createMany: vi.fn(async () => ({ count: 0 })) },
        tag: { upsert: vi.fn(async () => ({ id: "tag-1" })) },
        taskTag: { create: vi.fn(async () => ({})) },
        taskAssignee: { createMany: vi.fn(async () => ({ count: 0 })) },
      };
      try {
        const result = await callback(tx);
        state.nextRunAt = pending.nextRunAt ?? state.nextRunAt;
        if (pending.active !== undefined) state.active = pending.active;
        if (pending.lastRunAt !== undefined) state.lastRunAt = pending.lastRunAt;
        state.occurrences.push(...pending.occurrences);
        state.tasks.push(...pending.tasks);
        return result;
      } catch (error) {
        // Nothing buffered is committed, mirroring a rolled-back transaction.
        throw error;
      }
    });
  });
  const database = { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">;
  return {
    state,
    transaction,
    run: () => processRecurringOccurrence({ database, candidate, now }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("recurring occurrence service contract with mocked transaction", () => {
  it.each(["now", "scheduledAt"] as const)("rejects invalid %s before opening a transaction", async (field) => {
    const h = harness();
    await expect(processRecurringOccurrence({ database: h.database,
      candidate: field === "scheduledAt" ? { ...candidate, scheduledAt: new Date(NaN) } : candidate,
      now: field === "now" ? new Date(NaN) : now,
    })).rejects.toEqual(new RecurringProcessingError("INVALID_STORED_OCCURRENCE"));
    expect(h.transaction).not.toHaveBeenCalled(); h.assertNoCreation();
  });

  it.each(["project", "schedule"])("skips a missing locked %s before reading template or writing", async (which) => {
    const h = harness();
    if (which === "project") h.tx.$queryRaw.mockResolvedValueOnce([]);
    else h.tx.$queryRaw.mockResolvedValueOnce([{ id: "project-1" }]).mockResolvedValueOnce([]);
    await expect(h.run()).resolves.toEqual({ status: "skipped", recurringTaskId: candidate.id, reason: "missing" });
    expect(h.tx.recurringTask.findUnique).not.toHaveBeenCalled();
    expect(h.tx.recurringTask.update).not.toHaveBeenCalled(); h.assertNoCreation();
  });

  it.each([
    [null, "missing"],
    [stored({ projectId: "other-project" }), "missing"],
    [stored({ active: false }), "inactive"],
    [stored({ nextRunAt: new Date("2026-01-11T10:00:00Z") }), "changed"],
  ] as const)("skips fresh state %# without writes", async (row, reason) => {
    const h = harness(); h.tx.recurringTask.findUnique.mockResolvedValue(row);
    await expect(h.run()).resolves.toEqual({ status: "skipped", recurringTaskId: candidate.id, reason });
    expect(h.tx.recurringTask.update).not.toHaveBeenCalled(); h.assertNoCreation();
  });

  it("uses the supplied clock and skips an occurrence that is not due", async () => {
    const h = harness();
    await expect(processRecurringOccurrence({ database: h.database, candidate, now: new Date("2026-01-10T09:59:59Z") }))
      .resolves.toEqual({ status: "skipped", recurringTaskId: candidate.id, reason: "not_due" });
    expect(h.tx.recurringTask.update).not.toHaveBeenCalled(); h.assertNoCreation();
  });

  it("deactivates an expired occurrence without creating a task or receipt", async () => {
    const h = harness(); h.tx.recurringTask.findUnique.mockResolvedValue(stored({ startDate: new Date("2026-01-09T10:00:00Z"), endDate: new Date("2026-01-10T09:59:59Z") }));
    await expect(h.run()).resolves.toEqual({ status: "expired", recurringTaskId: candidate.id });
    expect(h.tx.recurringTask.update).toHaveBeenCalledExactlyOnceWith({ where: { id: candidate.id }, data: { active: false } });
    h.assertNoCreation();
  });

  it("rejects a stored timestamp outside the anchored schedule before creating anything", async () => {
    const h = harness(); h.tx.recurringTask.findUnique.mockResolvedValue(stored({ startDate: new Date("2026-01-09T09:00:00Z") }));
    await expect(h.run()).rejects.toEqual(new RecurringProcessingError("INVALID_STORED_OCCURRENCE"));
    expect(h.tx.recurringTask.update).not.toHaveBeenCalled(); h.assertNoCreation();
  });

  it.each(["old-task", null])("replays the receipt with taskId=%j after a pointer reset", async (taskId) => {
    const h = harness(); h.tx.recurringTaskOccurrence.findUnique.mockResolvedValue({ taskId });
    await expect(h.run()).resolves.toEqual({ status: "already_processed", recurringTaskId: candidate.id, taskId });
    expect(h.tx.recurringTaskOccurrence.findUnique).toHaveBeenCalledWith({ where: { recurringTaskId_scheduledAt: { recurringTaskId: candidate.id, scheduledAt } } });
    expect(h.tx.recurringTask.update).toHaveBeenCalledWith({ where: { id: candidate.id }, data: { nextRunAt: new Date("2026-01-11T10:00:00Z"), active: true } });
    h.assertNoCreation();
  });

  it.each([
    { tags: {} }, { tags: [""] }, { assigneeIds: "not-array" }, { assigneeIds: [1] },
    { checklistItems: {} }, { checklistItems: [{ text: 123 }] }, { checklistItems: [{ text: "text", completed: "true" }] },
  ])("rejects malformed template %# before creation", async (malformed) => {
    const h = harness(); h.tx.recurringTask.findUnique.mockResolvedValue({ ...stored(), ...malformed });
    await expect(h.run()).rejects.toEqual(new RecurringProcessingError("INVALID_TEMPLATE"));
    expect(h.tx.recurringTask.update).not.toHaveBeenCalled(); h.assertNoCreation();
  });

  it("leaves a schedule without a column unchanged", async () => {
    const h = harness(); h.tx.projectColumn.findFirst.mockResolvedValue(null);
    await expect(h.run()).resolves.toEqual({ status: "skipped", recurringTaskId: candidate.id, reason: "missing_column" });
    expect(h.tx.recurringTask.update).not.toHaveBeenCalled(); h.assertNoCreation();
  });

  it("locks project then schedule and creates deduplicated relations, receipt and advance in one transaction", async () => {
    const h = harness(); h.tx.recurringTask.findUnique.mockResolvedValue(stored({ tags: ["Tag", "Tag"], assigneeIds: ["user-1", "user-1"], checklistItems: [{ text: "Check", completed: true }] }));
    const result = await h.run();
    expect(result).toEqual({ status: "created", recurringTaskId: candidate.id, projectId: candidate.projectId, task: await h.tx.task.findUniqueOrThrow.mock.results[0].value });
    expect(h.transaction).toHaveBeenCalledOnce();
    const firstLock = h.tx.$queryRaw.mock.calls[0];
    const secondLock = h.tx.$queryRaw.mock.calls[1];
    expect(Array.from(firstLock[0] as TemplateStringsArray).join("?")).toMatch(/FROM "Project".*FOR UPDATE/s);
    expect(Array.from(secondLock[0] as TemplateStringsArray).join("?")).toMatch(/FROM "RecurringTask".*FOR UPDATE/s);
    expect(firstLock.slice(1)).toEqual([candidate.projectId]); expect(secondLock.slice(1)).toEqual([candidate.id, candidate.projectId]);
    expect(h.tx.task.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: "Synthetic task", projectId: candidate.projectId, columnId: "column-1", createdById: "user-1" }) }));
    expect(h.tx.tag.upsert).toHaveBeenCalledOnce(); expect(h.tx.taskTag.create).toHaveBeenCalledOnce();
    expect(h.tx.taskAssignee.createMany).toHaveBeenCalledWith({ data: [{ taskId: "new-task", userId: "user-1" }] });
    expect(h.tx.taskChecklistItem.createMany).toHaveBeenCalledWith({ data: [{ taskId: "new-task", text: "Check", completed: false, position: 0 }] });
    expect(h.tx.recurringTaskOccurrence.create).toHaveBeenCalledWith({ data: { recurringTaskId: candidate.id, scheduledAt, taskId: "new-task" } });
    expect(h.tx.recurringTask.update).toHaveBeenCalledWith({ where: { id: candidate.id }, data: { lastRunAt: now, nextRunAt: new Date("2026-01-11T10:00:00Z"), active: true } });
    expect(h.tx.recurringTaskOccurrence.create.mock.invocationCallOrder[0]).toBeLessThan(h.tx.recurringTask.update.mock.invocationCallOrder[0]);
    expect(scheduledAt.toISOString()).toBe("2026-01-10T10:00:00.000Z");
  });

  it("marks the final occurrence inactive and keeps a non-null persisted pointer", async () => {
    const h = harness(); h.tx.recurringTask.findUnique.mockResolvedValue(stored({ endDate: scheduledAt }));
    expect((await h.run()).status).toBe("created");
    expect(h.tx.recurringTask.update).toHaveBeenCalledWith({ where: { id: candidate.id }, data: { lastRunAt: now, nextRunAt: scheduledAt, active: false } });
  });

  // #39 acceptance: exactly one Task per occurrence under concurrent retry.
  it("creates exactly one Task and one receipt when two processors overlap", async () => {
    const h = transactionalHarness();
    const results = await Promise.all([h.run(), h.run()]);
    expect(results.filter(result => result.status === "created")).toHaveLength(1);
    const superseded = results.filter(result =>
      result.status === "already_processed"
      || (result.status === "skipped" && result.reason === "changed"));
    expect(superseded).toHaveLength(1);
    expect(h.state.tasks).toHaveLength(1);
    expect(h.state.occurrences).toEqual([{ scheduledAt: scheduledAt.getTime(), taskId: h.state.tasks[0].id }]);
    expect(h.state.nextRunAt.toISOString()).toBe("2026-01-11T10:00:00.000Z");
    expect(h.state.lastRunAt).toEqual(now);
  });

  it("does not duplicate a Task when the same occurrence is retried after commit", async () => {
    const h = transactionalHarness();
    expect((await h.run()).status).toBe("created");
    expect((await h.run()).status).toBe("skipped");
    expect(h.state.tasks).toHaveLength(1);
    expect(h.state.occurrences).toHaveLength(1);
    expect(h.state.nextRunAt.toISOString()).toBe("2026-01-11T10:00:00.000Z");
  });

  // #39 acceptance: a failed ledger write must not leave a partial Task.
  it("rolls back the Task, relations and pointer when the occurrence receipt fails", async () => {
    const h = transactionalHarness();
    const failure = Object.assign(new Error("Synthetic unique conflict"), { code: "P2002" });
    h.state.failLedgerInsert = failure;
    await expect(h.run()).rejects.toBe(failure);
    expect(h.state.tasks).toHaveLength(0);
    expect(h.state.occurrences).toHaveLength(0);
    expect(h.state.nextRunAt).toEqual(scheduledAt);
    expect(h.state.lastRunAt).toBeNull();
    expect(h.state.active).toBe(true);
    h.state.failLedgerInsert = null;
    expect((await h.run()).status).toBe("created");
    expect(h.state.tasks).toHaveLength(1);
    expect(h.state.occurrences).toHaveLength(1);
  });

  it("propagates a relation failure after task insertion without attempting receipt or schedule advance", async () => {
    const h = harness(); h.tx.recurringTask.findUnique.mockResolvedValue(stored({ assigneeIds: ["missing-user"] }));
    const original = Error("Synthetic FK rejection"); h.tx.taskAssignee.createMany.mockRejectedValue(original);
    await expect(h.run()).rejects.toBe(original);
    expect(h.tx.task.create).toHaveBeenCalledOnce();
    expect(h.tx.recurringTaskOccurrence.create).not.toHaveBeenCalled();
    expect(h.tx.recurringTask.update).not.toHaveBeenCalled();
    // Mocks prove control flow only. PostgreSQL tests must prove rollback.
  });
});
