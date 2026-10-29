import type { Notification } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({
  transaction: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
  emit: vi.fn(),
  diagnostic: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: {
  $transaction: stub.transaction,
  notification: { createMany: stub.createMany, findMany: stub.findMany },
} }));
vi.mock("./project-access", () => ({ getTaskReadWhere: async (_actor: unknown, filters: unknown) => filters }));
vi.mock("./logger", () => ({ socketLogger: { error: stub.diagnostic } }));
vi.mock("@/socket/board-events", () => ({ emitUserNotification: stub.emit }));
import { createNotifications, type CreateNotificationParams } from "./notifications";

const inputs: CreateNotificationParams[] = ["recipient-a", "recipient-b"].map(userId => ({
  userId, type: "automation_rule", title: "Synthetic title", message: "Synthetic message", metadata: { taskId: "task", projectId: "project" },
}));
const row = (input: CreateNotificationParams, id: string): Notification => ({
  ...input, id, read: false, readAt: null, actionUrl: null, metadata: {}, createdAt: new Date("2026-10-21T10:00:00Z"),
});

const client = (create: unknown) => ({
  notification: { create },
  user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, globalRole: "USER", isBlocked: false, blockedAt: null })) },
  task: { findFirst: vi.fn(async () => ({ id: "task" })) },
});
beforeEach(() => {
  vi.clearAllMocks();
  stub.transaction.mockImplementation(async (run: (tx: unknown) => Promise<Notification[]>) => run(client(stub.create)));
});

describe("bulk notification committed rows", () => {
  it("delivers exactly its committed IDs, never recent rows for the same recipients", async () => {
    const committed = inputs.map((input, index) => row(input, `batch-${index}`));
    stub.create.mockResolvedValueOnce(committed[0]).mockResolvedValueOnce(committed[1]);
    stub.findMany.mockResolvedValue([row(inputs[0], "another-concurrent-batch")]);

    await expect(createNotifications(inputs)).resolves.toEqual({ count: 2 });

    expect(stub.transaction).toHaveBeenCalledOnce();
    expect(stub.createMany).not.toHaveBeenCalled();
    expect(stub.findMany).not.toHaveBeenCalled();
    expect(stub.emit.mock.calls).toEqual(committed.map(notification => [notification]));
  });

  it("does no transaction or delivery for an empty batch", async () => {
    await expect(createNotifications([])).resolves.toEqual({ count: 0 });
    expect(stub.transaction).not.toHaveBeenCalled();
    expect(stub.create).not.toHaveBeenCalled();
    expect(stub.emit).not.toHaveBeenCalled();
  });

  it("keeps overlapping batches for the same recipient separate when commits finish out of order", async () => {
    const firstRow = row(inputs[0], "first-batch");
    const secondRow = row(inputs[0], "second-batch");
    let releaseFirst!: () => void;
    const firstCommit = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstInserted!: () => void;
    const inserted = new Promise<void>(resolve => { firstInserted = resolve; });
    stub.transaction
      .mockImplementationOnce(async (run: (tx: unknown) => Promise<Notification[]>) => {
        const result = await run(client(vi.fn().mockResolvedValue(firstRow)));
        firstInserted();
        await firstCommit;
        return result;
      })
      .mockImplementationOnce(async (run: (tx: unknown) => Promise<Notification[]>) =>
        run(client(vi.fn().mockResolvedValue(secondRow))),
      );
    const first = createNotifications([inputs[0]]);
    await inserted;
    await expect(createNotifications([inputs[0]])).resolves.toEqual({ count: 1 });
    expect(stub.emit.mock.calls).toEqual([[secondRow]]);
    releaseFirst();
    await expect(first).resolves.toEqual({ count: 1 });
    expect(stub.emit.mock.calls).toEqual([[secondRow], [firstRow]]);
    expect(stub.findMany).not.toHaveBeenCalled();
  });

  it("does not deliver any row before the transaction commits", async () => {
    const committed = inputs.map((input, index) => row(input, `batch-${index}`));
    stub.create.mockResolvedValueOnce(committed[0]).mockResolvedValueOnce(committed[1]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let rowsInserted!: () => void;
    const inserted = new Promise<void>(resolve => { rowsInserted = resolve; });
    stub.transaction.mockImplementation(async (run: (tx: unknown) => Promise<Notification[]>) => {
      const result = await run(client(stub.create));
      rowsInserted();
      await gate;
      return result;
    });
    const pending = createNotifications(inputs);
    await inserted;
    expect(stub.emit).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({ count: 2 });
    expect(stub.emit).toHaveBeenCalledTimes(2);
  });

  it("emits nothing when the transaction rolls back after inserts", async () => {
    stub.create.mockResolvedValue(row(inputs[0], "rolled-back"));
    const failure = new Error("Synthetic commit failure");
    stub.transaction.mockImplementation(async (run: (tx: unknown) => Promise<Notification[]>) => {
      await run(client(stub.create));
      throw failure;
    });
    await expect(createNotifications(inputs)).rejects.toBe(failure);
    expect(stub.emit).not.toHaveBeenCalled();
  });

  it("emits no partial batch if a later insert fails", async () => {
    const failure = new Error("Synthetic insert failure");
    stub.create.mockResolvedValueOnce(row(inputs[0], "rolled-back-first")).mockRejectedValueOnce(failure);
    await expect(createNotifications(inputs)).rejects.toBe(failure);
    expect(stub.create).toHaveBeenCalledTimes(2);
    expect(stub.emit).not.toHaveBeenCalled();
  });

  it("keeps committed success and attempts peers if delivery and diagnostics throw", async () => {
    const committed = inputs.map((input, index) => row(input, `batch-${index}`));
    stub.create.mockResolvedValueOnce(committed[0]).mockResolvedValueOnce(committed[1]);
    stub.emit.mockImplementationOnce(() => { throw new Error("Synthetic delivery failure"); });
    stub.diagnostic.mockImplementation(() => { throw new Error("Synthetic diagnostic failure"); });
    await expect(createNotifications(inputs)).resolves.toEqual({ count: 2 });
    expect(stub.emit.mock.calls).toEqual(committed.map(notification => [notification]));
  });
});
