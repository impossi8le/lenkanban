import { Prisma, type Department, type OrganizationOperation, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { createOrganizationReader, safeOrganizationHistory } from "./organization-reader";

const now = new Date("2026-10-20T12:00:00.000Z");
const operationId = "11111111-1111-4111-8111-111111111111";
function department(id = "department1", overrides: Partial<Department> = {}): Department {
  return { id, name: "Synthetic department", parentId: null, leaderId: null, archivedAt: null,
    createdAt: now, updatedAt: now, ...overrides };
}
function snapshot(id = "department1") {
  return { id, name: "Synthetic department", parentId: null, leaderId: null, archived: false };
}
function history(overrides: Partial<OrganizationOperation> = {}): OrganizationOperation {
  return { id: "operation1", actorId: "admin1", operationId, operation: "renameDepartment", targetKind: "department",
    targetId: "department1", requestHash: "a".repeat(64), expectedVersion: 0, committedVersion: 1, changed: true,
    before: { ...snapshot(), name: "Old synthetic name" }, after: snapshot(), result: snapshot(), committedAt: now, ...overrides };
}
function cursor(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function harness() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "admin1" }]),
    user: { findUnique: vi.fn().mockResolvedValue({ globalRole: "ADMIN" }) },
    organizationState: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), update: vi.fn() },
    department: { findUnique: vi.fn().mockResolvedValue(department()), findMany: vi.fn().mockResolvedValue([]) },
    organizationOperation: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const transaction = vi.fn(async (run: (value: typeof tx) => Promise<unknown>) => run(tx));
  const reader = createOrganizationReader({ $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">);
  return { tx, transaction, reader };
}

describe("organization reader transaction protocol (mocked database)", () => {
  it.each(["departments", "history"] as const)("%s takes shared topology then actor SHARE before fresh ADMIN", async (method) => {
    const h = harness();
    await h.reader[method]({ actorId: "admin1" });
    expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.tx.$queryRaw.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock_shared(hashtextextended");
    expect(h.tx.$queryRaw.mock.calls[0].slice(1)).toEqual(["organization-topology-v1"]);
    expect(h.tx.$queryRaw.mock.calls[1][0].join("?")).toContain('FROM "User" WHERE "id" = ? FOR SHARE');
    expect(h.tx.$queryRaw.mock.calls[1].slice(1)).toEqual(["admin1"]);
    expect(h.tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(h.tx.user.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.user.findUnique).toHaveBeenCalledWith({ where: { id: "admin1" }, select: { globalRole: true } });
  });

  it("checks current role only after a delayed shared topology lock", async () => {
    const h = harness();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    h.tx.$queryRaw.mockImplementationOnce(() => barrier);
    const pending = h.reader.departments({ actorId: "admin1" });
    expect(h.tx.user.findUnique).not.toHaveBeenCalled();
    h.tx.user.findUnique.mockResolvedValue({ globalRole: "USER" });
    release();
    await expect(pending).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.tx.department.findMany).not.toHaveBeenCalled();
  });

  it.each([null, { globalRole: "USER" }, { globalRole: "PROJECT_ADMIN" }])("denies unavailable/non-global identity %# before data reads", async actor => {
    const h = harness(); h.tx.user.findUnique.mockResolvedValue(actor);
    await expect(h.reader.history({ actorId: "admin1" })).rejects.toBeInstanceOf(actor === null ? NotFoundError : ForbiddenError);
    expect(h.tx.organizationOperation.findMany).not.toHaveBeenCalled();
    expect(h.tx.organizationState.findUnique).not.toHaveBeenCalled();
  });

  it("reads initial version zero without creating or updating state", async () => {
    const h = harness();
    expect(await h.reader.departments({ actorId: "admin1" })).toEqual({ items: [], parent: null, nextCursor: null, version: 0 });
    expect(h.tx.organizationState.upsert).not.toHaveBeenCalled(); expect(h.tx.organizationState.update).not.toHaveBeenCalled();
    expect(h.tx.department.findMany).toHaveBeenCalledWith({ where: { parentId: null }, orderBy: { id: "asc" }, take: 51 });
  });

  it("preserves real database failures instead of returning an empty list", async () => {
    const h = harness(); const failure = Error("Synthetic query failure");
    h.tx.department.findMany.mockRejectedValue(failure);
    await expect(h.reader.departments({ actorId: "admin1" })).rejects.toBe(failure);
  });
});

describe("bounded version-bound department pages", () => {
  it("returns a closed DTO and cursor scoped to parent/filter/version", async () => {
    const h = harness();
    h.tx.organizationState.findUnique.mockResolvedValue({ id: "organization", version: 5 });
    h.tx.department.findMany.mockResolvedValue([
      { ...department("department1"), passwordHash: "PRIVATE" }, department("department2"), department("department3"),
    ]);
    const first = await h.reader.departments({ actorId: "admin1", parentId: "parent1", archived: "active", limit: 2 });
    expect(first.items).toHaveLength(2); expect(first.version).toBe(5);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|passwordHash|createdAt|updatedAt/);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual({ id: "department2", parentId: "parent1", archived: "active", version: 5 });
    await h.reader.departments({ actorId: "admin1", parentId: "parent1", archived: "active", limit: 2, cursor: first.nextCursor! });
    expect(h.tx.department.findMany.mock.calls[1][0]).toEqual({
      where: { parentId: "parent1", archivedAt: null, id: { gt: "department2" } }, orderBy: { id: "asc" }, take: 3,
    });
  });

  it("rejects a stale cursor before reading parent or data rows", async () => {
    const h = harness(); h.tx.organizationState.findUnique.mockResolvedValue({ version: 6 });
    await expect(h.reader.departments({ actorId: "admin1", parentId: "parent1", cursor: cursor({ id: "row1", parentId: "parent1", archived: "all", version: 5 }) }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(h.tx.department.findUnique).not.toHaveBeenCalled(); expect(h.tx.department.findMany).not.toHaveBeenCalled();
  });

  it.each([
    "not-json", cursor({ id: "row1", parentId: "other", archived: "all", version: 0 }),
    cursor({ id: "row1", parentId: null, archived: "active", version: 0 }),
    cursor({ id: "row1", parentId: null, archived: "all", version: -1 }),
    cursor({ id: "row1", parentId: null, archived: "all", version: 0, unknown: "PRIVATE" }),
    cursor({ id: "private/path", parentId: null, archived: "all", version: 0 }),
  ])("rejects malformed/filter-mismatched cursor before opening transaction %#", value => {
    const h = harness();
    expect(() => h.reader.departments({ actorId: "admin1", cursor: value })).toThrow(ValidationError);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { actorId: "private/path" }, { parentId: "private/path" }])("rejects invalid parameters %# without DB", override => {
    const h = harness(); expect(() => h.reader.departments({ actorId: "admin1", ...override })).toThrow(ValidationError);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("supports bounded archived children and rejects a missing parent", async () => {
    const h = harness();
    await h.reader.departments({ actorId: "admin1", parentId: "parent1", archived: "archived", limit: 100 });
    expect(h.tx.department.findMany).toHaveBeenCalledWith({ where: { parentId: "parent1", archivedAt: { not: null } }, orderBy: { id: "asc" }, take: 101 });
    h.tx.department.findUnique.mockResolvedValue(null);
    await expect(h.reader.departments({ actorId: "admin1", parentId: "missing" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("closed business history and bounded stable pagination", () => {
  it("returns only closed business snapshots, excluding raw result/hash/auth fields", () => {
    const result = safeOrganizationHistory(history({ result: { password: "PRIVATE", rawRequest: "PRIVATE" } }));
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|password|rawRequest|requestHash|expectedVersion|result/);
    if (result) expect(result.after).toEqual(snapshot());
  });

  it.each([
    { operation: "unknown" }, { targetKind: "user" }, { changed: false }, { committedVersion: 100 },
    { after: { ...snapshot(), email: "PRIVATE" } }, { before: { ...snapshot(), cookie: "PRIVATE" } },
    { after: null }, { before: null }, { operationId: "invalid" }, { actorId: "private@email.test" },
    { targetId: "differentTarget" }, { after: { ...snapshot(), id: "differentTarget" } },
  ])("rejects malformed or contradictory saved history %#", override => {
    expect(safeOrganizationHistory(history(override))).toBeNull();
  });

  it("handles creation/null-before and a genuine unchanged receipt", () => {
    expect(safeOrganizationHistory(history({ operation: "createDepartment", before: null }))?.before).toBeNull();
    const noOp = safeOrganizationHistory(history({ changed: false, committedVersion: 0, before: snapshot() }));
    expect(noOp?.changed).toBe(false); expect(noOp?.version).toBe(0);
  });

  it("rejects a fabricated creation with a non-null prior snapshot", () => {
    expect(safeOrganizationHistory(history({ operation: "createDepartment" }))).toBeNull();
    expect(safeOrganizationHistory(history({ operation: "createGroup", targetKind: "group", targetId: "group1",
      before: { id: "group1", name: "Old synthetic group", archived: false },
      after: { id: "group1", name: "New synthetic group", archived: false } }))).toBeNull();
  });

  it("advances history cursor across rejected rows without dumping raw JSON", async () => {
    const h = harness();
    h.tx.organizationOperation.findMany.mockResolvedValue([history(), history({ id: "operation2", operation: "unknown" }), history({ id: "operation3" })]);
    const page = await h.reader.history({ actorId: "admin1", targetId: "department1", limit: 2 });
    expect(page.items).toHaveLength(1);
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())).toEqual({ id: "operation2", time: now.toISOString(), targetId: "department1" });
    await h.reader.history({ actorId: "admin1", targetId: "department1", limit: 2, cursor: page.nextCursor! });
    expect(h.tx.organizationOperation.findMany.mock.calls[1][0]).toEqual({ where: { targetKind: "department", targetId: "department1",
      OR: [{ committedAt: { lt: now } }, { committedAt: now, id: { lt: "operation2" } }] },
      orderBy: [{ committedAt: "desc" }, { id: "desc" }], take: 3 });
  });

  it.each([
    cursor({ id: "row1", targetId: "other", time: now.toISOString() }),
    cursor({ id: "row1", targetId: null, time: "2026-10-20T12:00:00Z" }),
    cursor({ id: "row1", targetId: null, time: now.toISOString(), extra: "PRIVATE" }),
  ])("rejects invalid history cursor before DB %#", value => {
    const h = harness(); expect(() => h.reader.history({ actorId: "admin1", cursor: value })).toThrow(ValidationError);
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
