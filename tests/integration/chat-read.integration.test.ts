import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ client: null as unknown, user: vi.fn() }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: boundary.user }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return boundary.client; } }));
import { POST } from "@/app/api/tasks/[id]/messages/read/route";
import { loopbackDatabaseUrl } from "./support/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const testUrl = new URL(testDatabaseUrl);
  if (!decodeURIComponent(testUrl.pathname).includes("_test")) {
    throw new Error("TEST_DATABASE_URL database name must contain _test");
  }
  for (const value of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (value && new URL(value).hostname === testUrl.hostname) {
      throw new Error("TEST_DATABASE_URL hostname must differ from production database hostname");
    }
  }
}
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const runId = `chat-read-${randomUUID()}`;
const projects: string[] = [];
const users: string[] = [];
let database: PrismaClient;

async function fixture() {
  const id = randomUUID();
  const ownerId = `${runId}-owner-${id}`;
  const readerId = `${runId}-reader-${id}`;
  const outsiderId = `${runId}-outsider-${id}`;
  await database.user.createMany({ data: [ownerId, readerId, outsiderId].map(userId => ({
    id: userId, email: `${userId}@example.invalid`, name: runId,
  })) });
  users.push(ownerId, readerId, outsiderId);
  const projectId = `${runId}-project-${id}`;
  const columnId = `${runId}-column-${id}`;
  await database.project.create({ data: {
    id: projectId, name: runId, ownerId,
    members: { create: { userId: readerId } },
    columns: { create: { id: columnId, name: "Todo", color: "#123456", position: 0, workflowKey: "TODO" } },
  } });
  projects.push(projectId);
  const taskId = `${runId}-task-${id}`;
  const otherTaskId = `${runId}-other-${id}`;
  await database.task.createMany({ data: [taskId, otherTaskId].map((task, index) => ({
    id: task, title: runId, projectId, columnId, createdById: ownerId,
    rank: index === 0 ? "0|0000000000000000002S" : "0|0000000000000000005K",
  })) });
  await database.taskWatcher.create({ data: { taskId, userId: readerId } });
  const messageId = `${runId}-message-${id}`;
  const secondId = `${runId}-second-${id}`;
  const foreignId = `${runId}-foreign-${id}`;
  await database.chatMessage.createMany({ data: [
    { id: messageId, taskId, authorId: ownerId, readBy: { existing: "2026-01-01T00:00:00.000Z" } },
    { id: secondId, taskId, authorId: ownerId, readBy: {} },
    { id: foreignId, taskId: otherTaskId, authorId: ownerId, readBy: {} },
  ] });
  return { ownerId, readerId, outsiderId, taskId, messageId, secondId, foreignId };
}

function markRead(taskId: string, userId: string, body: unknown) {
  // POST invokes this boundary before its first await, so each request captures
  // its own user even when both real database operations run concurrently.
  boundary.user.mockResolvedValueOnce({ id: userId, globalRole: "USER" });
  return POST(new NextRequest(`http://localhost/api/tasks/${taskId}/messages/read`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: taskId }) });
}

function overlapExistingReads(taskId: string) {
  let arrivals = 0;
  let release!: () => void;
  let reject!: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bothRead = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  boundary.client = database.$extends({ query: { chatMessage: {
    async findMany({ args, query }) {
      const rows = await query(args); // The real PostgreSQL SELECT runs first.
      if (args.where?.taskId === taskId && arrivals < 2) {
        arrivals += 1;
        if (arrivals === 1) timer = setTimeout(() => reject(new Error("Read overlap barrier timed out")), 3000);
        if (arrivals === 2) { clearTimeout(timer); release(); }
        await bothRead;
      }
      return rows;
    },
  } } });
  // This barrier makes the old read/replace algorithm deterministically lose an
  // update. Atomic implementations do not issue these SELECTs and need no gate.
}

async function readBy(messageId: string) {
  return (await database.chatMessage.findUniqueOrThrow({ where: { id: messageId } })).readBy;
}

describeWithDatabase("PostgreSQL concurrent chat read receipts", () => {
  beforeAll(() => { database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(testDatabaseUrl!) }); });
  beforeEach(() => { boundary.user.mockReset(); boundary.client = database; });
  afterAll(async () => {
    if (!database) return;
    try {
      if (projects.length) await database.project.deleteMany({ where: { id: { in: projects }, name: runId } });
      if (users.length) await database.user.deleteMany({ where: { id: { in: users }, name: runId } });
    } finally { await database.$disconnect(); }
  });

  it("preserves both concurrent readers and all preexisting read receipts", async () => {
    const f = await fixture();
    overlapExistingReads(f.taskId);
    const responses = await Promise.all([
      markRead(f.taskId, f.ownerId, { messageIds: [f.messageId] }),
      markRead(f.taskId, f.readerId, { messageIds: [f.messageId] }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await readBy(f.messageId)).toEqual({
      existing: "2026-01-01T00:00:00.000Z", [f.ownerId]: expect.any(String), [f.readerId]: expect.any(String),
    });
  });

  it("counts a concurrent duplicate reader only once and preserves its first timestamp", async () => {
    const f = await fixture();
    overlapExistingReads(f.taskId);
    const responses = await Promise.all([
      markRead(f.taskId, f.readerId, { messageIds: [f.messageId] }),
      markRead(f.taskId, f.readerId, { messageIds: [f.messageId] }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results.map(result => result.markedRead).sort()).toEqual([0, 1]);
    const first = await readBy(f.messageId);
    expect(await (await markRead(f.taskId, f.readerId, { messageIds: [f.messageId] })).json()).toEqual({ ok: true, markedRead: 0 });
    expect(await readBy(f.messageId)).toEqual(first);
  });

  it("restricts explicit IDs to the authorized task and leaves undisplayed messages unread", async () => {
    const f = await fixture();
    const response = await markRead(f.taskId, f.readerId, { messageIds: [f.messageId, f.foreignId] });
    expect(await response.json()).toEqual({ ok: true, markedRead: 1 });
    expect(await readBy(f.messageId)).toHaveProperty(f.readerId);
    expect(await readBy(f.secondId)).toEqual({});
    expect(await readBy(f.foreignId)).toEqual({});
  });

  it("rejects a non-member without changing persisted receipts", async () => {
    const f = await fixture();
    const before = await readBy(f.messageId);
    expect((await markRead(f.taskId, f.outsiderId, { messageIds: [f.messageId] })).status).toBe(404);
    expect(await readBy(f.messageId)).toEqual(before);
  });

  it("keeps empty lists as no-ops and legacy bodies scoped to all messages of one task", async () => {
    const f = await fixture();
    expect(await (await markRead(f.taskId, f.readerId, { messageIds: [] })).json()).toEqual({ ok: true, markedRead: 0 });
    expect(await readBy(f.secondId)).toEqual({});
    expect(await (await markRead(f.taskId, f.readerId, {})).json()).toEqual({ ok: true, markedRead: 2 });
    expect(await readBy(f.foreignId)).toEqual({});
  });

  it("initializes nullable read receipts without changing reactions", async () => {
    const f = await fixture();
    await database.chatMessage.update({ where: { id: f.messageId }, data: {
      readBy: Prisma.DbNull, reactions: { "👍": [f.ownerId] },
    } });
    expect((await markRead(f.taskId, f.readerId, { messageIds: [f.messageId] })).status).toBe(200);
    const saved = await database.chatMessage.findUniqueOrThrow({ where: { id: f.messageId } });
    expect(saved.readBy).toEqual({ [f.readerId]: expect.any(String) });
    expect(saved.reactions).toEqual({ "👍": [f.ownerId] });
  });
});
