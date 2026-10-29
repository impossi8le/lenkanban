import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { getProjectAccess, getTaskReadWhere, requireTaskRead, requireTaskWrite } from "@/lib/project-access";
import { projectReadPredicate } from "@/lib/access-policy";
import { NotFoundError } from "@/lib/errors";
import { loopbackDatabaseUrl } from "./support/test-database";

// Explicit opt-in only after the coordinator has provisioned and verified the
// isolated DB schema. No migration/DDL/reset/seed is performed by this suite.
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl && process.env.RUN_RESPONSIBLE_GROUP_READ_TESTS === "1";
const dbDescribe = run ? describe : describe.skip;
if (testUrl) {
  const url = new URL(testUrl), name = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !name.endsWith("_test") || /[/\\]/.test(name)) {
    throw new Error("TEST_DATABASE_URL must select one PostgreSQL database ending in _test");
  }
  for (const application of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (application && new URL(application).hostname === url.hostname) throw new Error("Test database hostname must differ from application and production hostnames");
  }
}
const runId = `group-read-${randomUUID()}`;
const users = new Set<string>(), boards = new Set<string>(), groups = new Set<string>(), taskIds = new Set<string>();
let db: PrismaClient;
async function fixture() {
  const suffix = randomUUID();
  const actorId = `${runId}-reader-${suffix}`, authorId = `${runId}-author-${suffix}`;
  for (const id of [actorId, authorId]) {
    users.add(id);
    await db.user.create({ data: { id, name: runId, email: `${id}@synthetic.invalid` } });
  }
  const groupId = `${runId}-group-${suffix}`;groups.add(groupId);
  await db.responsibleGroup.create({ data: { id: groupId, name: runId, members: { create: { userId: actorId } } } });
  const projectId = `${runId}-board-${suffix}`, columnId = `${runId}-column-${suffix}`;boards.add(projectId);
  await db.project.create({ data: { id: projectId, name: runId, ownerId: authorId, responsibleGroupId: groupId,
    columns: { create: { id: columnId, name: "Synthetic queue", workflowKey: "TODO", color: "#123456", position: 0 } } } });
  const created: string[] = [];
  for (const [index, state] of (["SUBMITTED", "DRAFT", "SUBMITTED"] as const).entries()) {
    const id = `${runId}-task-${index}-${suffix}`;taskIds.add(id);created.push(id);
    await db.task.create({ data: { id, title: `${runId}-${state}`, projectId, columnId, createdById: authorId,
      rank: `0|${String(index + 1).padStart(20, "0")}`, position: index, version: 0,
      request: { create: { contractVersion: 1, state, authorId, executorId: null, deletedAt: index === 2 ? new Date() : null } } } });
  }
  return { actor: { id: actorId, globalRole: "USER" as const }, authorId, groupId, projectId, submittedId: created[0], draftId: created[1] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function visible(f: Fixture) {
  return db.task.findMany({ where: await getTaskReadWhere(f.actor, { projectId: f.projectId }, db), select: { id: true } });
}

dbDescribe("PostgreSQL explicit configured-group board/task read without ProjectMember promotion", () => {
  beforeAll(() => { db = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testUrl!) }); });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.taskRequest.deleteMany({ where: { taskId: { in: [...taskIds] } } });
      await db.project.deleteMany({ where: { id: { in: [...boards] }, name: runId } });
      await db.responsibleGroup.deleteMany({ where: { id: { in: [...groups] }, name: runId } });
      await db.user.deleteMany({ where: { id: { in: [...users] }, name: runId } });
    } finally { await db.$disconnect(); }
  });
  it("grants group-only board read and never creates membership or write/manage rights", async () => {
    const f = await fixture();
    expect(await getProjectAccess(f.actor, f.projectId, db)).toEqual({ projectId: f.projectId, canRead: true, canWrite: false, canManageMembers: false });
    expect(await db.projectMember.count({ where: { projectId: f.projectId, userId: f.actor.id } })).toBe(0);
  });
  it("SQL list/detail and catalog counts expose a colleague's submitted request but no draft/deleted request", async () => {
    const f = await fixture();
    expect(await visible(f)).toEqual([{ id: f.submittedId }]);
    await expect(requireTaskRead(f.actor, f.submittedId, db)).resolves.toEqual({ id: f.submittedId, projectId: f.projectId });
    await expect(requireTaskRead(f.actor, f.draftId, db)).rejects.toBeInstanceOf(NotFoundError);
    const catalog = await db.project.findMany({
      where: { AND: [{ id: f.projectId }, projectReadPredicate(f.actor)] },
      select: { id: true, _count: { select: { tasks: { where: await getTaskReadWhere(f.actor, {}, db) } } } },
    });
    expect(catalog).toEqual([{ id: f.projectId, _count: { tasks: 1 } }]);
  });
  it("does not turn the exact same group read grant into legacy task mutation permission", async () => {
    const f = await fixture();
    await expect(requireTaskRead(f.actor, f.submittedId, db)).resolves.toHaveProperty("id", f.submittedId);
    await expect(requireTaskWrite(f.actor, f.submittedId, f.projectId, db)).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.task.findUniqueOrThrow({ where: { id: f.submittedId }, select: { version: true } })).version).toBe(0);
    expect(await db.activity.count({ where: { taskId: f.submittedId } })).toBe(0);
  });
  it("revokes board and task read immediately after removal from the configured group", async () => {
    const f = await fixture();
    expect(await visible(f)).toHaveLength(1);
    await db.responsibleGroupMember.delete({ where: { groupId_userId: { groupId: f.groupId, userId: f.actor.id } } });
    expect((await getProjectAccess(f.actor, f.projectId, db)).canRead).toBe(false);
    expect(await visible(f)).toEqual([]);
  });
  it("archiving the configured group revokes reads without touching ProjectMember", async () => {
    const f = await fixture();
    await db.responsibleGroup.update({ where: { id: f.groupId }, data: { archivedAt: new Date() } });
    expect((await getProjectAccess(f.actor, f.projectId, db)).canRead).toBe(false);
    expect(await visible(f)).toEqual([]);
  });
  it("an unbound group is not inferred from a ProjectMember row", async () => {
    const f = await fixture();
    await db.project.update({ where: { id: f.projectId }, data: { responsibleGroupId: null } });
    await db.projectMember.create({ data: { projectId: f.projectId, userId: f.actor.id, role: "MEMBER" } });
    expect((await getProjectAccess(f.actor, f.projectId, db)).canRead).toBe(true);
    expect(await visible(f)).toEqual([]);
    await expect(requireTaskRead(f.actor, f.submittedId, db)).rejects.toBeInstanceOf(NotFoundError);
  });
});
