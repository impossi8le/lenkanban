import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { lockProjectStatusAuthority, getProjectStatusPolicy } from "@/lib/project-status-policy";
import { loopbackDatabaseUrl } from "./support/test-database";

const value = process.env.TEST_DATABASE_URL;
if (value) {
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !databaseName.endsWith("_test") || databaseName.includes("/") || databaseName.includes("\\")) throw Error("Explicit isolated PostgreSQL single-segment _test database required");
  for (const other of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) if (other && new URL(other).hostname === url.hostname) throw Error("Test hostname must differ from application/production hostname");
}
const runId = `status-lock-${randomUUID()}`;
let db: PrismaClient;
const projects: string[] = [], groups: string[] = [], users: string[] = [];
type Fixture = { actorId: string; projectId: string; groupId: string; otherGroupId: string };
async function fixture(member = true): Promise<Fixture> {
  const suffix = randomUUID(), actorId = `${runId}-u-${suffix}`, groupId = `${runId}-g-${suffix}`, otherGroupId = `${runId}-h-${suffix}`, projectId = `${runId}-p-${suffix}`;
  await db.user.create({ data: { id: actorId, email: `${suffix}@${runId}.invalid`, name: runId } }); users.push(actorId);
  // Stored leadership deliberately never substitutes for actual membership.
  await db.responsibleGroup.create({ data: { id: groupId, name: runId, leaderId: actorId, ...(member ? { members: { create: { userId: actorId } } } : {}) } }); groups.push(groupId);
  await db.responsibleGroup.create({ data: { id: otherGroupId, name: runId } }); groups.push(otherGroupId);
  await db.project.create({ data: { id: projectId, name: runId, ownerId: actorId, responsibleGroupId: groupId } }); projects.push(projectId);
  return { actorId, projectId, groupId, otherGroupId };
}
async function lockAuthority(tx: Prisma.TransactionClient, f: Fixture) {
  // Match the caller's required outer Project lock and existing actor lock.
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.projectId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.actorId} FOR SHARE`;
  return lockProjectStatusAuthority(tx, f.actorId, f.projectId);
}
async function proveMutationWaits(f: Fixture, mutate: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void, held!: (pid: number) => void, mutatorStarted!: (pid: number) => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const holding = new Promise<number>(resolve => { held = resolve; });
  const mutatorPidReady = new Promise<number>(resolve => { mutatorStarted = resolve; });
  const holder = db.$transaction(async tx => {
    expect(await lockAuthority(tx, f)).toBe(true);
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    held(row.pid);
    await released;
  }, { timeout: 15_000 });
  let mutation: Promise<unknown> | undefined;
  let primaryFailed = false;
  try {
    const holderPid = await Promise.race([holding, holder.then(() => { throw Error("Authority holder ended before ready"); })]);
    mutation = db.$transaction(async tx => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      mutatorStarted(row.pid);
      return mutate(tx);
    }, { timeout: 15_000 });
    const mutationPid = await Promise.race([mutatorPidReady, mutation.then(() => { throw Error("Mutation ended before observer became ready"); })]);
    let blocked = false;
    const deadline = Date.now() + 5_000;
    do {
      const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT ${holderPid} = ANY(pg_blocking_pids(${mutationPid}::integer)) AS blocked`;
      blocked = row.blocked;
      if (blocked) break;
      await delay(20);
    } while (Date.now() < deadline);
    expect(blocked, "PostgreSQL must report the authority transaction blocking the real mutation").toBe(true);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    release();
    const drained = await Promise.allSettled(mutation ? [holder, mutation] : [holder]);
    const rejected = drained.find(result => result.status === "rejected");
    if (!primaryFailed && rejected?.status === "rejected") throw rejected.reason;
  }
}

(value ? describe : describe.skip)("PostgreSQL project status authority JOIN locks", () => {
  beforeAll(() => {
    const url = new URL(value!); url.searchParams.set("connection_limit", "5");
    db = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(url) });
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.project.deleteMany({ where: { id: { in: projects }, name: runId } });
      await db.responsibleGroup.deleteMany({ where: { id: { in: groups }, name: runId } });
      await db.user.deleteMany({ where: { id: { in: users }, name: runId } });
    } finally { await db.$disconnect(); }
  });
  it("denies stored group leadership and project ownership without an actual member row", async () => {
    const f = await fixture(false);
    expect(await db.$transaction(tx => lockAuthority(tx, f))).toBe(false);
    expect(await getProjectStatusPolicy({ id: f.actorId, globalRole: "USER" }, f.projectId, db)).toEqual({ canChangeStatus: false });
    expect(await db.responsibleGroupMember.count({ where: { groupId: f.groupId, userId: f.actorId } })).toBe(0);
  });
  it("holds the actual membership row until commit before DELETE can revoke it", async () => {
    const f = await fixture();
    await proveMutationWaits(f, tx => tx.responsibleGroupMember.delete({ where: { groupId_userId: { groupId: f.groupId, userId: f.actorId } } }));
    expect(await db.responsibleGroupMember.count({ where: { groupId: f.groupId, userId: f.actorId } })).toBe(0);
    expect(await db.$transaction(tx => lockAuthority(tx, f))).toBe(false);
  }, 20_000);
  it("holds the active group row until commit before archive can revoke it", async () => {
    const f = await fixture();
    await proveMutationWaits(f, tx => tx.responsibleGroup.update({ where: { id: f.groupId }, data: { archivedAt: new Date() } }));
    expect((await db.responsibleGroup.findUniqueOrThrow({ where: { id: f.groupId } })).archivedAt).not.toBeNull();
    expect(await db.$transaction(tx => lockAuthority(tx, f))).toBe(false);
  }, 20_000);
  it("serializes responsible-group repointing on the caller-held Project lock", async () => {
    const f = await fixture();
    await proveMutationWaits(f, tx => tx.project.update({ where: { id: f.projectId }, data: { responsibleGroupId: f.otherGroupId } }));
    expect((await db.project.findUniqueOrThrow({ where: { id: f.projectId } })).responsibleGroupId).toBe(f.otherGroupId);
    // Old group's member row still exists but grants nothing on the new binding.
    expect(await db.responsibleGroupMember.count({ where: { groupId: f.groupId, userId: f.actorId } })).toBe(1);
    expect(await db.$transaction(tx => lockAuthority(tx, f))).toBe(false);
  }, 20_000);
});
