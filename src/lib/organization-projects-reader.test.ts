import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationReader } from "./organization-reader";

const actorId = "admin";
const cursor = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
type ProjectRow = { id: string; name: string; departmentId: string | null; responsibleGroupId: string | null;
  description?: string; ownerId?: string; members?: object[] };
type Query = { where: { id?: { gt: string }; OR?: ({ name: { contains: string } } | { id: { contains: string } })[] }; take: number };
function harness() {
  let role: string | null = "ADMIN";
  const rows: ProjectRow[] = Array.from({ length: 123 }, (_, i) => ({ id: `board${String(i).padStart(3, "0")}`, name: `Board ${i}`,
    departmentId: i % 2 ? "dept1" : null, responsibleGroupId: i % 3 ? "group1" : null,
    description: "synthetic-private-description", ownerId: "synthetic-private-owner", members: [{ email: "synthetic-private-email" }] }));
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(async () => role === null ? null : { globalRole: role }), update: vi.fn() },
    organizationState: { findUnique: vi.fn().mockResolvedValue({ version: 8 }), upsert: vi.fn(), update: vi.fn() },
    organizationOperation: { create: vi.fn() },
    projectMember: { createMany: vi.fn(), deleteMany: vi.fn() },
    project: {
      findMany: vi.fn(async ({ where, take }: Query) => rows.filter(row => (!where.id || row.id > where.id.gt)
        && (!where.OR || where.OR.some(filter => "name" in filter ? row.name.toLowerCase().includes(filter.name.contains)
          : row.id.toLowerCase().includes(filter.id.contains)))).slice(0, take)),
      update: vi.fn(),
    },
  };
  const transaction = vi.fn(async (read: (value: typeof tx) => Promise<unknown>) => read(tx));
  const reader = createOrganizationReader({ $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">);
  return { reader, tx, rows, transaction, setRole: (value: string | null) => { role = value; } };
}

describe("project metadata reader protocol (mocked database, no concurrency claim)", () => {
  it("takes shared topology then actor SHARE before fresh ADMIN and version/rows in ReadCommitted", async () => {
    const h = harness(); await h.reader.projects({ actorId });
    expect(h.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.tx.$queryRaw.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock_shared(hashtextextended");
    expect(h.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(["organization-topology-v1"]);
    expect(h.tx.$queryRaw.mock.calls[1][0].join("?")).toContain('FROM "User" WHERE "id" = ? FOR SHARE');
    expect(h.tx.$queryRaw.mock.calls[1].slice(1)).toEqual([actorId]);
    expect(h.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(h.tx.user.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.user.findUnique).toHaveBeenCalledWith({ where: { id: actorId }, select: { globalRole: true } });
    expect(h.tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.organizationState.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.organizationState.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.project.findMany.mock.invocationCallOrder[0]);
  });
  it.each([null, "USER", "PROJECT_ADMIN"])("denies current role %s before version and metadata reads", async role => {
    const h = harness(); h.setRole(role);
    await expect(h.reader.projects({ actorId })).rejects.toMatchObject({ name: role === null ? "NotFoundError" : "ForbiddenError" });
    expect(h.tx.organizationState.findUnique).not.toHaveBeenCalled(); expect(h.tx.project.findMany).not.toHaveBeenCalled();
  });
  it("observes role revocation during the shared-lock wait", async () => {
    const h = harness(); let release!: () => void;
    h.tx.$queryRaw.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const pending = h.reader.projects({ actorId }); expect(h.tx.user.findUnique).not.toHaveBeenCalled();
    h.setRole("USER"); release(); await expect(pending).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(h.tx.project.findMany).not.toHaveBeenCalled();
  });
  it("returns version zero without creating state, grants, receipts or entity writes", async () => {
    const h = harness(); h.tx.organizationState.findUnique.mockResolvedValue(null); h.rows.length = 0;
    expect(await h.reader.projects({ actorId })).toEqual({ items: [], version: 0, nextCursor: null });
    for (const write of [h.tx.organizationState.upsert, h.tx.organizationState.update, h.tx.organizationOperation.create,
      h.tx.project.update, h.tx.user.update, h.tx.projectMember.createMany, h.tx.projectMember.deleteMany]) expect(write).not.toHaveBeenCalled();
  });
  it("returns only both organizational links and bounded display names, selecting no board contents", async () => {
    const h = harness(); h.rows[0].name = ` ${"n".repeat(200)} `; h.rows[1].name = " \t ";
    const result = await h.reader.projects({ actorId, limit: 2 });
    expect(result.items).toEqual([
      { id: "board000", displayName: "n".repeat(120), departmentId: null, responsibleGroupId: null },
      { id: "board001", displayName: null, departmentId: "dept1", responsibleGroupId: "group1" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|description|ownerId|members/);
    expect(h.tx.project.findMany).toHaveBeenCalledWith({ where: {}, select: { id: true, name: true, departmentId: true, responsibleGroupId: true }, orderBy: { id: "asc" }, take: 3 });
  });
  it("walks 123 ordered projects without losing sentinel rows, duplicates or opaque cursor continuity", async () => {
    const h = harness(), ids: string[] = [], sizes: number[] = []; let next: string | undefined;
    do {
      const page = await h.reader.projects({ actorId, cursor: next });
      ids.push(...page.items.map(row => row.id)); sizes.push(page.items.length); next = page.nextCursor ?? undefined;
    } while (next);
    expect(sizes).toEqual([50, 50, 23]); expect(ids).toEqual(h.rows.map(row => row.id)); expect(new Set(ids).size).toBe(123);
    expect(h.tx.project.findMany.mock.calls[1][0]).toMatchObject({ where: { id: { gt: "board049" } }, take: 51 });
  });
  it("normalizes search, binds cursor to normalized query, and searches only name OR ID", async () => {
    const h = harness(); const first = await h.reader.projects({ actorId, q: "  BoArD  ", limit: 1 });
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual({ kind: "projects", id: "board000", q: "board", version: 8 });
    await h.reader.projects({ actorId, q: "board", cursor: first.nextCursor!, limit: 1 });
    expect(h.tx.project.findMany.mock.calls[1][0]).toMatchObject({ where: { id: { gt: "board000" }, OR: [
      { name: { contains: "board", mode: "insensitive" } }, { id: { contains: "board", mode: "insensitive" } },
    ] }, take: 2 });
    expect((await h.reader.projects({ actorId, q: "synthetic-private-description" })).items).toEqual([]);
  });
  it("rejects stale cursor before reading project metadata", async () => {
    const h = harness(); const first = await h.reader.projects({ actorId, limit: 1 }); h.tx.project.findMany.mockClear();
    h.tx.organizationState.findUnique.mockResolvedValue({ version: 9 });
    await expect(h.reader.projects({ actorId, cursor: first.nextCursor! })).rejects.toMatchObject({ name: "ConflictError" });
    expect(h.tx.project.findMany).not.toHaveBeenCalled();
  });
  it.each([
    "bad-json", "x".repeat(1025), cursor([]), cursor({ kind: "people", id: "board1", q: "", version: 8 }),
    cursor({ kind: "projects", id: "board1", q: "other", version: 8 }),
    cursor({ kind: "projects", id: "board1", q: "", version: 8, ownerId: "secret" }),
    cursor({ kind: "projects", id: "../private", q: "", version: 8 }),
    cursor({ kind: "projects", id: "board1", q: "", version: -1 }),
  ])("rejects malformed or wrongly scoped cursor before transaction %#", value => {
    const h = harness(); expect(() => h.reader.projects({ actorId, cursor: value })).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(h.transaction).not.toHaveBeenCalled();
  });
  it.each([{ actorId: "../bad" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { q: "x".repeat(129) }, { q: 2 }])("rejects invalid inputs without opening a transaction %#", override => {
    const h = harness(); expect(() => h.reader.projects({ actorId, ...override } as Parameters<typeof h.reader.projects>[0])).toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(h.transaction).not.toHaveBeenCalled();
  });
  it("accepts the normalized query/limit bounds without unbounded retrieval", async () => {
    const h = harness(); await h.reader.projects({ actorId, q: ` ${"x".repeat(128)} `, limit: 100 });
    expect(h.tx.project.findMany.mock.calls[0][0]).toMatchObject({ take: 101 });
  });
  it("propagates database failure instead of fabricating an empty page", async () => {
    const h = harness(), failure = Error("Synthetic read failure"); h.tx.project.findMany.mockRejectedValue(failure);
    await expect(h.reader.projects({ actorId })).rejects.toBe(failure);
  });
});
