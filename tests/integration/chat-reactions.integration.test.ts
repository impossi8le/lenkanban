import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loopbackDatabaseUrl } from "./support/test-database";

const boundary = vi.hoisted(() => ({
  client: null as unknown,
  io: { use: vi.fn(), on: vi.fn(), to: vi.fn(), sockets: { sockets: new Map<string, TestSocket>() } },
}));
vi.mock("@prisma/client", async () => {
  const actual = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
  return { ...actual, PrismaClient: class { constructor() { return boundary.client as PrismaClient; } } };
});
vi.mock("socket.io", () => ({ Server: class { constructor() { return boundary.io; } } }));
vi.mock("@/lib/notification-triggers", () => ({ notifyChatMessage: vi.fn() }));
vi.mock("@/lib/logger", () => ({ socketLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const testUrl = new URL(testDatabaseUrl);
  if (!decodeURIComponent(testUrl.pathname).includes("_test")) throw new Error("TEST_DATABASE_URL must name a _test database");
  for (const value of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (value && new URL(value).hostname === testUrl.hostname) throw new Error("Test and production database hostnames must differ");
  }
}
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const runId = `reactions-${randomUUID()}`;
const projects: string[] = [];
const users: string[] = [];
let database: PrismaClient;
type ReactionInput = { taskId: string; messageId: string; emoji: string; action: "add" | "remove" };
type Handler = (payload: ReactionInput, ack: (result: unknown) => void) => Promise<void>;
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
  const [a, b, c] = ["a", "b", "c"].map(suffix => `${runId}-${suffix}-${id}`);
  await database.user.createMany({ data: [a, b, c].map(userId => ({ id: userId, email: `${userId}@example.invalid`, name: runId })) });
  users.push(a, b, c);
  const projectId = `${runId}-project-${id}`;
  const columnId = `${runId}-column-${id}`;
  await database.project.create({ data: {
    id: projectId, name: runId, ownerId: a,
    members: { create: [{ userId: b }, { userId: c }] },
    columns: { create: { id: columnId, name: "Todo", color: "#123456", position: 0, workflowKey: "TODO" } },
  } });
  projects.push(projectId);
  const taskId = `${runId}-task-${id}`;
  await database.task.create({ data: {
    id: taskId, title: runId, projectId, columnId, createdById: a, rank: "0|0000000000000000002S",
    watchers: { create: [{ userId: b }, { userId: c }] },
  } });
  const messageId = `${runId}-message-${id}`;
  await database.chatMessage.create({ data: {
    id: messageId, taskId, authorId: a, contentText: "Unchanged text",
    readBy: { [c]: "2026-01-01T00:00:00.000Z" },
  } });
  return { a, b, c, projectId, taskId, messageId };
}

async function handlers(f: Awaited<ReturnType<typeof fixture>>) {
  let arrivals = 0;
  let release!: () => void;
  let fail!: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bothRead = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  const delegate = database.chatMessage;
  // Every query still goes to PostgreSQL. Only old, OUTSIDE-transaction reads
  // are gated: both snapshots must exist before either old handler may write.
  // The real $transaction method remains bound to the original client, so its
  // locked transaction reads are not forced into an impossible two-reader gate.
  boundary.client = new Proxy(database, {
    get(target, key) {
      if (key === "chatMessage") return {
        ...delegate,
        async findUnique(args: Parameters<typeof delegate.findUnique>[0]) {
          const result = await delegate.findUnique(args);
          if (args.where.id === f.messageId && args.select?.reactions && arrivals < 2) {
            arrivals += 1;
            if (arrivals === 1) timer = setTimeout(() => fail(new Error("Reaction overlap barrier timed out")), 3000);
            if (arrivals === 2) { clearTimeout(timer); release(); }
            await bothRead;
          }
          return result;
        },
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.resetModules();
  vi.clearAllMocks();
  boundary.io.sockets.sockets.clear();
  await import("@/socket/server");
  const connection = boundary.io.on.mock.calls.find(([event]) => event === "connection")?.[1];
  function asUser(userId: string) {
    const events = new Map<string, Handler>();
    const rooms = new Set<string>();
    const socket: TestSocket = { id: `socket-${userId}`, data: { userId, userName: userId, globalRole: "USER" },
      on: (event: string, handler: Handler) => events.set(event, handler),
      emit: vi.fn(), rooms,
      join: (room: string) => { rooms.add(room); },
      leave: (room: string) => { rooms.delete(room); },
    };
    boundary.io.sockets.sockets.set(socket.id, socket);
    connection(socket);
    socket.join(`task:${f.taskId}`);
    return { react: events.get("message:react")!, socket };
  }
  const a = asUser(f.a), b = asUser(f.b);
  return { a: a.react, b: b.react, sockets: [a.socket, b.socket] };
}

async function expectReactionDelivery(h: Awaited<ReturnType<typeof handlers>>, f: Awaited<ReturnType<typeof fixture>>, count = 2) {
  await vi.waitFor(() => {
    for (const socket of h.sockets) {
      expect(socket.emit).toHaveBeenCalledTimes(count);
      for (const call of socket.emit.mock.calls) {
        expect(call).toEqual(["message:updated", expect.objectContaining({ id: f.messageId, taskId: f.taskId })]);
      }
    }
  });
  // Concurrent deliveries can finish access checks in a different order.
  const remaining = [...h.sockets[1].emit.mock.calls];
  for (const call of h.sockets[0].emit.mock.calls) {
    const index = remaining.findIndex(other => other[1] === call[1]);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(remaining.splice(index, 1)[0]).toEqual(call);
  }
}

async function send(handler: Handler, f: Awaited<ReturnType<typeof fixture>>, emoji: string, action: "add" | "remove") {
  const ack = vi.fn();
  await handler({ taskId: f.taskId, messageId: f.messageId, emoji, action }, ack);
  expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
}
async function saved(f: Awaited<ReturnType<typeof fixture>>) {
  const message = await database.chatMessage.findUniqueOrThrow({ where: { id: f.messageId } });
  expect(message.contentText).toBe("Unchanged text");
  expect(message.readBy).toEqual({ [f.c]: "2026-01-01T00:00:00.000Z" });
  return message.reactions as Record<string, string[]>;
}

async function queueOnMessageLock(messageId: string, start: () => Promise<void>[]) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const unlocked = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const blocker = database.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "ChatMessage" WHERE "id" = ${messageId} FOR UPDATE`;
    const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(backend.pid);
    await unlocked;
  }, { timeout: 20_000 });
  let outcomes: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    const blockerPid = await Promise.race([
      locked,
      blocker.then(() => { throw new Error("Message blocker ended before becoming ready"); }),
    ]);
    outcomes = Promise.allSettled(start());
    const deadline = Date.now() + 8_000;
    let waiting = 0;
    do {
      const [state] = await database.$queryRaw<{ count: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity
          WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
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
    expect(waiting, "Both reaction handlers must wait on the held message lock").toBeGreaterThanOrEqual(2);
  } finally {
    release();
    try { await blocker; }
    finally { if (outcomes) await outcomes; }
  }
  return outcomes!;
}

describeWithDatabase("PostgreSQL concurrent reactions through the active socket handler", () => {
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    // Blocker + two reaction transactions + the lock observer need four
    // connections even on a single-CPU test host; this is test-only pooling.
    const isolatedPoolUrl = new URL(testDatabaseUrl!);
    isolatedPoolUrl.searchParams.set("connection_limit", "5");
    database = new actual.PrismaClient({ datasourceUrl: loopbackDatabaseUrl(isolatedPoolUrl) });
  });
  afterAll(async () => {
    if (!database) return;
    try {
      if (projects.length) await database.project.deleteMany({ where: { id: { in: projects }, name: runId } });
      if (users.length) await database.user.deleteMany({ where: { id: { in: users }, name: runId } });
    } finally { await database.$disconnect(); }
  });

  it("preserves two users adding the same emoji and the existing reactor", async () => {
    const f = await fixture();
    await database.chatMessage.update({ where: { id: f.messageId }, data: { reactions: { "👍": [f.c] } } });
    const h = await handlers(f);
    await Promise.all([send(h.a, f, "👍", "add"), send(h.b, f, "👍", "add")]);
    expect((await saved(f))["👍"].sort()).toEqual([f.a, f.b, f.c].sort());
    await expectReactionDelivery(h, f);
  });

  it("preserves both reactors after PostgreSQL confirms their transactions are queued on one row", async () => {
    const f = await fixture();
    await database.chatMessage.update({ where: { id: f.messageId }, data: { reactions: { "👍": [f.c] } } });
    const h = await handlers(f);
    const results = await queueOnMessageLock(f.messageId, () => [
      send(h.a, f, "👍", "add"), send(h.b, f, "👍", "add"),
    ]);
    expect(results).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    expect((await saved(f))["👍"].sort()).toEqual([f.a, f.b, f.c].sort());
    await expectReactionDelivery(h, f);
  }, 15_000);

  it("preserves simultaneous additions to different emoji keys", async () => {
    const f = await fixture();
    await database.chatMessage.update({ where: { id: f.messageId }, data: { reactions: { "👀": [f.c] } } });
    const h = await handlers(f);
    await Promise.all([send(h.a, f, "👍", "add"), send(h.b, f, "❤️", "add")]);
    expect(await saved(f)).toEqual({ "👀": [f.c], "👍": [f.a], "❤️": [f.b] });
    await expectReactionDelivery(h, f);
  });

  it("preserves another user when an addition races a removal", async () => {
    const f = await fixture();
    await database.chatMessage.update({ where: { id: f.messageId }, data: { reactions: { "👍": [f.a, f.c] } } });
    const h = await handlers(f);
    await Promise.all([send(h.a, f, "👍", "remove"), send(h.b, f, "👍", "add")]);
    expect((await saved(f))["👍"].sort()).toEqual([f.b, f.c].sort());
    await expectReactionDelivery(h, f);
  });

  it("deduplicates repeated adds and makes repeated removals harmless", async () => {
    const f = await fixture();
    const h = await handlers(f);
    await Promise.all([send(h.a, f, "👍", "add"), send(h.a, f, "👍", "add")]);
    expect(await saved(f)).toEqual({ "👍": [f.a] });
    await expectReactionDelivery(h, f);
    await Promise.all([send(h.a, f, "👍", "remove"), send(h.a, f, "👍", "remove")]);
    expect(await saved(f)).toEqual({});
    await expectReactionDelivery(h, f, 4);
  });
});
