import { randomUUID } from "node:crypto";
import { Prisma, type OrganizationOperation } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationService } from "./organization";
import { decodeOrganizationResult } from "./organization-command";
import { safeOrganizationHistory } from "./organization-reader";

type User = { id: string; globalRole: "USER" | "ADMIN"; email: string; name: string };
const actorId = "admin";
const metadata = (expectedVersion = 0, operationId = randomUUID()) => ({ actorId, operationId, expectedVersion });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(serialized = false) {
  const users = new Map<string, User>(["admin", "other-admin", "target"].map(id => [id, { id, globalRole: id === "target" ? "USER" : "ADMIN", email: "synthetic-private@example.invalid", name: "Synthetic private name" }]));
  const state = { version: 0 };
  const receipts = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => { calls.push(sql.join("?").includes("pg_advisory") ? "topology" : sql.join("?").includes("FOR UPDATE") ? "target-lock" : "actor-lock"); return []; }),
    user: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select: Record<string, boolean> }) => { calls.push(`user:${where.id}`); const row = users.get(where.id); return row ? Object.fromEntries(Object.entries(row).filter(([key]) => select[key])) : null; }),
      count: vi.fn(async () => [...users.values()].filter(row => row.globalRole === "ADMIN").length),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { globalRole: User["globalRole"] } }) => { calls.push("user-write"); Object.assign(users.get(where.id)!, data); return { id: where.id, globalRole: data.globalRole }; }),
    },
    organizationState: {
      upsert: vi.fn(async () => ({ id: "organization", ...state })),
      update: vi.fn(async ({ data }: { data: { version: number } }) => { calls.push("version-write"); state.version = data.version; return { ...state }; }),
    },
    organizationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { actorId_operationId: { actorId: string; operationId: string } } }) => receipts.get(`${where.actorId_operationId.actorId}/${where.actorId_operationId.operationId}`) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { calls.push("audit-write"); const row = structuredClone(data); receipts.set(`${data.actorId}/${data.operationId}`, row); return row; }),
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const transaction = vi.fn((operation: (value: typeof tx) => Promise<unknown>, options?: { isolationLevel: string }) => {
    void options;
    // Optional explicit serial fake models order only, never PostgreSQL locks.
    if (!serialized) return operation(tx);
    const pending = tail.then(() => operation(tx)); tail = pending.catch(() => {}); return pending;
  });
  const service = createOrganizationService({ $transaction: transaction } as unknown as Parameters<typeof createOrganizationService>[0]);
  return { service, tx, users, state, receipts, calls, transaction };
}

