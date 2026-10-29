import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { consumeRateLimit } from "@/lib/rate-limit";
import { loopbackDatabaseUrl } from "./support/test-database";

vi.mock("@/lib/prisma", () => ({ prisma: {
  $queryRaw: () => { throw Error("The explicit isolated test client must be injected"); },
} }));

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const target = new URL(testUrl);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!["postgresql:", "postgres:"].includes(target.protocol) || !name.endsWith("_test") || /[\\/]/.test(name)) {
    throw Error("A separate PostgreSQL database ending in _test is required");
  }
  for (const appUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (appUrl && new URL(appUrl).hostname === target.hostname) throw Error("Test and application database hosts must differ");
  }
}
const runId = `rate-limit-test-${randomUUID()}`;
const keys = new Set<string>();
const key = (suffix: string) => { const value = `${runId}:${suffix}`; keys.add(value); return value; };
let first: PrismaClient;
let second: PrismaClient;
let inspector: PrismaClient;
const clock = new Date("2026-10-20T12:00:00.000Z");

(testUrl ? describe : describe.skip)("PostgreSQL shared rate-limit admission", () => {
  beforeAll(() => {
    const target = new URL(testUrl!);
    target.searchParams.set("connection_limit", "5");
    first = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(target) });
    second = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(target) });
    target.searchParams.set("connection_limit", "1");
    inspector = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(target) });
  });
  afterAll(async () => {
    if (!first) return;
    try { await first.rateLimit.deleteMany({ where: { key: { in: [...keys], startsWith: runId } } }); }
    finally { await Promise.allSettled([first.$disconnect(), second.$disconnect(), inspector.$disconnect()]); }
  });

  it("admits exactly the quota across two clients with genuinely overlapping row-lock waits", async () => {
    const bucket = key("concurrent");
    await first.rateLimit.create({ data: { key: bucket, count: 0, windowStart: clock } });
    let release!: () => void;
    let ready!: (pid: number) => void;
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const blocker = first.$transaction(async tx => {
      await tx.$queryRaw`SELECT "key" FROM "RateLimit" WHERE "key" = ${bucket} FOR UPDATE`;
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      ready(row.pid);
      await unlock;
    }, { timeout: 15_000 });
    let attempts: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      const pid = await Promise.race([locked, blocker.then(() => { throw Error("Blocker ended unexpectedly"); })]);
      attempts = Promise.allSettled(Array.from({ length: 20 }, (_, i) => consumeRateLimit({
        database: i % 2 ? first : second, key: bucket, limit: 5, windowMs: 60_000, now: clock,
      })));
      let blocked = 0;
      const deadline = Date.now() + 4000;
      do {
        const [row] = await inspector.$queryRaw<{ count: number }[]>`
          WITH RECURSIVE waiting(pid) AS (
            SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
            UNION
            SELECT a.pid FROM pg_stat_activity a JOIN waiting ON waiting.pid = ANY(pg_blocking_pids(a.pid))
          ) SELECT count(*)::int AS count FROM waiting
        `;
        blocked = row.count;
        if (blocked >= 2) break;
        await delay(20);
      } while (Date.now() < deadline);
      expect(blocked).toBeGreaterThanOrEqual(2);
    } finally {
      release();
      await Promise.allSettled([blocker, ...(attempts ? [attempts] : [])]);
    }
    const results = await attempts!;
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(5);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 429 });
    expect((await first.rateLimit.findUniqueOrThrow({ where: { key: bucket } })).count).toBe(5);
  }, 25_000);

  it("counts the first request at the exact expired-window boundary", async () => {
    const bucket = key("reset");
    await first.rateLimit.create({ data: { key: bucket, count: 1, windowStart: new Date(clock.getTime() - 60_000) } });
    await consumeRateLimit({ database: first, key: bucket, limit: 1, windowMs: 60_000, now: clock });
    await expect(consumeRateLimit({ database: second, key: bucket, limit: 1, windowMs: 60_000, now: clock }))
      .rejects.toMatchObject({ status: 429 });
    expect(await first.rateLimit.findUniqueOrThrow({ where: { key: bucket }, select: { count: true, windowStart: true } }))
      .toEqual({ count: 1, windowStart: clock });
  });

  it("rolls back the global increment when the actor budget rejects the same transaction", async () => {
    const global = key("global");
    const actor = key("actor");
    await first.rateLimit.createMany({ data: [{ key: global, count: 2, windowStart: clock }, { key: actor, count: 1, windowStart: clock }] });
    await expect(first.$transaction(async tx => {
      await consumeRateLimit({ database: tx, key: global, limit: 10, windowMs: 60_000, now: clock });
      await consumeRateLimit({ database: tx, key: actor, limit: 1, windowMs: 60_000, now: clock });
    })).rejects.toMatchObject({ status: 429 });
    expect((await first.rateLimit.findUniqueOrThrow({ where: { key: global } })).count).toBe(2);
    expect((await first.rateLimit.findUniqueOrThrow({ where: { key: actor } })).count).toBe(1);
  });
});
