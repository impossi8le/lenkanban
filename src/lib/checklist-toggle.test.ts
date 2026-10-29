import type { PrismaClient, TaskChecklistItem } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { updateChecklistItem, type ChecklistItemUpdate } from "./checklist-toggle";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { validCorrelationId } from "./telemetry-sanitize";

const operationId = "30dc9a4d-3fdc-4f04-b5db-604b4d4c6b93";
const actionId = "b6497269-c5f7-455e-b3bc-80af37b98037";
const requestId = "d303e3fa-3192-4c09-b40b-345ee0e5fc5f";
const item: TaskChecklistItem = { id: "item", taskId: "task", text: "Private business text", completed: false, position: 2,
  createdAt: new Date("2026-10-20T00:00:00Z"), updatedAt: new Date("2026-10-20T00:00:00Z") };

function harness() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "locked" }]),
    task: { findUnique: vi.fn().mockResolvedValue({ projectId: "project" }) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "actor", globalRole: "USER" }) },
    taskRequest: { findUnique: vi.fn().mockResolvedValue(null) },
    project: { findUnique: vi.fn().mockResolvedValue({ id: "project", ownerId: "actor", members: [] }) },
    taskChecklistItem: {
      findFirst: vi.fn().mockResolvedValue({ ...item }),
      update: vi.fn().mockImplementation(async ({ data }: { data: ChecklistItemUpdate }) => ({ ...item, ...data })),
    },
    activity: { create: vi.fn().mockResolvedValue({}) },
    checklistOperationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "receipt" }),
    },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
  const database = { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">;
  const run = (update: ChecklistItemUpdate = { completed: true }, op: string | undefined = operationId) => updateChecklistItem({
    database, actorId: "actor", taskId: "task", itemId: "item", update, operationId: op, context: { actionId, requestId },
  });
  const assertNoWrites = () => {
    expect(tx.taskChecklistItem.update).not.toHaveBeenCalled();
    expect(tx.activity.create).not.toHaveBeenCalled();
    expect(tx.checklistOperationReceipt.create).not.toHaveBeenCalled();
  };
  return { tx, database, transaction, run, assertNoWrites };
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { id: "receipt-existing", actorId: "actor", operationId, taskId: "task", itemId: "item", projectId: "project", completed: true, ...overrides };
}

