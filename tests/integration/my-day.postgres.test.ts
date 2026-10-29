import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMyDayService } from "../../src/lib/my-day-service";

const url = process.env.TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !/^\w+_test$/.test(parsed.pathname.slice(1))) throw Error("A separate PostgreSQL *_test database is required");
  for (const applicationUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (applicationUrl && new URL(applicationUrl).hostname === parsed.hostname) throw Error("Test hostname must differ from application hostname");
  }
}
const suite = url ? describe : describe.skip;
const runId = `myday-${randomUUID()}`;
const owners: string[] = [];
let database: PrismaClient;
const clock = () => new Date("2026-10-29T12:00:00Z");
const day = "2026-10-29";
type Entry = Awaited<ReturnType<ReturnType<typeof createMyDayService>["save"]>>;
function service() { return createMyDayService(database, clock); }
function save(ownerId: string, text = "Private synthetic diary", expectedVersion = 0, operationId = randomUUID()) {
  return service().save(ownerId, day, { text, expectedVersion, operationId });
}
async function fixture(admin = false) {
  const id = `${runId}-${randomUUID()}`;
  await database.user.create({ data: { id, email: `${id}@synthetic.invalid`, name: runId, globalRole: admin ? "ADMIN" : "USER" } });
  owners.push(id); return id;
}

async function overlapping(ownerId: string, existing: boolean, start: () => Promise<Entry>[]) {
  let release!: () => void, ready!: (pid: number) => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const blocker = database.$transaction(async tx => {
    if (existing) await tx.$queryRaw`SELECT "id" FROM "MyDayEntry" WHERE "ownerId" = ${ownerId} FOR UPDATE`;
    else await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE`;
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(row.pid); await released;
  }, { timeout: 20_000 });
  let outcomes: Promise<PromiseSettledResult<Entry>[]> | undefined;
  try {
    const pid = await locked; outcomes = Promise.allSettled(start());
    const deadline = Date.now() + 6_000;
    let waiting = 0;
    do {
      const [state] = await database.$queryRaw<{ count: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        ) SELECT count(*)::int AS count FROM blocked`;
      waiting = state.count;
      if (waiting >= 2) break;
      await delay(20);
    } while (Date.now() < deadline);
    expect(waiting, "Both database writers must overlap behind the held lock").toBeGreaterThanOrEqual(2);
  } finally {
    release(); await blocker;
    if (outcomes) await outcomes;
  }
  return outcomes!;
}

suite("personal diary with real PostgreSQL", () => {
  beforeAll(async () => {
    database = new PrismaClient({ datasourceUrl: url! });
    await database.$connect();
  });
  afterAll(async () => {
    if (!database) return;
    try { await database.user.deleteMany({ where: { id: { in: owners }, name: runId } }); }
    finally { await database.$disconnect(); }
  });
  it("persists exact whitespace, clears content, edits a past day and isolates ADMIN", async () => {
    const owner = await fixture(), other = await fixture(true);
    expect((await service().read(owner, day)).version).toBe(0);
    const first = await save(owner, "  Synthetic\n\ntext  ");
    expect(await service().read(owner, day)).toEqual(first);
    expect((await service().read(other, day)).text).toBe("");
    expect((await save(owner, "", 1)).version).toBe(2);
    expect((await service().save(owner, "2026-10-28", { text: "Yesterday", expectedVersion: 0, operationId: randomUUID() })).date).toBe("2026-10-28");
    await expect(service().save(owner, "2026-10-30", { text: "future", expectedVersion: 0, operationId: randomUUID() })).rejects.toMatchObject({ name: "BadRequestError" });
  });
  it("allows exactly one overlapping first writer", async () => {
    const owner = await fixture();
    const result = await overlapping(owner, false, () => [save(owner, "First"), save(owner, "Second")]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(value => value.status === "rejected")).toHaveLength(1);
    expect(await database.myDayEntry.count({ where: { ownerId: owner } })).toBe(1);
    expect((await service().read(owner, day)).version).toBe(1);
  }, 20_000);
  it("replays two overlapping identical creates into one version", async () => {
    const owner = await fixture(), operationId = randomUUID();
    const result = await overlapping(owner, false, () => [save(owner, "Same", 0, operationId), save(owner, "Same", 0, operationId)]);
    expect(result.every(value => value.status === "fulfilled")).toBe(true);
    expect((await service().read(owner, day)).version).toBe(1);
  }, 20_000);
  it("only one overlapping update wins at a version", async () => {
    const owner = await fixture(); await save(owner);
    const result = await overlapping(owner, true, () => [save(owner, "First update", 1), save(owner, "Second update", 1)]);
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(result.find(value => value.status === "rejected")).toMatchObject({ reason: { current: { version: 2 } } });
    expect((await service().read(owner, day)).version).toBe(2);
  }, 20_000);
  it("replays overlapping updates and rejects old retries after subsequent writes", async () => {
    const owner = await fixture(), operationId = randomUUID(); await save(owner);
    const result = await overlapping(owner, true, () => [save(owner, "Same update", 1, operationId), save(owner, "Same update", 1, operationId)]);
    expect(result.every(value => value.status === "fulfilled")).toBe(true);
    expect((await service().read(owner, day)).version).toBe(2);
    await save(owner, "Later update", 2);
    await expect(save(owner, "Same update", 1, operationId)).rejects.toMatchObject({ current: { text: "Later update", version: 3 } });
  }, 20_000);
  it("enforces the SQL migration's length and positive-version checks", async () => {
    const owner = await fixture(); await save(owner);
    await expect(database.myDayEntry.updateMany({ where: { ownerId: owner }, data: { version: 0 } })).rejects.toThrow();
    await expect(database.myDayEntry.updateMany({ where: { ownerId: owner }, data: { text: "x".repeat(50001) } })).rejects.toThrow();
    expect((await service().read(owner, day)).version).toBe(1);
  });
});
