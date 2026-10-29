import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { createOrganizationService, type OrganizationService } from "@/lib/organization";
import { loopbackDatabaseUrl } from "./support/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const runId = `organization-${randomUUID()}`;

// Validate before constructing a client; DATABASE_URL is never a fallback.
if (testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !name.endsWith("_test") || name.includes("/") || name.includes("\\")) {
    throw Error("TEST_DATABASE_URL must name one PostgreSQL database ending in _test");
  }
  for (const applicationUrl of [process.env.DATABASE_URL, process.env.PRODUCTION_DATABASE_URL]) {
    if (applicationUrl && new URL(applicationUrl).hostname === url.hostname) {
      throw Error("TEST_DATABASE_URL hostname must differ from application and production hostnames");
    }
  }
}

let database: PrismaClient;
const users = new Set<string>();
const projects = new Set<string>();
const departments = new Set<string>();
const groups = new Set<string>();
type FixtureService = { [K in keyof OrganizationService]: (input: Omit<Parameters<OrganizationService[K]>[0], "operationId" | "expectedVersion">) => Promise<Awaited<ReturnType<OrganizationService[K]>>["result"]> };
async function commandMetadata() {
  const state = await database.organizationState.findUnique({ where: { id: "organization" } });
  return { operationId: randomUUID(), expectedVersion: state?.version ?? 0 };
}
function service(client: Pick<PrismaClient, "$transaction"> = database): FixtureService {
  const raw = createOrganizationService(client);
  return Object.fromEntries(Object.entries(raw).map(([name, method]) => [name, async (input: object) => {
    const invoke = method as (command: object) => Promise<{ result: unknown }>;
    return (await invoke({ ...input, ...await commandMetadata() })).result;
  }])) as FixtureService;
}

async function user(admin = false) {
  const row = await database.user.create({ data: {
    email: `${randomUUID()}@${runId}.invalid`, name: runId, globalRole: admin ? "ADMIN" : "USER",
  } });
  users.add(row.id);
  return row.id;
}
async function department(actorId: string, parentId: string | null = null) {
  const row = await service().createDepartment({ actorId, name: `${runId}-${randomUUID()}`, parentId });
  departments.add(row.id);
  return row.id;
}
async function group(actorId: string) {
  const row = await service().createGroup({ actorId, name: `${runId}-${randomUUID()}` });
  groups.add(row.id);
  return row.id;
}
async function project(ownerId: string) {
  const row = await database.project.create({ data: { ownerId, name: `${runId}-${randomUUID()}` } });
  projects.add(row.id);
  return row.id;
}

