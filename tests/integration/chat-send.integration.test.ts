import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loopbackDatabaseUrl } from "./support/test-database";

const boundary = vi.hoisted(() => ({
  client: null as unknown, notifications: [] as Promise<unknown>[],
  io: { use: vi.fn(), on: vi.fn(), to: vi.fn(), sockets: { sockets: new Map<string, TestSocket>() } },
}));
vi.mock("@prisma/client", async () => ({
  ...await vi.importActual<typeof import("@prisma/client")>("@prisma/client"),
  PrismaClient: class { constructor() { return boundary.client as PrismaClient; } },
}));
vi.mock("@/lib/prisma", () => ({ get prisma() { return boundary.client; } }));
vi.mock("socket.io", () => ({ Server: class { constructor() { return boundary.io; } } }));
vi.mock("@/lib/logger", () => ({ socketLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/notification-triggers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notification-triggers")>("@/lib/notification-triggers");
  return { ...actual, notifyChatMessage: (...args: Parameters<typeof actual.notifyChatMessage>) => {
    const pending = actual.notifyChatMessage(...args); // Real notification DB writes, observed only for draining.
    boundary.notifications.push(pending);
    return pending;
  } };
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  if (!decodeURIComponent(url.pathname).includes("_test")) throw new Error("TEST_DATABASE_URL must name a _test database");
  for (const value of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (value && new URL(value).hostname === url.hostname) throw new Error("Test and production database hostnames must differ");
  }
}
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const runId = `send-${randomUUID()}`;
const projects: string[] = [];
const users: string[] = [];
let database: PrismaClient;
const disconnects = new Set<() => void>();
function disconnectSockets() {
  for (const disconnect of disconnects) disconnect();
  disconnects.clear();
}
type SendInput = { taskId: string; clientId: string; contentText: string; attachments: unknown[] };
type Handler = (payload: SendInput, ack: (result: unknown) => void) => Promise<void>;
type TestSocket = {
  id: string;
  data: { userId: string; userName: string; globalRole: string };
  on(event: string, handler: Handler): unknown;
  emit: ReturnType<typeof vi.fn>;
  rooms: Set<string>;
  join(room: string): unknown;
  leave(room: string): unknown;
};

async function fixture() {
  const id = randomUUID();
  const a = `${runId}-a-${id}`, b = `${runId}-b-${id}`;
  await database.user.createMany({ data: [a, b].map(userId => ({
    id: userId, email: `${userId}@example.invalid`, name: runId, passwordHash: "synthetic-secret",
  })) });
  users.push(a, b);
  const projectId = `${runId}-project-${id}`, columnId = `${runId}-column-${id}`;
  await database.project.create({ data: {
    id: projectId, name: runId, ownerId: a, members: { create: { userId: b } },
    columns: { create: { id: columnId, name: "Todo", color: "#123456", position: 0, workflowKey: "TODO" } },
  } });
  projects.push(projectId);
  const taskId = `${runId}-task-${id}`, otherTaskId = `${runId}-other-${id}`;
  await database.task.createMany({ data: [taskId, otherTaskId].map((task, index) => ({
    id: task, title: runId, projectId, columnId, createdById: a,
    rank: index === 0 ? "0|0000000000000000002S" : "0|0000000000000000005K",
  })) });
  await database.taskAssignee.create({ data: { taskId, userId: b } });
  return { a, b, taskId, otherTaskId, projectId, clientId: `${runId}-client-${id}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function handlers(f: Fixture) {
  disconnectSockets();
  await Promise.allSettled(boundary.notifications);
  boundary.notifications.length = 0;
  boundary.client = database;
  vi.resetModules(); vi.clearAllMocks();
  boundary.io.sockets.sockets.clear();
  await import("@/socket/server");
  const connection = boundary.io.on.mock.calls.find(([event]) => event === "connection")?.[1];
  function asUser(userId: string) {
    const events = new Map<string, Handler>();
    const direct = vi.fn();
    const rooms = new Set<string>();
    const socket: TestSocket = { id: `socket-${userId}`, data: { userId, userName: userId, globalRole: "USER" },
      on: (event: string, handler: Handler) => events.set(event, handler), emit: direct,
      rooms,
      join: (room: string) => { rooms.add(room); },
      leave: (room: string) => { rooms.delete(room); },
    };
    boundary.io.sockets.sockets.set(socket.id, socket);
    connection(socket);
    const disconnect = events.get("disconnect");
    expect(disconnect).toBeTypeOf("function");
    disconnects.add(disconnect as unknown as () => void);
    socket.join(`task:${f.taskId}`);
    socket.join(`project:${f.projectId}`);
    return { send: events.get("message:send")!, direct };
  }
  return { a: asUser(f.a), b: asUser(f.b) };
}
async function expectInitialDelivery(h: Awaited<ReturnType<typeof handlers>>, f: Fixture) {
  await vi.waitFor(() => {
    for (const user of [h.a, h.b]) {
      expect(user.direct).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ taskId: f.taskId, clientId: f.clientId }));
    }
  });
  expect(h.a.direct.mock.calls).toEqual(h.b.direct.mock.calls);
  h.a.direct.mockClear();
  h.b.direct.mockClear();
}
const payload = (f: Fixture): SendInput => ({ taskId: f.taskId, clientId: f.clientId, contentText: "Original message", attachments: [] });
async function send(handler: Handler, input: SendInput) {
  const ack = vi.fn();
  await handler(input, ack);
  expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
}
async function drainNotifications() { await Promise.all(boundary.notifications); }

async function queueCreatesOnTask(taskId: string, start: () => Promise<void>[]) {
  let release!: () => void, ready!: (pid: number) => void;
  const unlocked = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const blocker = database.$transaction(async tx => {
    // INSERT must acquire a foreign-key row lock on Task. The second insert
    // can queue behind the first one's uncommitted unique clientId entry.
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE`;
    const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(backend.pid); await unlocked;
  }, { timeout: 20_000 });
  let outcomes: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    const pid = await Promise.race([locked, blocker.then(() => { throw new Error("Task blocker ended early"); })]);
    outcomes = Promise.allSettled(start());
    const deadline = Date.now() + 8_000;
    let waiting = 0;
    do {
      const [state] = await database.$queryRaw<{ count: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION SELECT activity.pid FROM pg_stat_activity activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        ) SELECT count(*)::int AS count FROM blocked
      `;
      waiting = state.count;
      if (waiting >= 2) break;
      await delay(20);
    } while (Date.now() < deadline);
    expect(waiting, "Both sends must reach PostgreSQL and overlap").toBeGreaterThanOrEqual(2);
  } finally {
    release();
    try { await blocker; } finally { if (outcomes) await outcomes; }
  }
  return outcomes!;
}

describeWithDatabase("PostgreSQL message send idempotency through the active socket handler", () => {
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    const url = new URL(testDatabaseUrl!); url.searchParams.set("connection_limit", "5");
    database = new actual.PrismaClient({ datasourceUrl: loopbackDatabaseUrl(url) });
  });
  afterAll(async () => {
    disconnectSockets();
    if (!database) return;
    await Promise.allSettled(boundary.notifications);
    try {
      if (users.length) await database.rateLimit.deleteMany({ where: { key: { in: users.map(id => `messages:send:${id}`) } } });
      if (projects.length) await database.project.deleteMany({ where: { id: { in: projects }, name: runId } });
      if (users.length) await database.user.deleteMany({ where: { id: { in: users }, name: runId } });
    } finally { await database.$disconnect(); }
  });

  it("confirms a retry only to its requester without another row or notification", async () => {
    const f = await fixture(), h = await handlers(f);
    await send(h.a.send, payload(f)); await drainNotifications();
    const stored = await database.chatMessage.findUniqueOrThrow({ where: { clientId: f.clientId } });
    await expectInitialDelivery(h, f);
    await send(h.a.send, payload(f)); await drainNotifications();
    expect(await database.chatMessage.count({ where: { clientId: f.clientId } })).toBe(1);
    expect(await database.notification.count({ where: { userId: f.b, type: "chat_message" } })).toBe(1);
    expect(h.b.direct).not.toHaveBeenCalled();
    expect(h.a.direct).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ id: stored.id, clientId: f.clientId }));
    const replay = h.a.direct.mock.calls[0][1];
    expect(Object.keys(replay.author).sort()).toEqual(["avatarUrl", "email", "id", "name"]);
  });

  it("commits one row and one notification when duplicate sends actually overlap in PostgreSQL", async () => {
    const f = await fixture(), h = await handlers(f);
    const results = await queueCreatesOnTask(f.taskId, () => [send(h.a.send, payload(f)), send(h.a.send, payload(f))]);
    expect(results).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    await drainNotifications();
    expect(await database.chatMessage.count({ where: { clientId: f.clientId } })).toBe(1);
    expect(await database.notification.count({ where: { userId: f.b, type: "chat_message" } })).toBe(1);
    const stored = await database.chatMessage.findUniqueOrThrow({ where: { clientId: f.clientId } });
    await vi.waitFor(() => {
      // The sender gets the initial delivery and its retry confirmation;
      // the peer gets one delivery even though both rooms match.
      expect(h.a.direct).toHaveBeenCalledTimes(2);
      expect(h.b.direct).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ id: stored.id, taskId: f.taskId, clientId: f.clientId }));
    });
    for (const call of h.a.direct.mock.calls) expect(call).toEqual(h.b.direct.mock.calls[0]);
  }, 15_000);

  it.each(["author", "task"])("rejects a clientId collision from another %s without replaying private content", async kind => {
    const f = await fixture(), h = await handlers(f);
    await send(h.a.send, payload(f)); await drainNotifications();
    const before = await database.chatMessage.findUniqueOrThrow({ where: { clientId: f.clientId } });
    await expectInitialDelivery(h, f);
    const actor = kind === "author" ? h.b : h.a;
    const ack = vi.fn();
    await actor.send({ ...payload(f), taskId: kind === "task" ? f.otherTaskId : f.taskId, contentText: "Conflicting text" }, ack);
    await drainNotifications();
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "ClientIdConflict" });
    expect(actor.direct).not.toHaveBeenCalled();
    expect(h.a.direct).not.toHaveBeenCalled();
    expect(h.b.direct).not.toHaveBeenCalled();
    expect(await database.chatMessage.findUniqueOrThrow({ where: { clientId: f.clientId } })).toEqual(before);
    expect(await database.notification.count({ where: { userId: f.b, type: "chat_message" } })).toBe(1);
  });

  it("replays the current edited message without restoring the old retry payload", async () => {
    const f = await fixture(), h = await handlers(f);
    await send(h.a.send, payload(f)); await drainNotifications();
    await expectInitialDelivery(h, f);
    const attachments = [{ url: `/api/tasks/${encodeURIComponent(f.taskId)}/files/${randomUUID()}`, name: "edited.png", size: 10, mime: "image/png" }];
    await database.task.update({ where: { id: f.taskId }, data: { attachments } });
    await database.chatMessage.update({ where: { clientId: f.clientId }, data: { contentText: "Edited message", attachments } });
    await send(h.a.send, { ...payload(f), contentText: "Changed retry text" }); await drainNotifications();
    expect(h.a.direct).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ contentText: "Edited message", attachments }));
    expect(h.b.direct).not.toHaveBeenCalled();
    expect((await database.chatMessage.findUniqueOrThrow({ where: { clientId: f.clientId } })).contentText).toBe("Edited message");
  });

  it("rejects a historical replay containing an unowned external attachment without effects", async () => {
    const f = await fixture(), h = await handlers(f);
    await send(h.a.send, payload(f)); await drainNotifications();
    await expectInitialDelivery(h, f);
    const attachments = [{ url: "https://example.invalid/unowned.png", name: "unowned.png", size: 10, mime: "image/png" }];
    const stored = await database.chatMessage.update({ where: { clientId: f.clientId }, data: { attachments } });
    const ack = vi.fn();
    await h.a.send(payload(f), ack); await drainNotifications();
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "ATTACHMENT_NOT_OWNED" });
    expect(h.a.direct).not.toHaveBeenCalled(); expect(h.b.direct).not.toHaveBeenCalled();
    expect(await database.chatMessage.count({ where: { taskId: f.taskId } })).toBe(1);
    expect(await database.chatMessage.findUniqueOrThrow({ where: { clientId: f.clientId } })).toEqual(stored);
    expect(await database.notification.count({ where: { userId: f.b, type: "chat_message" } })).toBe(1);
  });

  it("denies replay when the original author no longer has project access", async () => {
    const f = await fixture(), h = await handlers(f);
    await send(h.b.send, payload(f)); await drainNotifications();
    await expectInitialDelivery(h, f);
    await database.projectMember.delete({ where: { projectId_userId: { projectId: f.projectId, userId: f.b } } });
    const ack = vi.fn();
    await h.b.send(payload(f), ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" });
    expect(h.b.direct).not.toHaveBeenCalled();
    expect(h.a.direct).not.toHaveBeenCalled();
  });
});
