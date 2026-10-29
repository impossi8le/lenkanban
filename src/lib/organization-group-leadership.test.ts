import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/socket/board-events", () => ({ emitAuthRevoked: vi.fn() }));
import { createOrganizationService } from "./organization";
import { createOrganizationReader } from "./organization-reader";
import { decodeOrganizationResult, isOrganizationMethod } from "./organization-command";

const command = { actorId: "admin", operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 0, groupId: "group", userId: "member" };
function fixture() {
  const actor = { id: "admin", globalRole: "ADMIN" };
  const target = { id: "member", isBlocked: false, blockedAt: null as Date | null };
  const group = { id: "group", name: "Synthetic", leaderId: null as string | null, archivedAt: null as Date | null };
  const state = { version: 0 }; let receipt: Record<string, unknown> | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "locked" }]),
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === "admin" ? actor : where.id === target.id ? target : null) },
    responsibleGroup: { findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => where.id === group.id ? Object.fromEntries(Object.entries(group).filter(([key]) => !select || select[key])) : null),
      update: vi.fn(async ({ data }: { data: { leaderId: string | null } }) => { group.leaderId = data.leaderId; return { id: group.id, leaderId: group.leaderId }; }) },
    responsibleGroupMember: { findUnique: vi.fn(async () => ({ groupId: "group", userId: "member" })) },
    organizationState: { findUnique: vi.fn(async () => ({ ...state })), upsert: vi.fn(async () => ({ ...state })),
      update: vi.fn(async ({ data }: { data: { version: number } }) => { state.version = data.version; return state; }) },
    organizationOperation: { findUnique: vi.fn(async () => receipt), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { receipt = structuredClone(data); return receipt; }) },
  };
  const database = { $transaction: vi.fn(async (run: (value: typeof tx) => Promise<unknown>) => run(tx)) } as unknown as Parameters<typeof createOrganizationService>[0];
  return { actor, target, group, state, tx, service: createOrganizationService(database), reader: createOrganizationReader(database), receipt: () => receipt };
}

describe("explicit responsible group leadership", () => {
  it("registers and decodes a separate minimized leadership DTO", () => {
    expect(isOrganizationMethod("setGroupLeader")).toBe(true);
    expect(decodeOrganizationResult("setGroupLeader", { id: "group", leaderId: "member" })).toEqual({ id: "group", leaderId: "member" });
    expect(() => decodeOrganizationResult("setGroupLeader", { id: "group", leaderId: "member", globalRole: "ADMIN" })).toThrow();
  });

  it("sets an active member and records one versioned receipt, preserving exact replay", async () => {
    const f = fixture();
    expect(await f.service.setGroupLeader(command)).toEqual({ result: { id: "group", leaderId: "member" }, version: 1, replayed: false });
    expect(f.tx.organizationOperation.create).toHaveBeenCalledOnce();
    expect(f.receipt()).toMatchObject({ operation: "setGroupLeader", targetKind: "group", targetId: "group", before: { id: "group", leaderId: null }, after: { id: "group", leaderId: "member" }, changed: true });
    f.group.leaderId = null; f.tx.responsibleGroupMember.findUnique.mockResolvedValue(null as never);
    expect(await f.service.setGroupLeader(command)).toEqual({ result: { id: "group", leaderId: "member" }, version: 1, replayed: true });
    expect(f.tx.responsibleGroup.update).toHaveBeenCalledOnce();
  });

  it("records a valid no-op without another version increment", async () => {
    const f = fixture(); f.group.leaderId = "member";
    expect(await f.service.setGroupLeader(command)).toMatchObject({ version: 0, replayed: false });
    expect(f.tx.responsibleGroup.update).not.toHaveBeenCalled();
    expect(f.receipt()).toMatchObject({ changed: false, committedVersion: 0 });
  });

  it("rejects operation reuse for another assignment and corrupted historical result", async () => {
    const f = fixture(); await f.service.setGroupLeader(command);
    await expect(f.service.setGroupLeader({ ...command, userId: null })).rejects.toMatchObject({ name: "ConflictError" });
    f.receipt()!.result = { id: "other-group", leaderId: "member" };
    await expect(f.service.setGroupLeader(command)).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.responsibleGroup.update).toHaveBeenCalledOnce();
  });

  it("rechecks current ADMIN before historical replay", async () => {
    const f = fixture(); await f.service.setGroupLeader(command); f.actor.globalRole = "USER";
    await expect(f.service.setGroupLeader(command)).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(f.tx.responsibleGroup.update).toHaveBeenCalledOnce();
  });

  it.each(["archived", "blocked", "blockedAt", "not-member", "missing-user", "missing-group", "stale-version"])("rejects %s without mutation or receipt", async scenario => {
    const f = fixture();
    if (scenario === "archived") f.group.archivedAt = new Date();
    if (scenario === "blocked") f.target.isBlocked = true;
    if (scenario === "blockedAt") f.target.blockedAt = new Date();
    if (scenario === "not-member") f.tx.responsibleGroupMember.findUnique.mockResolvedValue(null as never);
    if (scenario === "missing-user") f.target.id = "other";
    if (scenario === "missing-group") f.group.id = "other";
    if (scenario === "stale-version") f.state.version = 1;
    await expect(f.service.setGroupLeader(command)).rejects.toThrow();
    expect(f.tx.responsibleGroup.update).not.toHaveBeenCalled(); expect(f.tx.organizationOperation.create).not.toHaveBeenCalled();
  });

  it("allows clearing an archived group without inventing membership", async () => {
    const f = fixture(); f.group.archivedAt = new Date(); f.group.leaderId = "removed-user";
    expect(await f.service.setGroupLeader({ ...command, userId: null })).toMatchObject({ result: { id: "group", leaderId: null }, version: 1 });
    expect(f.tx.responsibleGroupMember.findUnique).not.toHaveBeenCalled();
  });

  it("reads a minimized role-checked snapshot and rejects revoked reader", async () => {
    const f = fixture(); f.group.leaderId = "member";
    expect(await f.reader.groupLeadership({ actorId: "admin", groupId: "group" })).toEqual({ result: { id: "group", leaderId: "member" }, version: 0 });
    f.actor.globalRole = "USER";
    await expect(f.reader.groupLeadership({ actorId: "admin", groupId: "group" })).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});