describe("atomic checklist command contract with mocked transaction", () => {
  it.each(["", "not-uuid", operationId + "\nprivate", "a".repeat(500)])("rejects malformed operation %j before transaction", async (op) => {
    const h = harness(); await expect(h.run({ completed: true }, op)).rejects.toBeInstanceOf(BadRequestError);
    expect(h.transaction).not.toHaveBeenCalled(); h.assertNoWrites();
  });
  it.each([{}, { text: "new" }, { completed: true, text: "new" }, { completed: true, position: 1 }])("rejects a non-toggle instrumented command %# before transaction", async (update) => {
    const h = harness(); await expect(h.run(update)).rejects.toBeInstanceOf(BadRequestError);
    expect(h.transaction).not.toHaveBeenCalled(); h.assertNoWrites();
  });
  it("locks the actor/operation globally, then Project and Task, and checks fresh actor/common project policy", async () => {
    const h = harness(); await h.run();
    expect(h.transaction).toHaveBeenCalledOnce();
    const calls = h.tx.$queryRaw.mock.calls;
    expect(calls).toHaveLength(3);
    expect(Array.from(calls[0][0] as TemplateStringsArray).join("?")).toContain("pg_advisory_xact_lock");
    expect(calls[0].slice(1)).toEqual([JSON.stringify(["checklist-toggle-v1", "actor", operationId])]);
    expect(Array.from(calls[1][0] as TemplateStringsArray).join("?")).toMatch(/FROM "Project".*FOR UPDATE/s);
    expect(calls[1].slice(1)).toEqual(["project"]);
    expect(Array.from(calls[2][0] as TemplateStringsArray).join("?")).toMatch(/FROM "Task".*FOR UPDATE/s);
    expect(calls[2].slice(1)).toEqual(["task", "project"]);
    expect(h.tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(h.tx.user.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.project.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.project.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.checklistOperationReceipt.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.project.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.taskRequest.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.taskRequest.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.checklistOperationReceipt.findUnique.mock.invocationCallOrder[0]);
    expect(h.tx.project.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "project" } }));
  });
  it.each(["task", "project-lock", "task-lock", "actor", "permission", "item"])("returns not-found for missing/denied %s without mutation or exposing receipts", async (which) => {
    const h = harness();
    if (which === "task") h.tx.task.findUnique.mockResolvedValue(null);
    if (which === "project-lock") h.tx.$queryRaw.mockResolvedValueOnce([{ id: "advisory" }]).mockResolvedValueOnce([]);
    if (which === "task-lock") h.tx.$queryRaw.mockResolvedValueOnce([{ id: "advisory" }]).mockResolvedValueOnce([{ id: "project" }]).mockResolvedValueOnce([]);
    if (which === "actor") h.tx.user.findUnique.mockResolvedValue(null);
    if (which === "permission") h.tx.project.findUnique.mockResolvedValue({ id: "project", ownerId: "other", members: [] });
    if (which === "item") h.tx.taskChecklistItem.findFirst.mockResolvedValue(null);
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundError); h.assertNoWrites();
    if (which !== "item") expect(h.tx.checklistOperationReceipt.findUnique).not.toHaveBeenCalled();
  });
  it("allows a fresh global administrator through the existing common policy", async () => {
    const h = harness(); h.tx.user.findUnique.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
    expect((await h.run()).changed).toBe(true);
    expect(h.tx.project.findUnique).not.toHaveBeenCalled();
  });
  it.each([{ taskId: "other-task" }, { itemId: "other-item" }, { projectId: "other-project" }, { completed: false }])("rejects existing-key command mismatch %# without applying anything", async (mismatch) => {
    const h = harness(); h.tx.checklistOperationReceipt.findUnique.mockResolvedValue(receipt(mismatch));
    await expect(h.run()).rejects.toBeInstanceOf(ConflictError); h.assertNoWrites();
  });
  it("normalizes UUID case for both the lock and receipt key", async () => {
    const h = harness(); await h.run({ completed: true }, operationId.toUpperCase());
    expect(h.tx.checklistOperationReceipt.findUnique).toHaveBeenCalledWith({ where: { actorId_operationId: { actorId: "actor", operationId } } });
    expect(h.tx.$queryRaw.mock.calls[0].slice(1)).toEqual([JSON.stringify(["checklist-toggle-v1", "actor", operationId])]);
  });
  it("returns current DTO on a replay after another toggle without reapplying the old command", async () => {
    const h = harness(); h.tx.checklistOperationReceipt.findUnique.mockResolvedValue(receipt());
    h.tx.taskChecklistItem.findFirst.mockResolvedValue({ ...item, completed: false, text: "Newer text" });
    const result = await h.run({ completed: true });
    expect(result).toMatchObject({ item: { completed: false, text: "Newer text" }, replayed: true, changed: false, receiptId: "receipt-existing" });
    h.assertNoWrites();
  });
  it("does not recreate an item deleted after the recorded operation", async () => {
    const h = harness(); h.tx.checklistOperationReceipt.findUnique.mockResolvedValue(receipt());
    h.tx.taskChecklistItem.findFirst.mockResolvedValue(null);
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundError); h.assertNoWrites();
  });
  it("persists a no-op receipt with changed=false and no item update or Activity", async () => {
    const h = harness(); const result = await h.run({ completed: false });
    expect(result).toMatchObject({ changed: false, replayed: false, receiptId: "receipt", item: { completed: false } });
    expect(h.tx.taskChecklistItem.update).not.toHaveBeenCalled(); expect(h.tx.activity.create).not.toHaveBeenCalled();
    expect(h.tx.checklistOperationReceipt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ changed: false, completed: false }) }));
  });
  it("records the mutation, Activity and metadata-only receipt within the same transaction", async () => {
    const h = harness(); const result = await h.run();
    expect(result).toMatchObject({ changed: true, replayed: false, item: { completed: true }, receiptId: "receipt" });
    expect(h.tx.activity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ taskId: "task", userId: "actor", action: "checklist_item_completed" }) });
    const data = h.tx.checklistOperationReceipt.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ actorId: "actor", operationId, taskId: "task", itemId: "item", projectId: "project", completed: true, changed: true, actionId, requestId });
    expect(validCorrelationId(data.eventId)).toBe(true);
    expect(data).not.toHaveProperty("text"); expect(JSON.stringify(data)).not.toContain(item.text);
    expect(h.tx.taskChecklistItem.update.mock.invocationCallOrder[0]).toBeLessThan(h.tx.activity.create.mock.invocationCallOrder[0]);
    expect(h.tx.activity.create.mock.invocationCallOrder[0]).toBeLessThan(h.tx.checklistOperationReceipt.create.mock.invocationCallOrder[0]);
  });
  it.each(["activity", "receipt"])("propagates %s persistence failure instead of claiming success", async (which) => {
    const h = harness(); const original = Error("Synthetic persistence rejection");
    if (which === "activity") h.tx.activity.create.mockRejectedValue(original);
    else h.tx.checklistOperationReceipt.create.mockRejectedValue(original);
    await expect(h.run()).rejects.toBe(original);
    expect(h.tx.taskChecklistItem.update).toHaveBeenCalledOnce();
    if (which === "activity") expect(h.tx.checklistOperationReceipt.create).not.toHaveBeenCalled();
    // Mocked transaction tests prove call boundaries; they do not prove SQL rollback.
  });
  it("preserves legacy text/position updates without introducing receipts or operation locks", async () => {
    const h = harness();
    const result = await updateChecklistItem({ database: h.database, actorId: "actor", taskId: "task", itemId: "item", update: { text: "Edited business text", position: 7 } });
    expect(result.item).toMatchObject({ text: "Edited business text", position: 7 });
    expect(h.tx.checklistOperationReceipt.findUnique).not.toHaveBeenCalled(); expect(h.tx.checklistOperationReceipt.create).not.toHaveBeenCalled();
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.tx.activity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "checklist_item_updated" }) });
  });
});

