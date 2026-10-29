import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMyDayService } from "./my-day-service";

const db = { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
const service = createMyDayService({ myDayEntry: db } as unknown as Pick<PrismaClient, "myDayEntry">, () => new Date("2026-10-29T12:00:00Z"));
const operationId = randomUUID();
const row = (extra = {}) => ({ id: "entry", ownerId: "alice", date: new Date("2026-10-29Z"), text: "private", version: 1, lastOperationId: operationId, createdAt: new Date(), updatedAt: new Date("2026-10-29T12:00:00Z"), ...extra });
beforeEach(() => { vi.resetAllMocks(); });

describe("diary persistence contract (mock repository)", () => {
  it("reads an empty day without creating data", async () => {
    db.findUnique.mockResolvedValue(null);
    expect(await service.read("alice", "2026-10-29")).toEqual({ date: "2026-10-29", text: "", version: 0, updatedAt: null, today: "2026-10-29" });
    expect(db.create).not.toHaveBeenCalled();
    expect(db.findUnique).toHaveBeenCalledWith({ where: { ownerId_date: { ownerId: "alice", date: new Date("2026-10-29T00:00:00Z") } } });
  });
  it.each(["2026-10-30", "2026-02-29", "2026-13-01"])("rejects future/invalid %s before repository access", async date => {
    await expect(service.read("alice", date)).rejects.toMatchObject({ name: "BadRequestError" });
    expect(db.findUnique).not.toHaveBeenCalled();
  });
  it("inserts and replays a lost creation response without a second result", async () => {
    db.create.mockResolvedValueOnce(row()).mockRejectedValueOnce({ code: "P2002" }); db.findUnique.mockResolvedValue(row());
    const input = { text: "private", operationId, expectedVersion: 0 };
    expect(await service.save("alice", "2026-10-29", input)).toEqual(await service.save("alice", "2026-10-29", input));
    expect(db.update).not.toHaveBeenCalled();
  });
  it("returns conflict when a different initial insert won", async () => {
    db.create.mockRejectedValue({ code: "P2002" }); db.findUnique.mockResolvedValue(row({ lastOperationId: randomUUID() }));
    await expect(service.save("alice", "2026-10-29", { text: "other", operationId, expectedVersion: 0 })).rejects.toMatchObject({ current: { text: "private", version: 1 } });
  });
  it("updates by owner/date/version atomically, allowing an empty value", async () => {
    db.update.mockResolvedValue(row({ text: "", version: 2 }));
    expect((await service.save("alice", "2026-10-29", { text: "", operationId, expectedVersion: 1 })).version).toBe(2);
    expect(db.update.mock.calls[0][0]).toMatchObject({ where: { ownerId_date: { ownerId: "alice" }, version: 1, NOT: { lastOperationId: operationId } }, data: { text: "", version: { increment: 1 } } });
  });
  it("replays the latest update and rejects reusing its ID with changed text", async () => {
    db.update.mockRejectedValue({ code: "P2025" }); db.findUnique.mockResolvedValue(row({ version: 2 }));
    expect((await service.save("alice", "2026-10-29", { text: "private", operationId, expectedVersion: 1 })).version).toBe(2);
    await expect(service.save("alice", "2026-10-29", { text: "changed", operationId, expectedVersion: 1 })).rejects.toMatchObject({ name: "ConflictError" });
  });
  it("does not replay an operation after a subsequent update", async () => {
    db.update.mockRejectedValue({ code: "P2025" }); db.findUnique.mockResolvedValue(row({ version: 3, lastOperationId: randomUUID(), text: "newer" }));
    await expect(service.save("alice", "2026-10-29", { text: "private", operationId, expectedVersion: 1 })).rejects.toMatchObject({ current: { text: "newer", version: 3 } });
  });
  it.each([{ text: "x".repeat(50001) }, { text: "nul\0" }, { expectedVersion: -1 }, { operationId: "not-uuid" }])("rejects invalid input before writing", async extra => {
    await expect(service.save("alice", "2026-10-29", { text: "private", operationId, expectedVersion: 1, ...extra })).rejects.toMatchObject({ name: "BadRequestError" });
    expect(db.update).not.toHaveBeenCalled(); expect(db.create).not.toHaveBeenCalled();
  });
});
