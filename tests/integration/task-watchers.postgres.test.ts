import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ db: {} as object, actors: new Map<string, { id: string; globalRole: "USER" }>(), outerRead: undefined as (() => void) | undefined }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(boundary.db, key) }) }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: async (request: Request) => boundary.actors.get(request.headers.get("x-test-actor") ?? "") }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn() } }));
import { POST, DELETE } from "@/app/api/tasks/[id]/messages/watchers/route";
const value = process.env.TEST_DATABASE_URL;
if (value) {
 const url = new URL(value);
 if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.2" || url.port !== "55439" || decodeURIComponent(url.pathname) !== "/lenkanban_acceptance_test") throw Error("Explicit approved isolated acceptance PostgreSQL URL required");
 for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) if (other && new URL(other).hostname === url.hostname) throw Error("Test hostname must differ from application/production hostname");
}
let db: PrismaClient;
const prefix = `watcher-${randomUUID()}`, projects: string[] = [], groups: string[] = [], users: string[] = [];
async function fixture() {
 const suffix = randomUUID(), [author, executor, watcher, groupReader, boardOnly] = ["author", "executor", "watcher", "group", "board"].map(role => `${prefix}-${role}-${suffix}`);
 for (const id of [author, executor, watcher, groupReader, boardOnly]) { await db.user.create({ data: { id, name: prefix, email: `${id}@example.invalid` } }); users.push(id); boundary.actors.set(id, { id, globalRole: "USER" }); }
 const groupId = `${prefix}-g-${suffix}`, projectId = `${prefix}-p-${suffix}`, taskId = `${prefix}-t-${suffix}`, columnId = `${prefix}-c-${suffix}`;
 await db.responsibleGroup.create({ data: { id: groupId, name: prefix, members: { create: [{ userId: executor }, { userId: groupReader }] } } }); groups.push(groupId);
 await db.project.create({ data: { id: projectId, name: prefix, ownerId: boardOnly, responsibleGroupId: groupId, columns: { create: { id: columnId, name: "Waiting", workflowKey: "COLUMN_waiting", color: "#000000", position: 0 } } } }); projects.push(projectId);
 await db.task.create({ data: { id: taskId, title: prefix, projectId, columnId, rank: "0000000000000000000001", status: "CLOSED", createdById: author, watchers: { create: { userId: watcher } }, request: { create: { contractVersion: 1, state: "CLOSED", authorId: author, executorId: executor, pausedTotalMs: 0 } } } });
 const publicMessage = await db.chatMessage.create({ data: { taskId, authorId: author, contentText: "Synthetic public", readBy: { other: "original" } } });
 const internalMessage = await db.chatMessage.create({ data: { taskId, authorId: executor, contentText: "Synthetic internal", isInternal: true, readBy: { other: "original" } } });
 return { author, executor, watcher, groupReader, boardOnly, projectId, taskId, publicId: publicMessage.id, internalId: internalMessage.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function mutate(f: Fixture, actorId: string, targetId: string, adding = true) { const method = adding ? "POST" : "DELETE"; return (adding ? POST : DELETE)(new NextRequest(`https://app.invalid/api/tasks/${f.taskId}/messages/watchers`, { method, headers: { "Content-Type": "application/json", "x-test-actor": actorId }, body: JSON.stringify({ userId: targetId }) }), { params: Promise.resolve({ id: f.taskId }) }); }
async function business(f: Fixture) { return { task: await db.task.findUniqueOrThrow({ where: { id: f.taskId } }), request: await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } }), project: await db.project.findUniqueOrThrow({ where: { id: f.projectId }, include: { columns: true } }), activity: await db.activity.count({ where: { taskId: f.taskId } }) }; }
describe.skipIf(!value)("real PG transactional watcher mutations", () => {
 beforeAll(async () => { db = new PrismaClient({ datasources: { db: { url: value! } } }); await db.$connect(); boundary.db = { task: { findFirst: async (...args: Parameters<typeof db.task.findFirst>) => { const result = await db.task.findFirst(...args); boundary.outerRead?.(); return result; } }, project: db.project, scopedPrivilegeAssignment: db.scopedPrivilegeAssignment, $transaction: db.$transaction.bind(db) }; });
 afterAll(async () => { if (!db) return; try { await db.taskRequest.deleteMany({ where: { task: { projectId: { in: projects } } } }); await db.project.deleteMany({ where: { id: { in: projects } } }); await db.responsibleGroup.deleteMany({ where: { id: { in: groups } } }); await db.user.deleteMany({ where: { id: { in: users } } }); } finally { await db.$disconnect(); } });
 it("serializes concurrent adds/removes into one marked version and Activity per real change", async () => {
  const f = await fixture(), before = await business(f);
  const responses = await Promise.all([mutate(f, f.watcher, f.boardOnly), mutate(f, f.watcher, f.boardOnly)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
  expect(await db.taskWatcher.count({ where: { taskId: f.taskId, userId: f.boardOnly } })).toBe(1);
  const afterAdd = await business(f); expect(afterAdd.task.version).toBe(before.task.version + 1); expect(afterAdd.request).toEqual(before.request); expect(afterAdd.project).toEqual(before.project);
  const activity = await db.activity.findMany({ where: { taskId: f.taskId } }); expect(activity).toHaveLength(1); expect(activity[0]).toMatchObject({ userId: f.watcher, action: "watcher_added", newValue: { userId: f.boardOnly, count: 1 } });
  const removals = await Promise.all([mutate(f, f.watcher, f.boardOnly, false), mutate(f, f.watcher, f.boardOnly, false)]); expect(removals.map(response => response.status)).toEqual([200, 200]);
  expect(await db.taskWatcher.count({ where: { taskId: f.taskId, userId: f.boardOnly } })).toBe(0);
  const afterRemove = await business(f); expect(afterRemove.task.version).toBe(before.task.version + 2); expect(afterRemove.request).toEqual(before.request); expect(afterRemove.project).toEqual(before.project); expect(afterRemove.task).toEqual({ ...before.task, version: before.task.version + 2, updatedAt: afterRemove.task.updatedAt });
  expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(2);
  expect(await db.chatMessage.findMany({ where: { taskId: f.taskId }, select: { readBy: true } })).toEqual([{ readBy: { other: "original" } }, { readBy: { other: "original" } }]);
 });
 it("rechecks actual watcher revocation after outer read and before mutation", async () => {
  const f = await fixture(), before = await business(f); let release!: () => void, ready!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { ready = resolve; });
  const holder = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.projectId} FOR UPDATE`; ready(); await released; await tx.taskWatcher.delete({ where: { taskId_userId: { taskId: f.taskId, userId: f.watcher } } }); }, { timeout: 15000 });
  let request: Promise<Response> | undefined;
  try { await held; const outer = new Promise<void>(resolve => { boundary.outerRead = resolve; }); request = mutate(f, f.watcher, f.boardOnly); await outer; release(); expect((await request).status).toBe(404); }
  finally { boundary.outerRead = undefined; release(); await Promise.allSettled([holder, ...(request ? [request] : [])]); }
  expect(await business(f)).toEqual(before); expect(await db.taskWatcher.count({ where: { taskId: f.taskId, userId: f.boardOnly } })).toBe(0);
 });
 it("preserves CANCELLED participants, legacy versions, blocked-target existence and deleted marker denial", async () => {
  const f = await fixture(); await db.taskRequest.update({ where: { taskId: f.taskId }, data: { state: "CANCELLED" } }); await db.user.update({ where: { id: f.boardOnly }, data: { isBlocked: true } });
  expect((await mutate(f, f.author, f.boardOnly)).status).toBe(201);
  await db.taskRequest.update({ where: { taskId: f.taskId }, data: { deletedAt: new Date() } });
  const version = (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).version;
  expect((await mutate(f, f.author, f.boardOnly, false)).status).toBe(404); expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).version).toBe(version);
  await db.taskRequest.delete({ where: { taskId: f.taskId } });
  expect((await mutate(f, f.watcher, f.boardOnly, false)).status).toBe(200); expect((await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).version).toBe(version); expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(2);
 });
});
