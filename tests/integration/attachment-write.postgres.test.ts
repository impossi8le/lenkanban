import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { appendTaskAttachments } from "@/lib/attachments/append";
import { attachmentFileUrl } from "@/lib/attachments/task-port";

// Validate the explicit approved disposable target BEFORE creating Prisma.
const value = process.env.TEST_DATABASE_URL;
if (value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.2" || url.port !== "55439"
    || decodeURIComponent(url.pathname) !== "/lenkanban_acceptance_test") throw Error("Explicit isolated acceptance PostgreSQL required");
  for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL, process.env.E2E_DATABASE_URL]) {
    if (other && new URL(other).hostname === url.hostname) throw Error("Test host must differ from other database hosts");
  }
}
const prefix = `attachment-write-${randomUUID()}`;
const projects: string[] = [], groups: string[] = [], users: string[] = [];
let db: PrismaClient;
async function fixture() {
  const suffix = randomUUID();
  const roles = ["owner", "author", "executor", "watcher", "member", "boardOnly"] as const;
  const actors = Object.fromEntries(roles.map(role => [role, `${prefix}-${role}-${suffix}`])) as Record<typeof roles[number], string>;
  for (const id of Object.values(actors)) { users.push(id); await db.user.create({ data: { id, name: prefix, email: `${id}@synthetic.invalid` } }); }
  const groupId = `${prefix}-g-${suffix}`, projectId = `${prefix}-p-${suffix}`, taskId = `${prefix}-t-${suffix}`, columnId = `${prefix}-c-${suffix}`;
  groups.push(groupId); projects.push(projectId);
  await db.responsibleGroup.create({ data: { id: groupId, name: prefix, members: { create: [{ userId: actors.executor }, { userId: actors.member }] } } });
  await db.project.create({ data: { id: projectId, name: prefix, ownerId: actors.owner, responsibleGroupId: groupId,
    members: { create: { userId: actors.boardOnly } }, columns: { create: { id: columnId, name: "Clarification", workflowKey: "COLUMN_wait", position: 0, color: "#000000" } } } });
  await db.task.create({ data: { id: taskId, title: prefix, projectId, columnId, createdById: actors.author,
    status: "COLUMN_wait", rank: "0000000000000000000001", version: 7,
    assignees: { create: { userId: actors.executor } },
    watchers: { create: { userId: actors.watcher } },
    request: { create: { state: "NEEDS_INFO", contractVersion: 1, authorId: actors.author, executorId: actors.executor, needsInfoSince: new Date("2026-10-23T10:00:00Z") } } } });
  return { ...actors, projectId, taskId, columnId };
}
function file(taskId: string) { return { url: attachmentFileUrl(taskId, randomUUID()), name: "synthetic.pdf", size: 4, mime: "application/pdf" }; }
function append(tx: Prisma.TransactionClient, f: { taskId: string; projectId: string }, actorId: string, attachment = file(f.taskId)) {
  return appendTaskAttachments(tx, { taskId: f.taskId, expectedProjectId: f.projectId, actorId, attachments: [attachment] });
}

describe.skipIf(!value)("real PostgreSQL marked attachment append", () => {
  beforeAll(async () => {
    const url = new URL(value!); url.searchParams.set("application_name", prefix); url.searchParams.set("connection_limit", "5");
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } }); await db.$connect();
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.taskRequest.deleteMany({ where: { task: { projectId: { in: projects } } } });
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.responsibleGroup.deleteMany({ where: { id: { in: groups } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally { await db.$disconnect(); }
  });

  it("allows canonical author/executor/watcher/group while preserving marker, timer and placement", async () => {
    const f = await fixture();
    const marker = await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } });
    for (const actor of [f.author, f.executor, f.watcher, f.member]) await db.$transaction(tx => append(tx, f, actor));
    expect(await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).toEqual(marker);
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ version: 11, columnId: f.columnId, status: "COLUMN_wait" });
    expect(await db.activity.count({ where: { taskId: f.taskId, action: "attachment_added" } })).toBe(4);
    expect(await db.taskCommandOperation.count({ where: { taskId: f.taskId } })).toBe(0);
  });

  it("rejects board-only and revoked watcher without metadata/version/Activity changes", async () => {
    const f = await fixture(); const first = file(f.taskId);
    await db.$transaction(tx => append(tx, f, f.watcher, first));
    await db.taskWatcher.delete({ where: { taskId_userId: { taskId: f.taskId, userId: f.watcher } } });
    const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    for (const actor of [f.boardOnly, f.watcher]) await expect(db.$transaction(tx => append(tx, f, actor))).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(1);
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { deletedAt: new Date() } });
    await expect(db.$transaction(tx => append(tx, f, f.author))).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(1);
  });

  it("deduplicates a fixed file URL and rolls back metadata/version/Activity as one transaction", async () => {
    const f = await fixture(), attachment = file(f.taskId);
    await db.$transaction(tx => append(tx, f, f.author, attachment));
    expect((await db.$transaction(tx => append(tx, f, f.author, attachment))).added).toEqual([]);
    const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    const rollback = Error("owned synthetic rollback");
    await expect(db.$transaction(async tx => { await append(tx, f, f.author); throw rollback; })).rejects.toBe(rollback);
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(1);
  });

  it("serializes actual concurrent appends at the project lock and preserves both files", async () => {
    const f = await fixture();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const first = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.projectId} FOR UPDATE`;
      enter(); await gate; return append(tx, f, f.author);
    }, { timeout: 15000 });
    await entered;
    const second = db.$transaction(tx => append(tx, f, f.executor), { timeout: 15000 });
    // Start the Prisma transaction promise now; polling observes its real PG wait.
    const settled = Promise.all([first, second]);
    try {
      await vi.waitFor(async () => {
        const [row] = await db.$queryRaw<{ waiting: bigint }[]>`SELECT count(*)::bigint AS waiting FROM pg_stat_activity WHERE application_name = ${prefix} AND wait_event_type = 'Lock'`;
        expect(Number(row.waiting)).toBeGreaterThan(0);
      }, { timeout: 5000, interval: 50 });
    } finally { release(); await settled; }
    const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    expect(task.version).toBe(9); expect(task.attachments).toHaveLength(2);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(2);
  });
});