describe("checklist request marker boundary for instrumented and legacy updates", () => {
  const states = ["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"] as const;
  const modes = ["toggle", "noop", "replay", "legacy-text", "legacy-completed", "legacy-position"] as const;
  const marker = (state: typeof states[number]) => ({ taskId: "task", contractVersion: 1, state, authorId: "author", executorId: ["IN_PROGRESS", "NEEDS_INFO", "COMPLETED"].includes(state) ? "executor" : null });
  function noItemOrReceiptReads(h: ReturnType<typeof harness>) {
    h.assertNoWrites(); expect(h.tx.taskChecklistItem.findFirst).not.toHaveBeenCalled(); expect(h.tx.checklistOperationReceipt.findUnique).not.toHaveBeenCalled();
  }
  it.each(states.flatMap(state => modes.map(mode => ({ state, mode }))))("rejects $state/$mode before item or receipt access", async ({ state, mode }) => {
    const h = harness(); h.tx.taskRequest.findUnique.mockResolvedValue(marker(state));
    if (mode === "replay") h.tx.checklistOperationReceipt.findUnique.mockResolvedValue(receipt());
    const operation = mode.startsWith("legacy-")
      ? updateChecklistItem({ database: h.database, actorId: "actor", taskId: "task", itemId: "item", update: mode === "legacy-text" ? { text: "New" } : mode === "legacy-position" ? { position: 9 } : { completed: true } })
      : h.run({ completed: mode !== "noop" });
    await expect(operation).rejects.toMatchObject({ name: "ConflictError", message: "REQUEST_LIFECYCLE_NOT_ENABLED" }); noItemOrReceiptReads(h);
    expect(h.tx.project.findUnique.mock.invocationCallOrder[0]).toBeLessThan(h.tx.taskRequest.findUnique.mock.invocationCallOrder[0]);
  });
  it.each([undefined, { ...marker("DRAFT"), executorId: "invalid-shape" }, { ...marker("DRAFT"), rawSecret: "private" }])("rejects malformed marker %#", async value => {
    const h = harness(); h.tx.taskRequest.findUnique.mockResolvedValue(value);
    await expect(h.run()).rejects.toMatchObject({ name: "ConflictError", message: "INVALID_REQUEST_MARKER" }); noItemOrReceiptReads(h);
  });
  it.each(["actor", "outsider"])("returns not-found for fresh %s before inspecting marker", async scenario => {
    const h = harness(); h.tx.taskRequest.findUnique.mockResolvedValue(marker("DRAFT"));
    if (scenario === "actor") h.tx.user.findUnique.mockResolvedValue(null); else h.tx.project.findUnique.mockResolvedValue({ id: "project", ownerId: "other", members: [] });
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundError); expect(h.tx.taskRequest.findUnique).not.toHaveBeenCalled(); noItemOrReceiptReads(h);
  });
  it.each(["missing-delegate", "database-error"])("fails closed on %s before mutation", async scenario => {
    const h = harness(), failure = Error("synthetic marker lookup failure");
    if (scenario === "missing-delegate") Reflect.deleteProperty(h.tx, "taskRequest"); else h.tx.taskRequest.findUnique.mockRejectedValue(failure);
    if (scenario === "database-error") await expect(h.run()).rejects.toBe(failure); else await expect(h.run()).rejects.toBeInstanceOf(Error);
    noItemOrReceiptReads(h);
  });
  it("preserves a found legacy task with a historical non-ASCII/custom ID when the marker row is explicitly absent", async () => {
    const h = harness(), taskId = "legacy/задача:one";
    h.tx.taskChecklistItem.findFirst.mockResolvedValue({ ...item, taskId });
    h.tx.taskChecklistItem.update.mockResolvedValue({ ...item, taskId, text: "New legacy text" });
    const result = await updateChecklistItem({ database: h.database, actorId: "actor", taskId, itemId: "item", update: { text: "New legacy text" } });
    expect(result.item).toMatchObject({ taskId, text: "New legacy text" }); expect(h.tx.taskRequest.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId } }));
    expect(h.tx.activity.create).toHaveBeenCalledOnce(); expect(h.tx.checklistOperationReceipt.create).not.toHaveBeenCalled();
  });
  it("still refuses a non-null marker for a historical custom task ID", async () => {
    const h = harness(), taskId = "legacy/задача:one"; h.tx.taskRequest.findUnique.mockResolvedValue({ ...marker("DRAFT"), taskId });
    await expect(updateChecklistItem({ database: h.database, actorId: "actor", taskId, itemId: "item", update: { text: "New" } })).rejects.toMatchObject({ name: "ConflictError", message: "INVALID_REQUEST_MARKER" });
    noItemOrReceiptReads(h);
  });
});
