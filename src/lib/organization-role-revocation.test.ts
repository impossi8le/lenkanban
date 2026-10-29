import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ emitAuthRevoked: vi.fn(), fetch: vi.fn() }));

vi.mock("@/socket/board-events", () => ({ emitAuthRevoked: boundary.emitAuthRevoked }));

import { createOrganizationService } from "./organization";

const actorId = "admin";
const metadata = () => ({ actorId, operationId: randomUUID(), expectedVersion: 0 });

function fixture() {
  const users = new Map<string, { id: string; globalRole: "USER" | "ADMIN" }>([
    ["admin", { id: "admin", globalRole: "ADMIN" }],
    ["other-admin", { id: "other-admin", globalRole: "ADMIN" }],
    ["target", { id: "target", globalRole: "USER" }],
  ]);
  const state = { version: 0 };
  const receipts = new Map<string, Record<string, unknown>>();
  let commitGate: Promise<void> | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null),
      count: vi.fn(async () => [...users.values()].filter(row => row.globalRole === "ADMIN").length),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { globalRole: "USER" | "ADMIN" } }) => {
        Object.assign(users.get(where.id)!, data);
        return { id: where.id, globalRole: data.globalRole };
      }),
    },
    organizationState: {
      upsert: vi.fn(async () => ({ id: "organization", ...state })),
      update: vi.fn(async ({ data }: { data: { version: number } }) => { state.version = data.version; return { ...state }; }),
    },
    organizationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { actorId_operationId: { actorId: string; operationId: string } } }) =>
        receipts.get(`${where.actorId_operationId.actorId}/${where.actorId_operationId.operationId}`) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (commitGate) await commitGate;
        const row = structuredClone(data);
        receipts.set(`${data.actorId}/${data.operationId}`, row);
        return row;
      }),
    },
  };
  const service = createOrganizationService({
    $transaction: (operation: (value: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as Parameters<typeof createOrganizationService>[0]);
  return { service, users, setGate: (gate: Promise<void> | null) => { commitGate = gate; } };
}

beforeEach(() => { boundary.emitAuthRevoked.mockReset(); });

describe("role demotion socket revocation (#40)", () => {
  it("emits after the audit row commits, never before", async () => {
    const f = fixture();
    let release!: () => void;
    f.setGate(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.service.setGlobalRole({ ...metadata(), userId: "other-admin", globalRole: "USER" });
    await vi.waitFor(() => expect(boundary.emitAuthRevoked).not.toHaveBeenCalled());
    release();
    await pending;
    expect(boundary.emitAuthRevoked).toHaveBeenCalledExactlyOnceWith("other-admin", "role-demoted");
  });

  it("does not revoke a promotion or a no-op", async () => {
    const f = fixture();
    await f.service.setGlobalRole({ ...metadata(), userId: "target", globalRole: "ADMIN" });
    expect(boundary.emitAuthRevoked).not.toHaveBeenCalled();
    await f.service.setGlobalRole({ ...metadata(), expectedVersion: 1, userId: "target", globalRole: "ADMIN" });
    expect(boundary.emitAuthRevoked).not.toHaveBeenCalled();
  });

  it("does not re-emit for a replayed demotion", async () => {
    const f = fixture();
    const input = { ...metadata(), userId: "other-admin", globalRole: "USER" as const };
    await f.service.setGlobalRole(input);
    boundary.emitAuthRevoked.mockClear();
    expect(await f.service.setGlobalRole(input)).toMatchObject({ replayed: true });
    expect(boundary.emitAuthRevoked).not.toHaveBeenCalled();
  });

  it("does not emit when the command is rejected", async () => {
    const f = fixture();
    await expect(f.service.setGlobalRole({ ...metadata(), userId: actorId, globalRole: "USER" }))
      .rejects.toMatchObject({ name: "ConflictError" });
    expect(boundary.emitAuthRevoked).not.toHaveBeenCalled();
  });
});