describe("audited global role commands (mock control flow, not PostgreSQL atomicity)", () => {
  it("locks topology, current actor and target in order, writes only role and one closed audit/version", async () => {
    const f = fixture(); const meta = metadata();
    expect(await f.service.setGlobalRole({ ...meta, userId: "target", globalRole: "ADMIN" }))
      .toEqual({ result: { id: "target", globalRole: "ADMIN" }, version: 1, replayed: false });
    expect(f.calls.slice(0, 5)).toEqual(["topology", "actor-lock", "user:admin", "target-lock", "user:target"]);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(f.tx.user.findUnique).toHaveBeenLastCalledWith({ where: { id: "target" }, select: { id: true, globalRole: true } });
    expect(f.tx.user.update).toHaveBeenCalledExactlyOnceWith({ where: { id: "target" }, data: { globalRole: "ADMIN" }, select: { id: true, globalRole: true } });
    expect([...f.receipts.values()][0]).toMatchObject({ actorId, operation: "setGlobalRole", targetKind: "user", targetId: "target", changed: true,
      before: { id: "target", globalRole: "USER" }, after: { id: "target", globalRole: "ADMIN" }, result: { id: "target", globalRole: "ADMIN" }, expectedVersion: 0, committedVersion: 1 });
    expect(JSON.stringify([...f.receipts.values()])).not.toMatch(/synthetic-private|email|name/);
  });
  it("records no-op without entity write or version increment and replays the same receipt", async () => {
    const f = fixture(), input = { ...metadata(), userId: "target", globalRole: "USER" as const };
    expect(await f.service.setGlobalRole(input)).toEqual({ result: { id: "target", globalRole: "USER" }, version: 0, replayed: false });
    expect(await f.service.setGlobalRole(input)).toMatchObject({ version: 0, replayed: true });
    expect(f.tx.user.update).not.toHaveBeenCalled(); expect(f.tx.organizationState.update).not.toHaveBeenCalled();
    expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce(); expect([...f.receipts.values()][0].changed).toBe(false);
  });
  it("returns historical role on replay after a later edit without reapplying it", async () => {
    const f = fixture(), first = { ...metadata(), userId: "target", globalRole: "ADMIN" as const };
    await f.service.setGlobalRole(first);
    await f.service.setGlobalRole({ ...metadata(1), userId: "target", globalRole: "USER" }); vi.clearAllMocks();
    expect(await f.service.setGlobalRole(first)).toEqual({ result: { id: "target", globalRole: "ADMIN" }, version: 1, replayed: true });
    expect(f.users.get("target")!.globalRole).toBe("USER"); expect(f.state.version).toBe(2);
    expect(f.tx.user.update).not.toHaveBeenCalled(); expect(f.tx.organizationState.upsert).not.toHaveBeenCalled(); expect(f.tx.organizationOperation.create).not.toHaveBeenCalled();
  });
  it("normalizes UUID case while keeping the same operation ID scoped to its actor", async () => {
    const f = fixture(), meta = metadata(); const input = { ...meta, userId: "target", globalRole: "ADMIN" as const };
    await f.service.setGlobalRole(input);
    expect(await f.service.setGlobalRole({ ...input, operationId: meta.operationId.toUpperCase() })).toMatchObject({ replayed: true, version: 1 });
    expect(await f.service.setGlobalRole({ ...input, actorId: "other-admin", expectedVersion: 1 })).toMatchObject({ replayed: false, version: 1 });
    expect(f.receipts.size).toBe(2); expect(f.tx.user.update).toHaveBeenCalledOnce();
  });
  it("captures actor, target, role and metadata before an asynchronous lock wait", async () => {
    const f = fixture(), gate = deferred();
    f.tx.$queryRaw.mockImplementationOnce(async () => { await gate.promise; return []; });
    const input = { ...metadata(), userId: "target", globalRole: "ADMIN" as User["globalRole"] };
    const original = { ...input }; const pending = f.service.setGlobalRole(input);
    input.actorId = "other-admin"; input.userId = "other-admin"; input.globalRole = "USER"; input.operationId = randomUUID(); input.expectedVersion = 99;
    gate.resolve(); expect(await pending).toMatchObject({ result: { id: "target", globalRole: "ADMIN" }, version: 1 });
    expect([...f.receipts.values()][0]).toMatchObject({ actorId: original.actorId, operationId: original.operationId, expectedVersion: original.expectedVersion, targetId: original.userId });
    expect(f.users.get("other-admin")!.globalRole).toBe("ADMIN");
  });
  it.each(["USER", "missing"])("rechecks actor %s before receipt replay", async role => {
    const f = fixture(), input = { ...metadata(), userId: "target", globalRole: "ADMIN" as const };
    await f.service.setGlobalRole(input); vi.clearAllMocks();
    if (role === "missing") f.users.delete(actorId); else f.users.get(actorId)!.globalRole = "USER";
    await expect(f.service.setGlobalRole(input)).rejects.toMatchObject({ name: role === "missing" ? "NotFoundError" : "ForbiddenError" });
    expect(f.tx.organizationOperation.findUnique).not.toHaveBeenCalled();
  });
  it("denies self-demotion before write/audit while allowing ADMIN self no-op", async () => {
    const f = fixture(); await expect(f.service.setGlobalRole({ ...metadata(), userId: actorId, globalRole: "USER" })).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.user.update).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
    expect(await f.service.setGlobalRole({ ...metadata(), userId: actorId, globalRole: "ADMIN" })).toMatchObject({ version: 0, replayed: false });
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it.each([0, 1])("fails closed when the serialized ADMIN count is %s", async count => {
    const f = fixture(); f.tx.user.count.mockResolvedValue(count);
    await expect(f.service.setGlobalRole({ ...metadata(), userId: "other-admin", globalRole: "USER" }))
      .rejects.toMatchObject({ name: "ConflictError", message: "Last administrator is protected" });
    expect(f.tx.user.count).toHaveBeenCalledWith({ where: { globalRole: "ADMIN" } }); expect(f.tx.user.update).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
    // Defensive count branch: this artificial count is not a real DB fixture.
  });
  it("allows another ADMIN's demotion with sufficient current administrators", async () => {
    const f = fixture(); await f.service.setGlobalRole({ ...metadata(), userId: "other-admin", globalRole: "USER" });
    expect(f.users.get("other-admin")!.globalRole).toBe("USER"); expect(f.users.get(actorId)!.globalRole).toBe("ADMIN");
  });
  it("rejects a missing target after acquiring its lock", async () => {
    const f = fixture(); f.users.delete("target");
    await expect(f.service.setGlobalRole({ ...metadata(), userId: "target", globalRole: "ADMIN" })).rejects.toMatchObject({ name: "NotFoundError" }); expect(f.calls).toContain("target-lock"); expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it.each([{ globalRole: "admin" }, { globalRole: "OWNER" }, { globalRole: null }, { userId: "../bad" }, { operationId: "not-uuid" }, { expectedVersion: -1 }])("rejects malformed command before transaction %#", override => {
    const f = fixture();
    expect(() => f.service.setGlobalRole({ ...metadata(), userId: "target", globalRole: "ADMIN", ...override } as Parameters<typeof f.service.setGlobalRole>[0]))
      .toThrowError(expect.objectContaining({ name: "ValidationError" })); expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects stale global version before target lock/read", async () => {
    const f = fixture(); f.state.version = 1;
    await expect(f.service.setGlobalRole({ ...metadata(), userId: "target", globalRole: "ADMIN" })).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.calls).not.toContain("target-lock"); expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it.each(["role", "target"])("rejects operation ID reuse with a changed %s", async change => {
    const f = fixture(), meta = metadata(); await f.service.setGlobalRole({ ...meta, userId: "target", globalRole: "ADMIN" });
    await expect(f.service.setGlobalRole({ ...meta, userId: change === "target" ? "other-admin" : "target", globalRole: change === "role" ? "USER" : "ADMIN" }))
      .rejects.toMatchObject({ name: "ConflictError" }); expect(f.receipts.size).toBe(1);
  });
  it.each(["result-extra", "target", "role", "version", "kind"])("rejects corrupt saved role receipt %s", async corruption => {
    const f = fixture(), input = { ...metadata(), userId: "target", globalRole: "ADMIN" as const }; await f.service.setGlobalRole(input);
    const row = [...f.receipts.values()][0];
    if (corruption === "result-extra") row.result = { id: "target", globalRole: "ADMIN", email: "synthetic-private" };
    if (corruption === "target") row.targetId = "other-admin";
    if (corruption === "role") { row.result = { id: "target", globalRole: "USER" }; row.after = row.result; }
    if (corruption === "version") row.committedVersion = 4;
    if (corruption === "kind") row.targetKind = "project";
    vi.clearAllMocks(); await expect(f.service.setGlobalRole(input)).rejects.toMatchObject({ name: "ConflictError" }); expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it("propagates mandatory audit failure and never resolves early business success", async () => {
    const f = fixture(), gate = deferred(); let settled = false;
    f.tx.organizationOperation.create.mockImplementationOnce(async () => { await gate.promise; throw Error("Synthetic audit failure"); });
    const pending = f.service.setGlobalRole({ ...metadata(), userId: "target", globalRole: "ADMIN" }).finally(() => { settled = true; });
    const rejected = expect(pending).rejects.toThrow("Synthetic audit failure");
    await vi.waitFor(() => expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce()); expect(settled).toBe(false); gate.resolve(); await rejected;
    // This adapter does not claim rollback. Guarded PG tests cover that boundary.
  });
  it("serial fake queues reciprocal demotions and denies the demoted second actor before receipt/version", async () => {
    const f = fixture(true), gate = deferred(); const normal = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async sql => { const result = await normal(sql); if (sql.join("?").includes("FOR UPDATE")) await gate.promise; return result; });
    const first = f.service.setGlobalRole({ ...metadata(), userId: "other-admin", globalRole: "USER" });
    await vi.waitFor(() => expect(f.calls).toContain("target-lock"));
    const second = f.service.setGlobalRole({ ...metadata(), actorId: "other-admin", userId: actorId, globalRole: "USER" });
    const outcomes = Promise.allSettled([first, second]); gate.resolve();
    const results = await outcomes; expect(results[0].status).toBe("fulfilled"); expect(results[1]).toMatchObject({ status: "rejected", reason: { name: "ForbiddenError" } });
    expect(f.tx.user.update).toHaveBeenCalledOnce(); expect(f.receipts.size).toBe(1);
  });
  it("decodes role receipts into closed role-only JSON and rejects cross-type or extra fields", () => {
    expect(decodeOrganizationResult("setGlobalRole", { id: "target", globalRole: "ADMIN" })).toEqual({ id: "target", globalRole: "ADMIN" });
    for (const value of [{ id: "target", globalRole: "OWNER" }, { id: "target", globalRole: "USER", email: "synthetic-private" }, { id: "target", primaryDepartmentId: null }])
      expect(() => decodeOrganizationResult("setGlobalRole", value)).toThrowError(expect.objectContaining({ name: "ConflictError" }));
  });
  it("exports closed user-role history while rejecting privileged snapshot fields", async () => {
    const f = fixture(); await f.service.setGlobalRole({ ...metadata(), userId: "target", globalRole: "ADMIN" });
    const receipt = { ...[...f.receipts.values()][0], id: "audit1", committedAt: new Date("2026-10-21T00:00:00.000Z") } as unknown as OrganizationOperation;
    expect(safeOrganizationHistory(receipt)).toMatchObject({ operation: "setGlobalRole", targetKind: "user", targetId: "target", changed: true,
      before: { id: "target", globalRole: "USER" }, after: { id: "target", globalRole: "ADMIN" }, version: 1 });
    expect(safeOrganizationHistory({ ...receipt, after: { id: "target", globalRole: "ADMIN", email: "synthetic-private" } })).toBeNull();
    expect(safeOrganizationHistory({ ...receipt, targetKind: "department" })).toBeNull();
  });
});
