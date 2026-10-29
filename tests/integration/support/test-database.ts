import type { PrismaClient } from "@prisma/client";

/**
 * Shared connection setup for the PostgreSQL integration suites.
 *
 * Why this exists: on this Windows host Prisma's query engine needs about one
 * second to open *each* new connection when the URL names the host as
 * `localhost`, while the same server reached as `127.0.0.1` connects in a few
 * milliseconds. The difference is reproducible in both orders, across separate
 * PrismaClient instances, and after a warm pool (4 cold connections: ~4 s for
 * `localhost`, ~24 ms for `127.0.0.1`). PostgreSQL itself accepts the TCP
 * connection in single-digit milliseconds, and `pg_stat_activity` shows no slow
 * authentication, so the cost is in name handling, not in the database.
 *
 * Every concurrency suite here holds a lock and then needs two *additional*
 * pooled connections to observe the waiters. With the `localhost` spelling the
 * default two-second interactive-transaction `maxWait` expired before those
 * connections existed, so the processors failed with P2028 ("Unable to start a
 * transaction in the given time") or were never visible in `pg_stat_activity`,
 * and the suites reported an empty lock queue. The suites are meant to measure
 * lock serialization, not connection establishment, so the loopback name is
 * normalized to its literal address. It is the same server: the test container
 * publishes 127.0.0.1:55433 only.
 */

/** Rewrites the `localhost` loopback name to 127.0.0.1 and keeps every other parameter. */
export function loopbackDatabaseUrl(value: string | URL): string {
  const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

/**
 * Creates the row constraints that exist only in `prisma/migrations`.
 *
 * The test database is provisioned with `prisma db push`, which writes only what
 * the Prisma datamodel can express: CHECK constraints, partial unique indexes and
 * triggers are dropped on the floor. `prisma migrate deploy` cannot replace it
 * because the migration history is not a complete chain (the first migration
 * assumes `Project` already exists), so the migration-only DDL is applied here
 * explicitly. The statements below are copied verbatim from
 * `prisma/migrations/20261021090000_task_request_marker/migration.sql`; the
 * behaviour test that follows asserts what they enforce, so a divergence shows up
 * as a failing assertion rather than a silently weaker schema.
 */
export async function ensureTaskRequestMarkerConstraints(
  database: Pick<PrismaClient, "$queryRaw" | "$executeRawUnsafe">,
): Promise<void> {
  const present = await database.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"TaskRequest"'::regclass AND contype = 'c'
  `;
  const existing = new Set(present.map(row => row.conname));
  if (!existing.has("TaskRequest_contract_version_check")) {
    await database.$executeRawUnsafe(
      `ALTER TABLE "TaskRequest" ADD CONSTRAINT "TaskRequest_contract_version_check" CHECK ("contractVersion" = 1)`,
    );
  }
  if (!existing.has("TaskRequest_executor_shape_check")) {
    await database.$executeRawUnsafe(
      `ALTER TABLE "TaskRequest" ADD CONSTRAINT "TaskRequest_executor_shape_check" CHECK (
        ("state" IN ('DRAFT', 'SUBMITTED') AND "executorId" IS NULL)
        OR ("state" IN ('IN_PROGRESS', 'NEEDS_INFO', 'COMPLETED') AND "executorId" IS NOT NULL)
        OR "state" = 'CANCELLED'
      )`,
    );
  }
}
