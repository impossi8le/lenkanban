import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationReader } from "./organization-reader";

type Group = { id: string; name: string; archivedAt: Date | null };
type Person = { id: string; name: string | null; primaryDepartmentId: string | null; email?: string; passwordHash?: string; globalRole?: string };
type Query = { where: { groupId?: string; id?: { gt: string }; userId?: { gt: string }; archivedAt?: null | { not: null }; OR?: { name?: { contains: string }; id?: { contains: string } }[] }; take: number };
const actorId = "admin";
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const group = (id: string): Group => ({ id, name: `Group ${id}`, archivedAt: null });
const person = (id: string): Person => ({ id, name: `Person ${id}`, primaryDepartmentId: Number(id.slice(-1)) % 2 ? "deptA" : "deptB",
  email: "synthetic-private@example.invalid", passwordHash: "synthetic-private", globalRole: "ADMIN" });
const methods = ["groups", "members", "people"] as const;
type Method = typeof methods[number];

function harness() {
  const groups = Array.from({ length: 123 }, (_, i) => group(`group${String(i).padStart(3, "0")}`));
  const people = Array.from({ length: 123 }, (_, i) => person(`user${String(i).padStart(3, "0")}`));
  let role: string | null = "ADMIN";
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    organizationState: { findUnique: vi.fn().mockResolvedValue({ version: 4 }), upsert: vi.fn(), update: vi.fn() },
    user: {
      findUnique: vi.fn(async () => role === null ? null : { globalRole: role }),
      findMany: vi.fn(async ({ where, take }: Query) => people.filter(row => (!where.id || row.id > where.id.gt)
        && (!where.OR || where.OR.some(item => item.name ? (row.name ?? "").toLowerCase().includes(item.name.contains)
          : row.id.toLowerCase().includes(item.id!.contains)))).slice(0, take)),
      update: vi.fn(),
    },
    responsibleGroup: {
      findUnique: vi.fn(async () => groups[0] ?? null),
      findMany: vi.fn(async ({ where, take }: Query) => groups.filter(row => (!where.id || row.id > where.id.gt)
        && (where.archivedAt === undefined || (where.archivedAt === null ? row.archivedAt === null : row.archivedAt !== null))).slice(0, take)),
      create: vi.fn(), update: vi.fn(),
    },
    responsibleGroupMember: {
      findMany: vi.fn(async ({ where, take }: Query) => people.filter(row => !where.userId || row.id > where.userId.gt)
        .slice(0, take).map(row => ({ groupId: where.groupId, userId: row.id, user: row }))),
      createMany: vi.fn(), deleteMany: vi.fn(),
    },
    projectMember: { createMany: vi.fn(), update: vi.fn() },
    organizationOperation: { create: vi.fn() },
  };
  const transaction = vi.fn(async (read: (value: typeof tx) => Promise<unknown>) => read(tx));
  const reader = createOrganizationReader({ $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">);
  function read(method: Method, input: { cursor?: string; limit?: number; actorId?: string } = {}) {
    return method === "members" ? reader.members({ actorId, groupId: "group000", ...input }) : reader[method]({ actorId, ...input });
  }
  return { reader, read, tx, transaction, groups, people, setRole: (value: string | null) => { role = value; } };
}

describe("groups, members and people share the organization read authorization protocol", () => {
  it.each(methods)("%s locks topology and actor before checking the fresh global role", async method => {
    const h = harness(); await h.read(method);
    expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.tx.$queryRaw.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock_shared(hashtextextended");
    expect(h.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(["organization-topology-v1"]);
    expect(h.tx.$queryRaw.mock.calls[1][0].join("?")).toContain('FROM "User" WHERE "id" = ? FOR SHARE');
    expect(h.tx.$queryRaw.mock.calls[1].slice(1)).toEqual([actorId]);
    expect(h.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(h.tx.user.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.user.findUnique).toHaveBeenCalledWith({ where: { id: actorId }, select: { globalRole: true } });
    expect(h.tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.organizationState.findUnique.mock.invocationCallOrder[0]);
  });
  it.each(methods.flatMap(method => [null, "USER", "PROJECT_ADMIN"].map(role => ({ method, role }))))("denies $method to $role before resource or version reads", async ({ method, role }) => {
    const h = harness(); h.setRole(role);
    await expect(h.read(method)).rejects.toMatchObject({ name: role === null ? "NotFoundError" : "ForbiddenError" });
    expect(h.tx.organizationState.findUnique).not.toHaveBeenCalled();
    for (const query of [h.tx.user.findMany, h.tx.responsibleGroup.findMany, h.tx.responsibleGroup.findUnique, h.tx.responsibleGroupMember.findMany]) expect(query).not.toHaveBeenCalled();
  });
  it.each(methods)("%s observes demotion during the shared topology wait", async method => {
    const h = harness(); let release!: () => void;
    h.tx.$queryRaw.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const pending = h.read(method);
    expect(h.tx.user.findUnique).not.toHaveBeenCalled();
    h.setRole("USER"); release();
    await expect(pending).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(h.tx.organizationState.findUnique).not.toHaveBeenCalled();
  });
  it.each(methods)("%s reads without state, receipt, role or membership writes", async method => {
    const h = harness(); h.tx.organizationState.findUnique.mockResolvedValue(null);
    expect(await h.read(method)).toMatchObject({ version: 0 });
    for (const write of [h.tx.organizationState.upsert, h.tx.organizationState.update, h.tx.user.update,
      h.tx.responsibleGroup.create, h.tx.responsibleGroup.update, h.tx.responsibleGroupMember.createMany,
      h.tx.responsibleGroupMember.deleteMany, h.tx.projectMember.createMany, h.tx.projectMember.update, h.tx.organizationOperation.create]) expect(write).not.toHaveBeenCalled();
  });
});

describe("version-bound cursor pagination and narrow DTOs", () => {
  it.each(methods)("walks all 123 %s exactly once without losing the 51st sentinel row", async method => {
    const h = harness(); const ids: string[] = []; let cursor: string | undefined;
    const lengths: number[] = [];
    do {
      const page = await h.read(method, { cursor });
      lengths.push(page.items.length); ids.push(...page.items.map(row => row.id));
      expect(page.version).toBe(4);
      expect(JSON.stringify(page)).not.toMatch(/synthetic-private|passwordHash|email|globalRole|archivedAt|createdAt/);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(lengths).toEqual([50, 50, 23]);
    expect(ids).toEqual((method === "groups" ? h.groups : h.people).map(row => row.id));
    expect(new Set(ids).size).toBe(123);
    const mock = method === "groups" ? h.tx.responsibleGroup.findMany : method === "members" ? h.tx.responsibleGroupMember.findMany : h.tx.user.findMany;
    for (const [query] of mock.mock.calls) expect(query.take).toBe(51);
  });
  it("minimizes people and nested member selects, including cross-department members of archived groups", async () => {
    const h = harness(); h.groups[0].archivedAt = new Date("2026-10-01T00:00:00Z");
    h.people[0].name = `  ${"n".repeat(200)}  `; h.people[1].name = " \t "; h.people[2].name = null;
    const page = await h.reader.members({ actorId, groupId: "group000" });
    expect(page.group).toEqual({ id: "group000", name: "Group group000", archived: true });
    expect(page.items[0]).toEqual({ id: "user000", displayName: "n".repeat(120), primaryDepartmentId: "deptB" });
    expect(page.items[1].displayName).toBeNull(); expect(page.items[2].displayName).toBeNull();
    expect(new Set(page.items.map(row => row.primaryDepartmentId))).toEqual(new Set(["deptA", "deptB"]));
    expect(h.tx.responsibleGroup.findUnique).toHaveBeenCalledWith({ where: { id: "group000" }, select: { id: true, name: true, archivedAt: true } });
    expect(h.tx.responsibleGroupMember.findMany).toHaveBeenCalledWith({ where: { groupId: "group000" }, orderBy: { userId: "asc" }, take: 51,
      include: { user: { select: { id: true, name: true, primaryDepartmentId: true } } } });
    await h.reader.people({ actorId });
    expect(h.tx.user.findMany).toHaveBeenCalledWith({ where: {}, select: { id: true, name: true, primaryDepartmentId: true }, orderBy: { id: "asc" }, take: 51 });
  });
  it.each(["all", "active", "archived"] as const)("queries the %s group filter with a narrow select", async archived => {
    const h = harness(); h.groups[0].archivedAt = new Date();
    const page = await h.reader.groups({ actorId, archived, limit: 100 });
    const expected = archived === "all" ? {} : archived === "active" ? { archivedAt: null } : { archivedAt: { not: null } };
    expect(h.tx.responsibleGroup.findMany).toHaveBeenCalledWith({ where: expected, select: { id: true, name: true, archivedAt: true }, orderBy: { id: "asc" }, take: 101 });
    if (archived === "archived") expect(page.items).toEqual([{ id: "group000", name: "Group group000", archived: true }]);
    if (archived === "active") expect(page.items.every(row => !row.archived)).toBe(true);
  });
  it("normalizes search and restricts it to name/id, never email or permission fields", async () => {
    const h = harness();
    const page = await h.reader.people({ actorId, q: "  USER  ", limit: 2 });
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())).toEqual({ kind: "people", id: "user001", q: "user", version: 4 });
    await h.reader.people({ actorId, q: "user ", cursor: page.nextCursor!, limit: 2 });
    expect(h.tx.user.findMany.mock.calls[1][0]).toMatchObject({ where: { OR: [
      { name: { contains: "user", mode: "insensitive" } }, { id: { contains: "user", mode: "insensitive" } },
    ], id: { gt: "user001" } }, take: 3 });
    expect((await h.reader.people({ actorId, q: "synthetic-private" })).items).toEqual([]);
  });
  it.each(methods)("rejects stale %s cursor before reading data or the target group", async method => {
    const h = harness(); const page = await h.read(method, { limit: 1 }); vi.clearAllMocks();
    h.tx.organizationState.findUnique.mockResolvedValue({ version: 5 });
    await expect(h.read(method, { cursor: page.nextCursor! })).rejects.toMatchObject({ name: "ConflictError" });
    for (const query of [h.tx.user.findMany, h.tx.responsibleGroup.findMany, h.tx.responsibleGroup.findUnique, h.tx.responsibleGroupMember.findMany]) expect(query).not.toHaveBeenCalled();
  });
  it.each(methods.flatMap(source => methods.filter(target => target !== source).map(target => ({ source, target }))))("rejects $source cursor in $target without opening a transaction", async ({ source, target }) => {
    const h = harness(); const page = await h.read(source, { limit: 1 }); vi.clearAllMocks();
    expect(() => h.read(target, { cursor: page.nextCursor! })).toThrowError(expect.objectContaining({ name: "ValidationError" }));
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it("binds member cursor to its group and people/group cursors to their normalized filters", async () => {
    const h = harness();
    const memberPage = await h.reader.members({ actorId, groupId: "group000", limit: 1 });
    const groupPage = await h.reader.groups({ actorId, archived: "active", limit: 1 });
    const peoplePage = await h.reader.people({ actorId, q: "user", limit: 1 }); vi.clearAllMocks();
    for (const run of [() => h.reader.members({ actorId, groupId: "group001", cursor: memberPage.nextCursor! }),
      () => h.reader.groups({ actorId, archived: "all", cursor: groupPage.nextCursor! }),
      () => h.reader.people({ actorId, q: "person", cursor: peoplePage.nextCursor! })]) expect(run).toThrowError(expect.objectContaining({ name: "ValidationError" }));
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it.each(["bad-json", "x".repeat(1025), encode([]), encode({ kind: "groups", id: "bad/id", archived: "all", version: 4 }),
    encode({ kind: "groups", id: "row", archived: "all", version: 4, email: "synthetic" }),
    encode({ kind: "groups", id: "row", archived: "all", version: -1 })])("rejects malformed cursor %j before database activity", cursor => {
    const h = harness(); expect(() => h.reader.groups({ actorId, cursor })).toThrowError(expect.objectContaining({ name: "ValidationError" }));
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it.each(methods.flatMap(method => [0, 101, -1, 1.5, NaN, Infinity].map(limit => ({ method, limit }))))("rejects $method limit $limit without database activity", ({ method, limit }) => {
    const h = harness(); expect(() => h.read(method, { limit })).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(h.transaction).not.toHaveBeenCalled();
  });
  it("bounds search at 128 characters after normalization and rejects coercion", async () => {
    const h = harness(); await h.reader.people({ actorId, q: ` ${"x".repeat(128)} ` }); vi.clearAllMocks();
    for (const q of ["x".repeat(129), null, 123, {}]) expect(() => h.reader.people({ actorId, q: q as string })).toThrowError(expect.objectContaining({ name: "ValidationError" }));
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it("rejects missing groups without attempting member queries", async () => {
    const h = harness(); h.groups.length = 0;
    await expect(h.reader.members({ actorId, groupId: "missing" })).rejects.toMatchObject({ name: "NotFoundError" });
    expect(h.tx.responsibleGroupMember.findMany).not.toHaveBeenCalled();
  });
  it.each(methods)("preserves %s database failures instead of inventing empty success", async method => {
    const h = harness(), failure = Error("Synthetic DB outage");
    if (method === "groups") h.tx.responsibleGroup.findMany.mockRejectedValue(failure);
    if (method === "members") h.tx.responsibleGroupMember.findMany.mockRejectedValue(failure);
    if (method === "people") h.tx.user.findMany.mockRejectedValue(failure);
    await expect(h.read(method)).rejects.toBe(failure);
  });
});
