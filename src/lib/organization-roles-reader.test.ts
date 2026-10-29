import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationReader } from "./organization-reader";

const actorId = "admin";
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
type Query = { where: { id?: { gt: string }; OR?: ({ name: { contains: string } } | { id: { contains: string } })[] }; take: number };
function fixture() {
  let role: string | null = "ADMIN";
  const users = Array.from({ length: 123 }, (_, i) => ({ id: `person${String(i).padStart(3, "0")}`, name: `Person ${i}`,
    globalRole: i % 2 ? "ADMIN" : "USER", email: "synthetic-private@example.invalid", passwordHash: "synthetic-private", primaryDepartmentId: "private-dept" }));
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findUnique: vi.fn(async () => role === null ? null : { globalRole: role }),
      findMany: vi.fn(async ({ where, take }: Query) => users.filter(user => (!where.id || user.id > where.id.gt)
        && (!where.OR || where.OR.some(filter => "name" in filter ? user.name.toLowerCase().includes(filter.name.contains)
          : user.id.toLowerCase().includes(filter.id.contains)))).slice(0, take)),
      update: vi.fn(),
    },
    organizationState: { findUnique: vi.fn().mockResolvedValue({ version: 5 }), upsert: vi.fn(), update: vi.fn() },
    organizationOperation: { create: vi.fn() },
  };
  const transaction = vi.fn(async (read: (value: typeof tx) => Promise<unknown>) => read(tx));
  const reader = createOrganizationReader({ $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">);
  return { reader, tx, users, transaction, setRole: (value: string | null) => { role = value; } };
}

describe("minimized global role reader (mock transaction protocol)", () => {
  it("reads role/version/rows only after shared topology and actor SHARE with fresh ADMIN", async () => {
    const f = fixture(); await f.reader.roles({ actorId });
    expect(f.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(f.tx.$queryRaw.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock_shared"); expect(f.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(["organization-topology-v1"]);
    expect(f.tx.$queryRaw.mock.calls[1][0].join("?")).toContain('FROM "User" WHERE "id" = ? FOR SHARE');
    expect(f.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(f.tx.user.findUnique.mock.invocationCallOrder[0]);
    expect(f.tx.user.findUnique).toHaveBeenCalledWith({ where: { id: actorId }, select: { globalRole: true } });
    expect(f.tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(f.tx.organizationState.findUnique.mock.invocationCallOrder[0]);
  });
  it.each([null, "USER", "PROJECT_ADMIN"])("rejects current role %s before reading users or version", async role => {
    const f = fixture(); f.setRole(role);
    await expect(f.reader.roles({ actorId })).rejects.toMatchObject({ name: role === null ? "NotFoundError" : "ForbiddenError" });
    expect(f.tx.user.findMany).not.toHaveBeenCalled(); expect(f.tx.organizationState.findUnique).not.toHaveBeenCalled();
  });
  it("observes demotion while the shared topology lock waits", async () => {
    const f = fixture(); let release!: () => void;
    f.tx.$queryRaw.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const pending = f.reader.roles({ actorId }); expect(f.tx.user.findUnique).not.toHaveBeenCalled(); f.setRole("USER"); release();
    await expect(pending).rejects.toMatchObject({ name: "ForbiddenError" }); expect(f.tx.user.findMany).not.toHaveBeenCalled();
  });
  it("exposes only bounded display name and role with an explicit narrow select", async () => {
    const f = fixture(); f.users[0].name = ` ${"n".repeat(200)} `; f.users[1].name = " \t ";
    const result = await f.reader.roles({ actorId, limit: 2 });
    expect(result.items).toEqual([{ id: "person000", displayName: "n".repeat(120), globalRole: "USER" }, { id: "person001", displayName: null, globalRole: "ADMIN" }]);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|passwordHash|email|primaryDepartmentId/);
    expect(f.tx.user.findMany).toHaveBeenCalledWith({ where: {}, select: { id: true, name: true, globalRole: true }, orderBy: { id: "asc" }, take: 3 });
  });
  it("walks 123 role users once through 50/50/23 sentinel pages", async () => {
    const f = fixture(); let cursor: string | undefined; const ids: string[] = [], sizes: number[] = [];
    do { const page = await f.reader.roles({ actorId, cursor }); ids.push(...page.items.map(row => row.id)); sizes.push(page.items.length); cursor = page.nextCursor ?? undefined; } while (cursor);
    expect(sizes).toEqual([50, 50, 23]); expect(ids).toEqual(f.users.map(row => row.id)); expect(new Set(ids).size).toBe(123);
  });
  it("normalizes name/id search and binds its cursor to roles/query/version", async () => {
    const f = fixture(); const page = await f.reader.roles({ actorId, q: " PeRsOn ", limit: 1 });
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())).toEqual({ kind: "roles", id: "person000", q: "person", version: 5 });
    await f.reader.roles({ actorId, q: "person", cursor: page.nextCursor!, limit: 1 });
    expect(f.tx.user.findMany.mock.calls[1][0]).toMatchObject({ where: { id: { gt: "person000" }, OR: [
      { name: { contains: "person", mode: "insensitive" } }, { id: { contains: "person", mode: "insensitive" } },
    ] }, take: 2 });
    expect((await f.reader.roles({ actorId, q: "synthetic-private" })).items).toEqual([]);
  });
  it("returns initial version zero without creating state or writing roles/receipts", async () => {
    const f = fixture(); f.tx.organizationState.findUnique.mockResolvedValue(null); f.users.length = 0;
    expect(await f.reader.roles({ actorId })).toEqual({ items: [], nextCursor: null, version: 0 });
    for (const write of [f.tx.user.update, f.tx.organizationState.upsert, f.tx.organizationState.update, f.tx.organizationOperation.create]) expect(write).not.toHaveBeenCalled();
  });
  it("rejects stale version before retrieving user rows", async () => {
    const f = fixture(); const page = await f.reader.roles({ actorId, limit: 1 }); f.tx.user.findMany.mockClear(); f.tx.organizationState.findUnique.mockResolvedValue({ version: 6 });
    await expect(f.reader.roles({ actorId, cursor: page.nextCursor! })).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.user.findMany).not.toHaveBeenCalled();
  });
  it.each(["bad", encode({ kind: "people", id: "person1", q: "", version: 5 }), encode({ kind: "roles", id: "person1", q: "other", version: 5 }),
    encode({ kind: "roles", id: "person1", q: "", version: 5, globalRole: "ADMIN" }), encode({ kind: "roles", id: "../bad", q: "", version: 5 })])("rejects malformed or scoped cursor %# before transaction", cursor => {
    const f = fixture(); expect(() => f.reader.roles({ actorId, cursor })).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { q: "x".repeat(129) }, { actorId: "../bad" }])("rejects invalid bounded input %#", override => {
    const f = fixture(); expect(() => f.reader.roles({ actorId, ...override })).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("does not convert query failure into an empty successful role inventory", async () => {
    const f = fixture(), failure = Error("Synthetic user query failure"); f.tx.user.findMany.mockRejectedValue(failure);
    await expect(f.reader.roles({ actorId })).rejects.toBe(failure);
  });
});