// Start each operation only after PostgreSQL confirms its predecessor is queued.
// This proves overlap instead of relying on Promise.all scheduling.
async function queued(operations: (() => Promise<unknown>)[], beforeRelease?: () => Promise<void>) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const unlocked = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const blocker = database.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"organization-topology-v1"}, 0))::text AS locked`;
    const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(backend.pid);
    await unlocked;
  }, { timeout: 20_000 });
  const pending: Promise<PromiseSettledResult<unknown>>[] = [];
  try {
    const pid = await Promise.race([locked, blocker.then(() => { throw Error("Blocker ended before lock acquisition"); })]);
    for (const operation of operations) {
      pending.push(operation().then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason })));
      const deadline = Date.now() + 4_000;
      let waiting = 0;
      do {
        const [state] = await database.$queryRaw<{ count: number }[]>`
          WITH RECURSIVE blocked(pid) AS (
            SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
            UNION
            SELECT activity.pid FROM pg_stat_activity activity
            JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
          ) SELECT count(*)::int AS count FROM blocked
        `;
        waiting = state.count;
        if (waiting >= pending.length) break;
        await delay(20);
      } while (Date.now() < deadline);
      expect(waiting, "Service transactions must actually wait behind the organization lock").toBeGreaterThanOrEqual(pending.length);
    }
    await beforeRelease?.();
  } finally {
    release();
    await Promise.allSettled([blocker, ...pending]);
  }
  return Promise.all(pending);
}

function expectOneConflict(results: PromiseSettledResult<unknown>[]) {
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const failures = results.filter(result => result.status === "rejected");
  expect(failures).toHaveLength(1);
  expect(failures[0].reason).toBeInstanceOf(ConflictError);
}

describeWithDatabase("PostgreSQL organization topology and atomicity", () => {
  beforeAll(() => {
    const url = new URL(testDatabaseUrl!);
    url.searchParams.set("connection_limit", "5");
    database = new PrismaClient({ datasourceUrl: loopbackDatabaseUrl(url) });
  });
  afterAll(async () => {
    if (!database) return;
    try {
      await database.project.deleteMany({ where: { id: { in: [...projects] }, name: { startsWith: runId } } });
      await database.organizationOperation.deleteMany({ where: { actorId: { in: [...users] } } });
      await database.responsibleGroupMember.deleteMany({ where: { groupId: { in: [...groups] } } });
      await database.user.updateMany({ where: { id: { in: [...users] } }, data: { primaryDepartmentId: null } });
      await database.department.updateMany({ where: { id: { in: [...departments] } }, data: { parentId: null, leaderId: null } });
      await database.responsibleGroup.deleteMany({ where: { id: { in: [...groups] }, name: { startsWith: runId } } });
      await database.department.deleteMany({ where: { id: { in: [...departments] }, name: { startsWith: runId } } });
      await database.user.deleteMany({ where: { id: { in: [...users] }, email: { contains: runId } } });
    } finally {
      await database.$disconnect();
    }
  });

  it("rolls back a new privilege profile if mandatory audit persistence fails", async () => {
    const actorId = await user(true);
    const metadata = await commandMetadata();
    const createdIds: string[] = [];
    const failure = Error("Synthetic profile audit rejection");
    const failingDatabase = {
      $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: {
        isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number;
      }) => database.$transaction(tx => operation(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "privilegeProfile") return new Proxy(target.privilegeProfile, {
            get(delegate, key, delegateReceiver) {
              if (key === "create") return async (args: Prisma.PrivilegeProfileCreateArgs) => {
                const row = await delegate.create(args); createdIds.push(row.id); return row;
              };
              return Reflect.get(delegate, key, delegateReceiver);
            },
          });
          if (property === "organizationOperation") return new Proxy(target.organizationOperation, {
            get(delegate, key, delegateReceiver) {
              if (key === "create") return async () => { throw failure; };
              return Reflect.get(delegate, key, delegateReceiver);
            },
          });
          return Reflect.get(target, property, receiver);
        },
      })), options)) as unknown as PrismaClient["$transaction"],
    };
    try {
      await expect(createOrganizationService(failingDatabase).createPrivilegeProfile({ actorId, ...metadata, name: `${runId}-profile`, permissions: ["request.read"] })).rejects.toBe(failure);
      expect(createdIds).toHaveLength(1);
      expect(await database.privilegeProfile.count({ where: { id: { in: createdIds } } })).toBe(0);
      expect(await database.organizationOperation.count({ where: { actorId, operationId: metadata.operationId } })).toBe(0);
      expect((await database.organizationState.findUnique({ where: { id: "organization" } }))?.version ?? 0).toBe(metadata.expectedVersion);
    } finally {
      await database.privilegeProfile.deleteMany({ where: { id: { in: createdIds } } });
    }
  });

  it("keeps natural board assignment identity across no-op/revoke/regrant and rolls back failed audit", async () => {
    const actorId = await user(true);
    const userId = await user();
    const projectId = await project(actorId);
    const raw = createOrganizationService(database);
    const profile = await raw.createPrivilegeProfile({ actorId, ...await commandMetadata(), name: `${runId}-assignment-profile`, permissions: ["request.read"] });
    const profileId = profile.result.id;
    const id = createHash("sha256").update(JSON.stringify([userId, profileId, "board", null, projectId])).digest("hex");
    const fields = { actorId, userId, profileId, scopeKind: "board" as const, departmentId: null, projectId };
    try {
      const first = await raw.setPrivilegeAssignment({ ...fields, ...await commandMetadata(), assigned: true });
      expect(first.result.id).toBe(id);
      const noop = await raw.setPrivilegeAssignment({ ...fields, ...await commandMetadata(), assigned: true }); expect(noop.version).toBe(first.version);
      await raw.setPrivilegeAssignment({ ...fields, ...await commandMetadata(), assigned: false }); expect(await database.scopedPrivilegeAssignment.findUnique({ where: { id } })).toBeNull();
      expect((await raw.setPrivilegeAssignment({ ...fields, ...await commandMetadata(), assigned: true })).result.id).toBe(id);
      const metadata = await commandMetadata(); const failure = Error("Synthetic assignment audit rejection");
      const failingDatabase = {
        $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: {
          isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number;
        }) => database.$transaction(tx => operation(new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== "organizationOperation") return Reflect.get(target, property, receiver);
            return new Proxy(target.organizationOperation, {
              get(delegate, key, delegateReceiver) {
                if (key === "create") return async () => { throw failure; };
                return Reflect.get(delegate, key, delegateReceiver);
              },
            });
          },
        })), options)) as unknown as PrismaClient["$transaction"],
      };
      await expect(createOrganizationService(failingDatabase).setPrivilegeAssignment({ ...fields, ...metadata, assigned: false })).rejects.toBe(failure);
      expect(await database.scopedPrivilegeAssignment.findUnique({ where: { id } })).not.toBeNull();
      expect((await database.organizationState.findUniqueOrThrow({ where: { id: "organization" } })).version).toBe(metadata.expectedVersion);
      expect(await database.organizationOperation.count({ where: { actorId, operationId: metadata.operationId } })).toBe(0);
      expect((await database.user.findUniqueOrThrow({ where: { id: userId } })).globalRole).toBe("USER");
    } finally {
      await database.scopedPrivilegeAssignment.deleteMany({ where: { id } });
      await database.privilegeProfile.deleteMany({ where: { id: profileId } });
    }
  });

  it("normalizes applicant policy no-op/replay without exposing JSON in default Project reads", async () => {
    const actorId = await user(true);
    const userId = await user();
    const projectId = await project(actorId);
    const originalProject = await database.project.findUniqueOrThrow({ where: { id: projectId } });
    const metadata = await commandMetadata();
    const raw = createOrganizationService(database);
    const policy = { allEmployees: false, userIds: [userId], departmentIds: [], groupIds: [] };
    const first = await raw.setProjectApplicantPolicy({ actorId, projectId, ...metadata, policy: { ...policy, userIds: [userId, userId] } });
    expect(first).toEqual({ result: { id: projectId, policy }, version: metadata.expectedVersion + 1, replayed: false });
    expect(await raw.setProjectApplicantPolicy({ actorId, projectId, ...metadata, policy })).toEqual({ ...first, replayed: true });
    const noop = await commandMetadata();
    expect(await raw.setProjectApplicantPolicy({ actorId, projectId, ...noop, policy })).toMatchObject({ version: first.version, replayed: false });
    const noopReceipt = await database.organizationOperation.findUniqueOrThrow({ where: { actorId_operationId: { actorId, operationId: noop.operationId } } });
    expect(noopReceipt).toMatchObject({ changed: false, before: { id: projectId, policy }, after: { id: projectId, policy } });
    const defaultProject = await database.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(defaultProject).not.toHaveProperty("applicantPolicy"); expect(defaultProject).not.toHaveProperty("applicantPolicyConfig");
    expect(defaultProject.updatedAt).toEqual(originalProject.updatedAt);
    await raw.setProjectApplicantPolicy({ actorId, projectId, ...await commandMetadata(), policy: null });
    expect(await database.projectApplicantPolicy.findUnique({ where: { projectId } })).toBeNull();
    expect(await raw.setProjectApplicantPolicy({ actorId, projectId, ...metadata, policy })).toEqual({ ...first, replayed: true });
    expect(await database.projectApplicantPolicy.findUnique({ where: { projectId } })).toBeNull();
    expect((await database.project.findUniqueOrThrow({ where: { id: projectId } })).updatedAt).toEqual(originalProject.updatedAt);
  });

  it("rolls back applicant policy row and receipt/version on mandatory audit failure, leaving Project untouched", async () => {
    const actorId = await user(true);
    const projectId = await project(actorId);
    const raw = createOrganizationService(database);
    const saved = { allEmployees: false, userIds: [], departmentIds: [], groupIds: [] };
    await raw.setProjectApplicantPolicy({ actorId, projectId, ...await commandMetadata(), policy: saved });
    const projectBefore = await database.project.findUniqueOrThrow({ where: { id: projectId } });
    const metadata = await commandMetadata();
    const failure = Error("Synthetic applicant audit rejection");
    const failingDatabase = {
      $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: {
        isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number;
      }) => database.$transaction(tx => operation(new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "organizationOperation") return Reflect.get(target, property, receiver);
          return new Proxy(target.organizationOperation, {
            get(delegate, key, delegateReceiver) {
              if (key === "create") return async () => { throw failure; };
              return Reflect.get(delegate, key, delegateReceiver);
            },
          });
        },
      })), options)) as unknown as PrismaClient["$transaction"],
    };
    await expect(createOrganizationService(failingDatabase).setProjectApplicantPolicy({ actorId, projectId, ...metadata, policy: { ...saved, allEmployees: true } })).rejects.toBe(failure);
    expect((await database.projectApplicantPolicy.findUniqueOrThrow({ where: { projectId } })).policy).toEqual(saved);
    expect(await database.organizationOperation.count({ where: { actorId, operationId: metadata.operationId } })).toBe(0);
    expect((await database.organizationState.findUniqueOrThrow({ where: { id: "organization" } })).version).toBe(metadata.expectedVersion);
    expect((await database.project.findUniqueOrThrow({ where: { id: projectId } })).updatedAt).toEqual(projectBefore.updatedAt);
  });

  it("serializes reciprocal ADMIN demotions and rejects the newly demoted second actor", async () => {
    const firstActor = await user(true);
    const secondActor = await user(true);
    const metadata = await commandMetadata();
    const secondOperationId = randomUUID();
    const raw = createOrganizationService(database);
    const outcomes = await queued([
      () => raw.setGlobalRole({ actorId: firstActor, userId: secondActor, globalRole: "USER", ...metadata }),
      () => raw.setGlobalRole({ actorId: secondActor, userId: firstActor, globalRole: "USER", ...metadata, operationId: secondOperationId }),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { name: "ForbiddenError" } });
    expect((await database.user.findUniqueOrThrow({ where: { id: firstActor } })).globalRole).toBe("ADMIN");
    expect((await database.user.findUniqueOrThrow({ where: { id: secondActor } })).globalRole).toBe("USER");
    expect(await database.organizationOperation.count({ where: { actorId: firstActor, operationId: metadata.operationId } })).toBe(1);
    expect(await database.organizationOperation.count({ where: { actorId: secondActor, operationId: secondOperationId } })).toBe(0);
  }, 30_000);

  it("rolls back role, updatedAt, receipt and global version if role audit insert fails", async () => {
    const actorId = await user(true);
    const userId = await user();
    const before = await database.user.findUniqueOrThrow({ where: { id: userId } });
    const metadata = await commandMetadata();
    const failure = Error("Synthetic role audit rejection");
    const failingDatabase = {
      $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: {
        isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number;
      }) => database.$transaction(tx => operation(new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "organizationOperation") return Reflect.get(target, property, receiver);
          return new Proxy(target.organizationOperation, {
            get(delegate, key, delegateReceiver) {
              if (key === "create") return async () => { throw failure; };
              return Reflect.get(delegate, key, delegateReceiver);
            },
          });
        },
      })), options)) as unknown as PrismaClient["$transaction"],
    };
    await expect(createOrganizationService(failingDatabase).setGlobalRole({ actorId, userId, globalRole: "ADMIN", ...metadata })).rejects.toBe(failure);
    const after = await database.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.globalRole).toBe(before.globalRole); expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await database.organizationOperation.count({ where: { actorId, operationId: metadata.operationId } })).toBe(0);
    expect((await database.organizationState.findUnique({ where: { id: "organization" } }))?.version ?? 0).toBe(metadata.expectedVersion);
  });

  it("allows exactly one reciprocal move and leaves an acyclic hierarchy", async () => {
    const actorId = await user(true);
    const a = await department(actorId);
    const b = await department(actorId);
    expectOneConflict(await queued([
      () => service().moveDepartment({ actorId, departmentId: a, parentId: b }),
      () => service().moveDepartment({ actorId, departmentId: b, parentId: a }),
    ]));
    const rows = await database.department.findMany({ where: { id: { in: [a, b] } } });
    expect(rows.filter(row => row.parentId === null)).toHaveLength(1);
    expect(rows.filter(row => row.parentId !== null)).toHaveLength(1);
    // Retry with the current global version so the domain cycle guard, rather
    // than merely optimistic concurrency, must reject the reciprocal edge.
    await expect(service().moveDepartment({ actorId, departmentId: b, parentId: a }))
      .rejects.toMatchObject({ name: "ConflictError", message: "Invalid department hierarchy" });
  }, 30_000);

  it.each(["department", "group"] as const)("serializes %s archive against project binding", async kind => {
    const actorId = await user(true);
    const resourceId = kind === "department" ? await department(actorId) : await group(actorId);
    const projectId = await project(actorId);
    expectOneConflict(await queued([
      () => kind === "department"
        ? service().setDepartmentArchived({ actorId, departmentId: resourceId, archived: true })
        : service().setGroupArchived({ actorId, groupId: resourceId, archived: true }),
      () => service().bindProject({ actorId, projectId,
        departmentId: kind === "department" ? resourceId : null,
        responsibleGroupId: kind === "group" ? resourceId : null }),
    ]));
    const row = await database.project.findUniqueOrThrow({ where: { id: projectId } });
    const resource = kind === "department"
      ? await database.department.findUniqueOrThrow({ where: { id: resourceId } })
      : await database.responsibleGroup.findUniqueOrThrow({ where: { id: resourceId } });
    const binding = kind === "department" ? row.departmentId : row.responsibleGroupId;
    expect(resource.archivedAt !== null ? binding === null : binding === resourceId).toBe(true);
    await expect(service().bindProject({ actorId, projectId,
      departmentId: kind === "department" ? resourceId : null,
      responsibleGroupId: kind === "group" ? resourceId : null }))
      .rejects.toMatchObject({ name: "ConflictError", message: "Organization resource is archived" });
  }, 30_000);

  it("keeps one primary department, with the last serialized assignment winning", async () => {
    const actorId = await user(true);
    const userId = await user();
    const a = await department(actorId);
    const b = await department(actorId);
    const results = await queued([
      () => service().assignUserDepartment({ actorId, userId, departmentId: a }),
      () => service().assignUserDepartment({ actorId, userId, departmentId: b }),
    ]);
    expectOneConflict(results);
    // The stale command must be explicitly retried with a fresh version; it
    // cannot silently overwrite a newer command after waiting for the lock.
    await service().assignUserDepartment({ actorId, userId, departmentId: b });
    expect((await database.user.findUniqueOrThrow({ where: { id: userId } })).primaryDepartmentId).toBe(b);
  }, 30_000);

  it("supports cross-department groups on two boards without granting project membership", async () => {
    const actorId = await user(true);
    const members = [await user(), await user()];
    const depts = [await department(actorId), await department(actorId)];
    const groupId = await group(actorId);
    const boards = [await project(actorId), await project(actorId)];
    for (let index = 0; index < members.length; index++) {
      await service().assignUserDepartment({ actorId, userId: members[index], departmentId: depts[index] });
      await service().setGroupMember({ actorId, groupId, userId: members[index], member: true });
      await service().bindProject({ actorId, projectId: boards[index], departmentId: depts[index], responsibleGroupId: groupId });
    }
    expect(await database.responsibleGroupMember.count({ where: { groupId } })).toBe(2);
    expect(await database.projectMember.count({ where: { projectId: { in: boards }, userId: { in: members } } })).toBe(0);
    await expect(service().setGroupArchived({ actorId, groupId, archived: true })).rejects.toBeInstanceOf(ConflictError);
    for (const projectId of boards) await service().bindProject({ actorId, projectId, departmentId: null, responsibleGroupId: null });
    await service().setGroupArchived({ actorId, groupId, archived: true });
    expect(await database.responsibleGroupMember.count({ where: { groupId } })).toBe(2);
    await service().setGroupMember({ actorId, groupId, userId: members[0], member: false });
    expect(await database.responsibleGroupMember.count({ where: { groupId } })).toBe(1);
  });

  it("rolls back completed writes if the enclosing transaction fails", async () => {
    const actorId = await user(true);
    const name = `${runId}-rollback-${randomUUID()}`;
    const failure = Error("Synthetic transaction rejection");
    const beforeVersion = (await database.organizationState.findUnique({ where: { id: "organization" } }))?.version ?? 0;
    const beforeReceipts = await database.organizationOperation.count({ where: { actorId } });
    const failingDatabase = {
      $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: {
        isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number;
      }) => database.$transaction(async tx => {
        await operation(tx);
        throw failure;
      }, options)) as unknown as PrismaClient["$transaction"],
    };
    await expect(service(failingDatabase).createDepartment({ actorId, name })).rejects.toBe(failure);
    expect(await database.department.count({ where: { name } })).toBe(0);
    expect(await database.organizationOperation.count({ where: { actorId } })).toBe(beforeReceipts);
    expect((await database.organizationState.findUnique({ where: { id: "organization" } }))?.version ?? 0).toBe(beforeVersion);
  });

  it("rechecks ADMIN after waiting for the lock rather than trusting stale authorization", async () => {
    const actorId = await user(true);
    const departmentId = await department(actorId);
    const original = await database.department.findUniqueOrThrow({ where: { id: departmentId } });
    const results = await queued([
      () => service().renameDepartment({ actorId, departmentId, name: `${runId}-forbidden` }),
    ], async () => { await database.user.update({ where: { id: actorId }, data: { globalRole: "USER" } }); });
    expect(results[0].status).toBe("rejected");
    if (results[0].status === "rejected") expect(results[0].reason).toBeInstanceOf(ForbiddenError);
    expect((await database.department.findUniqueOrThrow({ where: { id: departmentId } })).name).toBe(original.name);
  }, 30_000);

  it("rolls back entity and global version when mandatory audit persistence fails", async () => {
    const actorId = await user(true);
    const name = `${runId}-audit-failure`;
    const beforeVersion = (await database.organizationState.findUnique({ where: { id: "organization" } }))?.version ?? 0;
    const failure = Error("Synthetic audit persistence rejection");
    const failingDatabase = {
      $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: {
        isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number;
      }) => database.$transaction(tx => operation(new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "organizationOperation") return Reflect.get(target, property, receiver);
          return new Proxy(target.organizationOperation, {
            get(delegate, key, delegateReceiver) {
              if (key === "create") return async () => { throw failure; };
              return Reflect.get(delegate, key, delegateReceiver);
            },
          });
        },
      })), options)) as unknown as PrismaClient["$transaction"],
    };
    try {
      await expect(service(failingDatabase).createDepartment({ actorId, name })).rejects.toBe(failure);
      expect(await database.department.count({ where: { name } })).toBe(0);
      expect(await database.organizationOperation.count({ where: { actorId } })).toBe(0);
      expect((await database.organizationState.findUnique({ where: { id: "organization" } }))?.version ?? 0).toBe(beforeVersion);
    } finally {
      // Also collect an unexpectedly committed synthetic row for scoped cleanup.
      for (const row of await database.department.findMany({ where: { name }, select: { id: true } })) departments.add(row.id);
    }
  });

  it("replays historical group membership without resurrecting it and audits a later no-op", async () => {
    const actorId = await user(true);
    const userId = await user();
    const groupId = await group(actorId);
    const metadata = await commandMetadata();
    const raw = createOrganizationService(database);
    const add = { actorId, ...metadata, groupId, userId, member: true };
    const original = await raw.setGroupMember(add);
    await service().setGroupMember({ actorId, groupId, userId, member: false });
    const beforeReplay = await database.organizationOperation.count({ where: { actorId } });
    const replay = await raw.setGroupMember(add);
    expect(replay).toEqual({ ...original, replayed: true });
    expect(await database.responsibleGroupMember.count({ where: { groupId, userId } })).toBe(0);
    expect(await database.organizationOperation.count({ where: { actorId } })).toBe(beforeReplay);
    const noopMetadata = await commandMetadata();
    expect(await raw.setGroupMember({ actorId, ...noopMetadata, groupId, userId, member: false }))
      .toEqual({ result: { groupId, userId, member: false }, version: noopMetadata.expectedVersion, replayed: false });
    const noopReceipt = await database.organizationOperation.findUniqueOrThrow({
      where: { actorId_operationId: { actorId, operationId: noopMetadata.operationId } },
    });
    expect(noopReceipt).toMatchObject({ changed: false, committedVersion: noopMetadata.expectedVersion,
      before: { groupId, userId, member: false }, after: { groupId, userId, member: false } });
    expect(await database.organizationOperation.count({ where: { actorId } })).toBe(beforeReplay + 1);
    expect(await database.projectMember.count({ where: { userId } })).toBe(0);
  });

  it("restricts deletion of referenced departments and groups at the database boundary", async () => {
    const actorId = await user(true);
    const departmentId = await department(actorId);
    const childId = await department(actorId, departmentId);
    await expect(database.department.delete({ where: { id: departmentId } })).rejects.toMatchObject({ code: "P2003" });
    await service().moveDepartment({ actorId, departmentId: childId, parentId: null });
    const userId = await user();
    await service().assignUserDepartment({ actorId, userId, departmentId });
    await expect(database.department.delete({ where: { id: departmentId } })).rejects.toMatchObject({ code: "P2003" });
    await service().assignUserDepartment({ actorId, userId, departmentId: null });
    const groupId = await group(actorId);
    const projectId = await project(actorId);
    await service().bindProject({ actorId, projectId, departmentId, responsibleGroupId: groupId });
    await expect(database.department.delete({ where: { id: departmentId } })).rejects.toMatchObject({ code: "P2003" });
    await expect(database.responsibleGroup.delete({ where: { id: groupId } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("holds the fresh actor authorization until the organization transaction commits", async () => {
    const actorId = await user(true);
    const departmentId = await department(actorId);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const heldDatabase = {
      $transaction: ((operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: {
        isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number;
      }) => database.$transaction(async tx => {
        const result = await operation(tx);
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        ready(backend.pid);
        await unlocked;
        return result;
      }, { ...options, timeout: 20_000 })) as unknown as PrismaClient["$transaction"],
    };
    const mutation = service(heldDatabase).renameDepartment({ actorId, departmentId, name: `${runId}-authorized` });
    // Attach rejection handling immediately, including failure before ready().
    const mutationOutcome = Promise.allSettled([mutation]);
    let revoke: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([locked, mutation.then(() => { throw Error("Mutation finished before hold"); })]);
      revoke = database.user.update({ where: { id: actorId }, data: { globalRole: "USER" } }).then(row => row);
      const revokeOutcome = Promise.allSettled([revoke]);
      const deadline = Date.now() + 4_000;
      let waiting = 0;
      do {
        const [state] = await database.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        `;
        waiting = state.count;
        if (waiting > 0) break;
        await delay(20);
      } while (Date.now() < deadline);
      expect(waiting, "Role UPDATE must wait for the held actor SHARE lock").toBeGreaterThan(0);
      release();
      expect((await mutationOutcome)[0].status).toBe("fulfilled");
      expect((await revokeOutcome)[0].status).toBe("fulfilled");
    } finally {
      release();
      await Promise.allSettled([mutation, ...(revoke ? [revoke] : [])]);
    }
    expect((await database.user.findUniqueOrThrow({ where: { id: actorId } })).globalRole).toBe("USER");
    await expect(service().renameDepartment({ actorId, departmentId, name: `${runId}-denied-after-commit` })).rejects.toBeInstanceOf(ForbiddenError);
  }, 30_000);
});
