import { randomUUID } from "node:crypto";
import { PrismaClient, TaskRequestState } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { createTaskCommandService } from "@/lib/task-command";
import { updateChecklistItem } from "@/lib/checklist-toggle";
import { ensureTaskRequestMarkerConstraints, loopbackDatabaseUrl } from "./support/test-database";

const testUrl = process.env.TEST_DATABASE_URL;
const guardedDescribe = testUrl ? describe : describe.skip;
if (testUrl) {
  const parsed = new URL(testUrl), name = decodeURIComponent(parsed.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !name.endsWith("_test") || name.includes("/") || name.includes("\\")) throw Error("TEST_DATABASE_URL must select one PostgreSQL database ending in _test");
  for (const applicationUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (applicationUrl && new URL(applicationUrl).hostname === parsed.hostname) throw Error("TEST_DATABASE_URL hostname must differ from application and production hostnames");
  }
}
const runId = `request-marker-${randomUUID()}`;
const users = new Set<string>(), projects = new Set<string>(), tasks = new Set<string>();
let database: PrismaClient;
async function fixture() {
  const suffix = randomUUID();
  const actorId = `${runId}-owner-${suffix}`, authorId = `${runId}-author-${suffix}`, executorId = `${runId}-exec-${suffix}`;
  for (const id of [actorId, authorId, executorId]) { await database.user.create({ data: { id, name: runId, email: `${id}@synthetic.invalid` } }); users.add(id); }
  const projectId = `${runId}-project-${suffix}`, columnId = `${runId}-column-${suffix}`, taskId = `${runId}-task-${suffix}`, itemId = `${runId}-item-${suffix}`;
  await database.project.create({ data: { id: projectId, name: runId, ownerId: actorId, columns: { create: { id: columnId, name: "Synthetic queue", color: "#123456", workflowKey: "TODO", position: 0 } } } }); projects.add(projectId);
  await database.task.create({ data: { id: taskId, projectId, columnId, title: "Original", rank: "0|0000000000000000002S", position: 1024, version: 0, checklistItems: { create: { id: itemId, text: "Original item", completed: false, position: 0 } } } }); tasks.add(taskId);
  return { actorId, authorId, executorId, projectId, taskId, itemId };
}
guardedDescribe("PostgreSQL explicit TaskRequest marker storage and two guarded boundaries", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!); url.searchParams.set("connection_limit", "5");
    database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(url) });
    // `db push` cannot create the CHECK constraints that live only in the
    // migration; the suite asserts their behaviour, so provision them first.
    await ensureTaskRequestMarkerConstraints(database);
  });
  afterAll(async () => {
    if (!database) return;
    try {
      await database.taskRequest.deleteMany({ where: { taskId: { in: [...tasks] } } });
      await database.taskCommandOperation.deleteMany({ where: { actorId: { in: [...users] } } });
      await database.checklistOperationReceipt.deleteMany({ where: { actorId: { in: [...users] } } });
      await database.project.deleteMany({ where: { id: { in: [...projects] }, name: runId } });
      await database.user.deleteMany({ where: { id: { in: [...users] }, name: runId } });
    } finally { await database.$disconnect(); }
  });
  it("has exactly the seven states and accepts every valid executor shape including both CANCELLED forms", async () => {
    const labels = await database.$queryRaw<{ label: string }[]>`SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='TaskRequestState' ORDER BY e.enumsortorder`;
    expect(labels.map(row => row.label)).toEqual(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED", "CLOSED"]);
    const f = await fixture();
    for (const state of Object.values(TaskRequestState)) {
      const choices = state === "CANCELLED" ? [null, f.executorId] : state === "DRAFT" || state === "SUBMITTED" ? [null] : [state === "COMPLETED" ? f.authorId : f.executorId];
      for (const executorId of choices) {
        expect(await database.taskRequest.create({ data: { taskId: f.taskId, contractVersion: 1, state, authorId: f.authorId, executorId } })).toMatchObject({ state, executorId });
        await database.taskRequest.delete({ where: { taskId: f.taskId } });
      }
    }
  });
  it("enforces contractVersion and executor CHECK constraints and rejects an unknown enum value", async () => {
    const f = await fixture();
    for (const [version, state, executorId] of [[0, "DRAFT", null], [2, "DRAFT", null], [1, "DRAFT", f.executorId], [1, "SUBMITTED", f.executorId], [1, "IN_PROGRESS", null], [1, "NEEDS_INFO", null], [1, "COMPLETED", null], [1, "CLOSED", null], [1, "UNKNOWN", null]] as const) {
      await expect(database.$executeRaw`INSERT INTO "TaskRequest" ("taskId","contractVersion","state","authorId","executorId") VALUES (${f.taskId},${version},${state}::"TaskRequestState",${f.authorId},${executorId})`).rejects.toMatchObject({ code: "P2010" });
      expect(await database.taskRequest.count({ where: { taskId: f.taskId } })).toBe(0);
    }
  });
  it("requires explicit version/state/author and rejects missing Task, author and executor references", async () => {
    const f = await fixture();
    await expect(database.$executeRaw`INSERT INTO "TaskRequest" ("taskId","state","authorId") VALUES (${f.taskId},'DRAFT',${f.authorId})`).rejects.toMatchObject({ code: "P2010" });
    await expect(database.$executeRaw`INSERT INTO "TaskRequest" ("taskId","contractVersion","authorId") VALUES (${f.taskId},1,${f.authorId})`).rejects.toMatchObject({ code: "P2010" });
    await expect(database.$executeRaw`INSERT INTO "TaskRequest" ("taskId","contractVersion","state") VALUES (${f.taskId},1,'DRAFT')`).rejects.toMatchObject({ code: "P2010" });
    const base = { taskId: f.taskId, contractVersion: 1, state: TaskRequestState.DRAFT, authorId: f.authorId, executorId: null };
    for (const missing of [{ taskId: `missing-${randomUUID()}` }, { authorId: `missing-${randomUUID()}` }, { state: TaskRequestState.IN_PROGRESS, executorId: `missing-${randomUUID()}` }]) {
      await expect(database.taskRequest.create({ data: { ...base, ...missing } })).rejects.toMatchObject({ code: "P2003" });
    }
  });
  it("restricts physical deletion of the Task and isolated author/executor instead of cascading or clearing", async () => {
    const f = await fixture(); await database.taskRequest.create({ data: { taskId: f.taskId, contractVersion: 1, state: "IN_PROGRESS", authorId: f.authorId, executorId: f.executorId } });
    await expect(database.task.delete({ where: { id: f.taskId } })).rejects.toMatchObject({ code: "P2003" });
    for (const id of [f.authorId, f.executorId]) await expect(database.user.delete({ where: { id } })).rejects.toMatchObject({ code: "P2003" });
    expect(await database.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toMatchObject({ authorId: f.authorId, executorId: f.executorId });
    const movedAuthor = `${runId}-renamed-author`, movedExecutor = `${runId}-renamed-exec`, movedTask = `${runId}-renamed-task`;
    await database.user.update({ where: { id: f.authorId }, data: { id: movedAuthor } }); users.add(movedAuthor);
    await database.user.update({ where: { id: f.executorId }, data: { id: movedExecutor } }); users.add(movedExecutor);
    await database.task.update({ where: { id: f.taskId }, data: { id: movedTask } }); tasks.add(movedTask);
    expect(await database.taskRequest.findUniqueOrThrow({ where: { taskId: movedTask } })).toMatchObject({ authorId: movedAuthor, executorId: movedExecutor });
  });
  it("blocks a scalar historical receipt and a new no-op after a marker appears without touching the old commit", async () => {
    const f = await fixture(), service = createTaskCommandService(database), operationId = randomUUID();
    const input = { actorId: f.actorId, taskId: f.taskId, operationId, expectedVersion: 0, changes: { title: "Legacy changed" } };
    expect((await service.saveDetails(input)).ack.changed).toBe(true);
    await database.taskRequest.create({ data: { taskId: f.taskId, contractVersion: 1, state: "DRAFT", authorId: f.authorId, executorId: null } });
    const before = await database.task.findUniqueOrThrow({ where: { id: f.taskId } });
    await expect(service.saveDetails(input)).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" });
    await expect(service.saveDetails({ ...input, operationId: randomUUID(), expectedVersion: 1 })).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" });
    await expect(service.saveDetails({ ...input, actorId: f.executorId, operationId: randomUUID() })).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await database.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(1); expect(await database.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(1);
    const raw = await database.task.findUniqueOrThrow({ where: { id: f.taskId } }); expect(raw).not.toHaveProperty("request"); expect(raw).not.toHaveProperty("authorId");
  });
  it("blocks checklist replay/no-op and legacy text after marking, preserving item/Activity/receipt", async () => {
    const f = await fixture(), operationId = randomUUID();
    const input = { database, actorId: f.actorId, taskId: f.taskId, itemId: f.itemId, operationId, update: { completed: true } };
    expect((await updateChecklistItem(input)).changed).toBe(true);
    await database.taskRequest.create({ data: { taskId: f.taskId, contractVersion: 1, state: "IN_PROGRESS", authorId: f.authorId, executorId: f.executorId } });
    const before = await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } });
    for (const command of [input, { ...input, operationId: randomUUID() }, { ...input, operationId: undefined, update: { text: "Forbidden text" } }]) {
      await expect(updateChecklistItem(command)).rejects.toMatchObject({ name: "ConflictError", message: "REQUEST_LIFECYCLE_NOT_ENABLED" });
    }
    expect(await database.taskChecklistItem.findUniqueOrThrow({ where: { id: f.itemId } })).toEqual(before);
    expect(await database.activity.count({ where: { taskId: f.taskId } })).toBe(1); expect(await database.checklistOperationReceipt.count({ where: { taskId: f.taskId } })).toBe(1);
  });
});
