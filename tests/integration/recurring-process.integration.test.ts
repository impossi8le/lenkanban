import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processRecurringOccurrence, RecurringProcessingError, type RecurringOccurrenceCandidate } from "@/lib/recurring-processor";
import { loopbackDatabaseUrl } from "./support/test-database";
import { ForbiddenError } from "@/lib/errors";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const testRunId = `recurring-process-${randomUUID()}`;
const scheduledAt = new Date("2026-01-10T10:00:00Z");
const now = new Date("2026-01-10T11:00:00Z");

function assertIsolatedDatabase(value: string): void {
  const testUrl = new URL(value);
  const databaseName = decodeURIComponent(testUrl.pathname.slice(1));
  if (!["postgresql:", "postgres:"].includes(testUrl.protocol)
    || !databaseName.endsWith("_test") || databaseName.includes("/") || databaseName.includes("\\")) {
    throw Error("TEST_DATABASE_URL must select a PostgreSQL database with one name ending in _test");
  }
  for (const productionValue of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (productionValue && new URL(productionValue).hostname === testUrl.hostname) {
      throw Error("TEST_DATABASE_URL hostname must differ from application and production database hostnames");
    }
  }
}
// Validate before constructing a PrismaClient. Missing explicit URL means skip.
if (testDatabaseUrl) assertIsolatedDatabase(testDatabaseUrl);

let database: PrismaClient;
const projectIds = new Set<string>();
const userIds = new Set<string>();
interface Fixture {
  userId: string;
  projectId: string;
  columnId: string;
  recurringId: string;
  candidate: RecurringOccurrenceCandidate;
}

async function fixture(overrides: Partial<Prisma.RecurringTaskUncheckedCreateInput> = {}, withColumn = true): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = `${testRunId}-user-${suffix}`;
  const projectId = `${testRunId}-project-${suffix}`;
  const columnId = `${testRunId}-column-${suffix}`;
  const recurringId = `${testRunId}-schedule-${suffix}`;
  await database.user.create({ data: { id: userId, email: `${suffix}@${testRunId}.invalid`, name: testRunId } });
  userIds.add(userId);
  await database.project.create({ data: {
    id: projectId, name: `${testRunId}-${suffix}`, ownerId: userId,
    columns: withColumn ? { create: [{ id: columnId, name: "Synthetic queue", color: "#123456", position: 0, workflowKey: "TODO" }] } : undefined,
  } });
  projectIds.add(projectId);
  await database.recurringTask.create({ data: {
    id: recurringId, name: `${testRunId}-schedule`, projectId, createdById: userId,
    taskTitle: `${testRunId}-task`, taskDescription: "Synthetic description", priority: "HIGH",
    tags: ["Synthetic tag", "Synthetic tag"], assigneeIds: [userId, userId],
    checklistItems: [{ text: "First check", completed: true }, { text: "Second check", completed: false }],
    frequency: "daily", interval: 1, daysOfWeek: [], dayOfMonth: null,
    startDate: scheduledAt, nextRunAt: scheduledAt, endDate: null, active: true,
    ...overrides,
  } });
  return { userId, projectId, columnId, recurringId, candidate: { id: recurringId, projectId, scheduledAt: new Date(scheduledAt) } };
}
const processOne = (f: Fixture) => processRecurringOccurrence({ database, candidate: f.candidate, now });

async function assertNoTaskOrReceipt(f: Fixture) {
  expect(await database.task.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await database.recurringTaskOccurrence.count({ where: { recurringTaskId: f.recurringId } })).toBe(0);
}

// PostgreSQL must report two blocked service transactions before releasing the
// Project lock. Promise.all alone is not evidence that transactions overlapped.
async function queuedOccurrences(f: Fixture) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const unlocked = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const blocker = database.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.projectId} FOR UPDATE`;
    const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(backend.pid);
    await unlocked;
  }, { timeout: 20_000 });
  let outcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof processOne>>>[]> | undefined;
  try {
    const blockerPid = await Promise.race([locked, blocker.then(() => { throw Error("Project blocker ended before becoming ready"); })]);
    outcomes = Promise.allSettled([processOne(f), processOne(f)]);
    const deadline = Date.now() + 4_000;
    let waiting = 0;
    do {
      const [state] = await database.$queryRaw<{ count: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        )
        SELECT count(*)::int AS count FROM blocked
      `;
      waiting = state.count;
      if (waiting >= 2) break;
      await delay(20);
    } while (Date.now() < deadline);
    expect(waiting, "Both occurrence processors must wait on the held Project lock").toBeGreaterThanOrEqual(2);
  } finally {
    release();
    await blocker;
    if (outcomes) await outcomes;
  }
  return outcomes!;
}

