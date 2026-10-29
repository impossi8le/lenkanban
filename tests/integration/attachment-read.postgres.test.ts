import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { attachmentFileUrl, readTaskAttachmentAccess } from "@/lib/attachments/task-port";

const value = process.env.TEST_DATABASE_URL;
if (value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.2" || url.port !== "55439"
    || decodeURIComponent(url.pathname) !== "/lenkanban_acceptance_test") throw Error("Explicit approved isolated acceptance PostgreSQL URL required");
  for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (other && new URL(other).hostname === url.hostname) throw Error("Test hostname must differ from application/production hostname");
  }
}
let db: PrismaClient;
const prefix = `attachment-read-${randomUUID()}`;
const projectIds: string[] = [], groupIds: string[] = [], userIds: string[] = [];
async function fixture() {
  const id = randomUUID();
  const actors = ["author", "executor", "member", "boardOnly"].map(role => `${prefix}-${role}-${id}`);
  for (const actor of actors) { await db.user.create({ data: { id: actor, name: prefix, email: `${actor}@example.invalid` } }); userIds.push(actor); }
  const [author, executor, member, boardOnly] = actors;
  const groupId = `${prefix}-g-${id}`, projectId = `${prefix}-p-${id}`, taskId = `${prefix}-t-${id}`;
  await db.responsibleGroup.create({ data: { id: groupId, name: prefix, members: { create: { userId: member } } } }); groupIds.push(groupId);
  await db.project.create({ data: { id: projectId, name: prefix, ownerId: author, responsibleGroupId: groupId,
    members: { create: [{ userId: member }, { userId: boardOnly }] },
    columns: { create: { id: `${prefix}-c-${id}`, name: "Closed", workflowKey: "DONE", position: 0, color: "#000000" } } } }); projectIds.push(projectId);
  const publicFile = { url: attachmentFileUrl(taskId, "00000000-0000-4000-8000-000000000001"), name: "synthetic.pdf", size: 4, mime: "application/pdf" };
  const internalFile = { ...publicFile, url: attachmentFileUrl(taskId, "00000000-0000-4000-8000-000000000002"), isInternal: true };
  await db.task.create({ data: { id: taskId, title: prefix, projectId, columnId: `${prefix}-c-${id}`, createdById: author,
    rank: "0000000000000000000001", status: "DONE", attachments: [publicFile, internalFile],
    request: { create: { contractVersion: 1, state: "CLOSED", authorId: author, executorId: executor } } } });
  return { author, executor, member, boardOnly, groupId, projectId, taskId, publicFile, internalFile };
}

describe.skipIf(!value)("real PostgreSQL canonical marked attachment reads", () => {
  beforeAll(async () => { db = new PrismaClient({ datasources: { db: { url: value! } } }); await db.$connect(); });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.taskRequest.deleteMany({ where: { task: { projectId: { in: projectIds } } } });
      await db.project.deleteMany({ where: { id: { in: projectIds } } });
      await db.responsibleGroup.deleteMany({ where: { id: { in: groupIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally { await db.$disconnect(); }
  });
  it("reads CLOSED public files for canonical author/executor/group, retains internal audience and makes no business writes", async () => {
    const f = await fixture();
    const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
    for (const actor of [f.author, f.executor]) expect(await readTaskAttachmentAccess(db, f.taskId, actor)).toMatchObject({ status: "ok", attachments: [f.publicFile] });
    expect(await readTaskAttachmentAccess(db, f.taskId, f.member)).toMatchObject({ status: "ok", attachments: [f.publicFile, f.internalFile] });
    expect(await readTaskAttachmentAccess(db, f.taskId, f.boardOnly)).toEqual({ status: "missing" });
    expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(0);
  });
  it("revokes group and canonical executor reads immediately and hides soft-deleted markers even from ADMIN", async () => {
    const f = await fixture();
    expect((await readTaskAttachmentAccess(db, f.taskId, f.member)).status).toBe("ok");
    await db.responsibleGroupMember.delete({ where: { groupId_userId: { groupId: f.groupId, userId: f.member } } });
    expect(await readTaskAttachmentAccess(db, f.taskId, f.member)).toEqual({ status: "missing" });
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { executorId: f.author } });
    expect(await readTaskAttachmentAccess(db, f.taskId, f.executor)).toEqual({ status: "missing" });
    expect((await readTaskAttachmentAccess(db, f.taskId, f.author)).status).toBe("ok");
    await db.taskRequest.update({ where: { taskId: f.taskId }, data: { deletedAt: new Date() } });
    await db.user.update({ where: { id: f.author }, data: { globalRole: "ADMIN" } });
    expect(await readTaskAttachmentAccess(db, f.taskId, f.author)).toEqual({ status: "missing" });
  });
});
