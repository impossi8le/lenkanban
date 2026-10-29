import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ db: {} as object, actors: new Map<string, { id: string; globalRole: "USER" }>(), outerRead: undefined as (() => void) | undefined }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(boundary.db, key) }) }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: async (request: Request) => boundary.actors.get(request.headers.get("x-test-actor") ?? "") }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn() } }));
import { POST } from "@/app/api/tasks/[id]/messages/read/route";
const value = process.env.TEST_DATABASE_URL;
if (value) {
 const url = new URL(value);
 if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.2" || url.port !== "55439" || decodeURIComponent(url.pathname) !== "/lenkanban_acceptance_test") throw Error("Explicit approved isolated acceptance PostgreSQL URL required");
 for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) if (other && new URL(other).hostname === url.hostname) throw Error("Test hostname must differ from application/production hostname");
}
let db: PrismaClient;
const prefix = `receipt-${randomUUID()}`, projects: string[] = [], groups: string[] = [], users: string[] = [];
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
function read(f: Fixture, actorId: string, body: object = {}) { return POST(new NextRequest(`https://app.invalid/api/tasks/${f.taskId}/messages/read`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-actor": actorId }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: f.taskId }) }); }
async function business(f: Fixture) { return { task: await db.task.findUniqueOrThrow({ where: { id: f.taskId } }), request: await db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } }), project: await db.project.findUniqueOrThrow({ where: { id: f.projectId }, include: { columns: true } }), activity: await db.activity.count({ where: { taskId: f.taskId } }) }; }
describe.skipIf(!value)("real PG reader-only read receipts", () => {
 beforeAll(async () => { db = new PrismaClient({ datasources: { db: { url: value! } } }); await db.$connect(); boundary.db = { task: { findFirst: async (...args: Parameters<typeof db.task.findFirst>) => { const result = await db.task.findFirst(...args); boundary.outerRead?.(); return result; } }, project: db.project, scopedPrivilegeAssignment: db.scopedPrivilegeAssignment, $transaction: db.$transaction.bind(db) }; });
 afterAll(async () => { if (!db) return; try { await db.taskRequest.deleteMany({ where: { task: { projectId: { in: projects } } } }); await db.project.deleteMany({ where: { id: { in: projects } } }); await db.responsibleGroup.deleteMany({ where: { id: { in: groups } } }); await db.user.deleteMany({ where: { id: { in: users } } }); } finally { await db.$disconnect(); } });
 it("admits CLOSED watcher/author/group readers, intersects hidden explicit IDs, preserves concurrent JSON and business rows", async () => {
  const f = await fixture(), before = await business(f);
  expect(await (await read(f, f.watcher, { messageIds: [f.internalId] })).json()).toEqual({ ok: true, markedRead: 0 });
  const results = await Promise.all([read(f, f.watcher, { messageIds: [f.publicId, f.internalId] }), read(f, f.author, { messageIds: [f.publicId, f.internalId] })]);
  expect(results.map(result => result.status)).toEqual([200, 200]); for (const result of results) expect(await result.json()).toEqual({ ok: true, markedRead: 1 });
  const first = await db.chatMessage.findUniqueOrThrow({ where: { id: f.publicId } });
  expect(first.readBy).toEqual({ other: "original", [f.author]: expect.any(String), [f.watcher]: expect.any(String) });
  expect((await db.chatMessage.findUniqueOrThrow({ where: { id: f.internalId } })).readBy).toEqual({ other: "original" });
  expect(await (await read(f, f.watcher)).json()).toEqual({ ok: true, markedRead: 0 });
  expect((await db.chatMessage.findUniqueOrThrow({ where: { id: f.publicId } })).readBy).toEqual(first.readBy);
  expect(await (await read(f, f.groupReader)).json()).toEqual({ ok: true, markedRead: 2 });
  expect((await db.chatMessage.findUniqueOrThrow({ where: { id: f.internalId } })).readBy).toEqual({ other: "original", [f.groupReader]: expect.any(String) });
  expect((await read(f, f.boardOnly, { messageIds: [] })).status).toBe(404);
  expect(await business(f)).toEqual(before);
 });
 it("rechecks actual watcher revocation after the outer read while waiting for Project lock", async () => {
  const f = await fixture(); let release!: () => void, ready!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { ready = resolve; });
  const holder = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.projectId} FOR UPDATE`; ready(); await released; await tx.taskWatcher.delete({ where: { taskId_userId: { taskId: f.taskId, userId: f.watcher } } }); }, { timeout: 15000 });
  let request: Promise<Response> | undefined;
  try { await held; const outer = new Promise<void>(resolve => { boundary.outerRead = resolve; }); request = read(f, f.watcher); await outer; release(); expect((await request).status).toBe(404); }
  finally { boundary.outerRead = undefined; release(); await Promise.allSettled([holder, ...(request ? [request] : [])]); }
  expect((await db.chatMessage.findUniqueOrThrow({ where: { id: f.publicId } })).readBy).toEqual({ other: "original" });
 });
 it("keeps drafts private and blocked/deleted marked readers denied even for empty IDs", async () => {
  const f = await fixture(); await db.taskRequest.update({ where: { taskId: f.taskId }, data: { state: "DRAFT", executorId: null } });
  expect((await read(f, f.groupReader, { messageIds: [] })).status).toBe(404); expect((await read(f, f.author, { messageIds: [] })).status).toBe(200);
  await db.user.update({ where: { id: f.author }, data: { isBlocked: true } }); expect((await read(f, f.author, { messageIds: [] })).status).toBe(404);
  await db.user.update({ where: { id: f.author }, data: { isBlocked: false } }); await db.taskRequest.update({ where: { taskId: f.taskId }, data: { deletedAt: new Date() } }); expect((await read(f, f.author, { messageIds: [] })).status).toBe(404);
 });
 it("admits a legacy watcher without task write ability and never marks hidden messages", async () => {
  const f = await fixture(); await db.taskRequest.delete({ where: { taskId: f.taskId } }); const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
  expect(await (await read(f, f.watcher)).json()).toEqual({ ok: true, markedRead: 1 });
  expect((await db.chatMessage.findUniqueOrThrow({ where: { id: f.internalId } })).readBy).toEqual({ other: "original" });
  expect(await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before); expect(await db.activity.count({ where: { taskId: f.taskId } })).toBe(0);
 });
});