describeWithDatabase("PostgreSQL atomic recurring occurrence processing", () => {
  beforeAll(() => {
    const isolatedUrl = new URL(testDatabaseUrl!);
    isolatedUrl.searchParams.set("connection_limit", "5");
    database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(isolatedUrl) });
  });
  afterAll(async () => {
    if (!database) return;
    try {
      if (projectIds.size) await database.project.deleteMany({ where: { id: { in: [...projectIds] }, name: { contains: testRunId } } });
      if (userIds.size) await database.user.deleteMany({ where: { id: { in: [...userIds] }, email: { contains: testRunId } } });
    } finally {
      await database.$disconnect();
    }
  });

  it("serializes overlapping occurrences into one Task, one receipt, all relations and one advance", async () => {
    const f = await fixture();
    const results = await queuedOccurrences(f);
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const values = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    expect(values.filter(value => value.status === "created")).toHaveLength(1);
    expect(values.filter(value => value.status === "skipped" || value.status === "already_processed")).toHaveLength(1);
    const task = await database.task.findFirstOrThrow({ where: { projectId: f.projectId }, include: {
      checklistItems: { orderBy: { position: "asc" } }, tags: { include: { tag: true } }, assignees: true,
    } });
    expect(await database.task.count({ where: { projectId: f.projectId } })).toBe(1);
    expect(await database.recurringTaskOccurrence.findMany({ where: { recurringTaskId: f.recurringId }, select: { taskId: true, scheduledAt: true } })).toEqual([{ taskId: task.id, scheduledAt }]);
    expect(task.checklistItems.map(item => ({ text: item.text, completed: item.completed, position: item.position }))).toEqual([
      { text: "First check", completed: false, position: 0 }, { text: "Second check", completed: false, position: 1 },
    ]);
    expect(task.tags.map(link => link.tag.name)).toEqual(["Synthetic tag"]);
    expect(task.assignees.map(link => link.userId)).toEqual([f.userId]);
    expect(task).toMatchObject({ columnId: f.columnId, createdById: f.userId, priority: "HIGH" });
    expect(await database.recurringTask.findUniqueOrThrow({ where: { id: f.recurringId }, select: { nextRunAt: true, lastRunAt: true, active: true } }))
      .toEqual({ nextRunAt: new Date("2026-01-11T10:00:00Z"), lastRunAt: now, active: true });
  }, 30_000);

  it("rolls back Task, checklist, tags and receipt after a real assignee FK failure, then retries once", async () => {
    const f = await fixture({ assigneeIds: [`${testRunId}-missing-user`] });
    await expect(processOne(f)).rejects.toMatchObject({ code: "P2003" });
    await assertNoTaskOrReceipt(f);
    expect(await database.tag.count({ where: { projectId: f.projectId } })).toBe(0);
    expect(await database.taskChecklistItem.count({ where: { task: { projectId: f.projectId } } })).toBe(0);
    expect(await database.recurringTask.findUniqueOrThrow({ where: { id: f.recurringId }, select: { nextRunAt: true, lastRunAt: true, active: true } }))
      .toEqual({ nextRunAt: scheduledAt, lastRunAt: null, active: true });
    await database.recurringTask.update({ where: { id: f.recurringId }, data: { assigneeIds: [f.userId] } });
    expect((await processOne(f)).status).toBe("created");
    expect((await processOne(f)).status).toBe("skipped");
    expect(await database.task.count({ where: { projectId: f.projectId } })).toBe(1);
    expect(await database.recurringTaskOccurrence.count({ where: { recurringTaskId: f.recurringId } })).toBe(1);
  });

  it("retains the receipt when Task is deleted and refuses recreation after resetting the pointer", async () => {
    const f = await fixture();
    const result = await processOne(f);
    if (result.status !== "created") throw Error("Expected a created occurrence fixture");
    await database.task.delete({ where: { id: result.task.id } });
    expect(await database.recurringTaskOccurrence.findUniqueOrThrow({ where: { recurringTaskId_scheduledAt: { recurringTaskId: f.recurringId, scheduledAt } }, select: { taskId: true } })).toEqual({ taskId: null });
    await database.recurringTask.update({ where: { id: f.recurringId }, data: { nextRunAt: scheduledAt, active: true } });
    expect(await processOne(f)).toEqual({ status: "already_processed", recurringTaskId: f.recurringId, taskId: null });
    expect(await database.task.count({ where: { projectId: f.projectId } })).toBe(0);
    expect(await database.recurringTaskOccurrence.count({ where: { recurringTaskId: f.recurringId } })).toBe(1);
    expect((await database.recurringTask.findUniqueOrThrow({ where: { id: f.recurringId } })).nextRunAt).toEqual(new Date("2026-01-11T10:00:00Z"));
  });

  it("creates the inclusive terminal occurrence once and deactivates the schedule", async () => {
    const f = await fixture({ endDate: scheduledAt });
    expect((await processOne(f)).status).toBe("created");
    expect(await processOne(f)).toMatchObject({ status: "skipped", reason: "inactive" });
    expect(await database.task.count({ where: { projectId: f.projectId } })).toBe(1);
    expect(await database.recurringTaskOccurrence.count({ where: { recurringTaskId: f.recurringId } })).toBe(1);
    expect(await database.recurringTask.findUniqueOrThrow({ where: { id: f.recurringId }, select: { nextRunAt: true, active: true, lastRunAt: true } }))
      .toEqual({ nextRunAt: scheduledAt, active: false, lastRunAt: now });
  });

  it("skips disabled, future, changed and missing candidates; denies USER creation without an allowed column", async () => {
    const inactive = await fixture({ active: false });
    expect(await processOne(inactive)).toMatchObject({ status: "skipped", reason: "inactive" }); await assertNoTaskOrReceipt(inactive);
    const future = await fixture();
    expect(await processRecurringOccurrence({ database, candidate: future.candidate, now: new Date("2026-01-10T09:00:00Z") })).toMatchObject({ status: "skipped", reason: "not_due" }); await assertNoTaskOrReceipt(future);
    const changed = await fixture({ nextRunAt: new Date("2026-01-11T10:00:00Z") });
    expect(await processOne(changed)).toMatchObject({ status: "skipped", reason: "changed" }); await assertNoTaskOrReceipt(changed);
    const missing = await fixture(); await database.recurringTask.delete({ where: { id: missing.recurringId } });
    expect(await processOne(missing)).toMatchObject({ status: "skipped", reason: "missing" }); await assertNoTaskOrReceipt(missing);
    const columnless = await fixture({}, false);
    // An applicant without a TODO column now fails the creation policy before
    // the processor reaches its unrestricted missing-column lookup.
    await expect(processOne(columnless)).rejects.toBeInstanceOf(ForbiddenError);
    await assertNoTaskOrReceipt(columnless);
    expect(await database.recurringTask.findUniqueOrThrow({ where: { id: columnless.recurringId }, select: { nextRunAt: true, lastRunAt: true, active: true } }))
      .toEqual({ nextRunAt: scheduledAt, lastRunAt: null, active: true });
  });

  it("keeps the missing-column skip for an explicitly unrestricted ADMIN creator", async () => {
    const columnless = await fixture({}, false);
    await database.user.update({ where: { id: columnless.userId }, data: { globalRole: "ADMIN" } });
    expect(await processOne(columnless)).toMatchObject({ status: "skipped", reason: "missing_column" });
    await assertNoTaskOrReceipt(columnless);
  });

  it("deactivates a due occurrence beyond endDate without a Task or receipt", async () => {
    const f = await fixture({ startDate: new Date("2026-01-09T10:00:00Z"), endDate: new Date("2026-01-10T09:00:00Z") });
    expect(await processOne(f)).toEqual({ status: "expired", recurringTaskId: f.recurringId });
    await assertNoTaskOrReceipt(f);
    expect((await database.recurringTask.findUniqueOrThrow({ where: { id: f.recurringId } })).active).toBe(false);
  });

  it("rejects malformed stored templates without advancing or leaving partial data", async () => {
    const f = await fixture({ checklistItems: [{ text: "Synthetic check", completed: "not-boolean" }] });
    await expect(processOne(f)).rejects.toEqual(new RecurringProcessingError("INVALID_TEMPLATE"));
    await assertNoTaskOrReceipt(f);
    expect((await database.recurringTask.findUniqueOrThrow({ where: { id: f.recurringId } })).nextRunAt).toEqual(scheduledAt);
  });

  it("processes overdue backlog one anchored occurrence per call, without jumping to wall clock", async () => {
    const f = await fixture();
    const lateNow = new Date("2026-01-13T12:00:00Z");
    expect((await processRecurringOccurrence({ database, candidate: f.candidate, now: lateNow })).status).toBe("created");
    const next = (await database.recurringTask.findUniqueOrThrow({ where: { id: f.recurringId } })).nextRunAt;
    expect(next).toEqual(new Date("2026-01-11T10:00:00Z"));
    expect((await processRecurringOccurrence({ database, candidate: { ...f.candidate, scheduledAt: next }, now: lateNow })).status).toBe("created");
    expect(await database.task.count({ where: { projectId: f.projectId } })).toBe(2);
    expect(await database.recurringTaskOccurrence.count({ where: { recurringTaskId: f.recurringId } })).toBe(2);
  });
});
