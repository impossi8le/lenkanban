import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { taskDetailsCommandSchema } from "./validators";
import { createTaskCommandService } from "./task-command";

const operationId = "11111111-1111-4111-8111-111111111111";
const meta = { operationId, expectedVersion: 3 };

describe("strict scalar Task details command schema", () => {
  it("accepts only normalized scalar changes and preserves explicit nullable clears", () => {
    expect(taskDetailsCommandSchema.parse({ ...meta, changes: { title: "  Updated title  ", description: " Description ", priority: "HIGH", deadline: null } }))
      .toMatchObject({ ...meta, changes: { title: "Updated title", description: "Description", priority: "HIGH", deadline: null } });
    expect(taskDetailsCommandSchema.parse({ ...meta, changes: { description: null } })).toMatchObject({ changes: { description: null } });
  });
  it.each([
    { changes: { title: "Updated" }, expectedVersion: 3 }, { ...meta, changes: {} }, { ...meta, changes: null },
    { ...meta, changes: { status: "DONE" } }, { ...meta, changes: { columnId: "column" } }, { ...meta, changes: { position: 2 } },
    { ...meta, changes: { title: "Updated", assigneeIds: ["user"] } }, { ...meta, actorId: "other", changes: { title: "Updated" } },
    { ...meta, changes: { title: " " } }, { ...meta, changes: { title: "x".repeat(201) } },
    { ...meta, changes: { description: "x".repeat(50001) } }, { ...meta, changes: { priority: "OWNER" } },
    { ...meta, changes: { deadline: "not-a-date" } }, { ...meta, changes: { deadline: "2026-02-30T12:00:00Z" } },
    { ...meta, operationId: "bad", changes: { title: "Updated" } },
    { ...meta, expectedVersion: -1, changes: { title: "Updated" } }, { ...meta, expectedVersion: 2147483648, changes: { title: "Updated" } },
  ])("rejects malformed metadata or non-scalar changes %#", body => {
    expect(taskDetailsCommandSchema.safeParse(body).success).toBe(false);
  });
  it("accepts both version bounds and exact scalar size bounds without allowing an empty command", () => {
    for (const expectedVersion of [0, 2147483647]) expect(taskDetailsCommandSchema.safeParse({ operationId: randomUUID(), expectedVersion,
      changes: { title: "x".repeat(200), description: "x".repeat(50000) } }).success).toBe(true);
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const task = { id: "task", projectId: "project", columnId: "column", version: 3, title: "Original", description: "Original description" as string | null,
    priority: "MEDIUM", deadline: null as Date | null, position: 1024, rank: "rank-unchanged", status: "TODO", updatedAt: new Date("2026-10-21T00:00:00Z") };
  let actor: { id: string; globalRole: "USER" | "ADMIN" } | null = { id: "actor", globalRole: "USER" };
  const project = { id: "project", ownerId: "actor", members: [] as { role: "MEMBER" | "PROJECT_ADMIN" }[] };
  const receipts = new Map<string, Record<string, unknown>>(); const calls: string[] = [];
  let marker: unknown = null;
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join("?"); const kind = text.includes("pg_advisory") ? "operation-lock" : text.includes('FROM "ProjectColumn"') ? "column-lock" : text.includes('FROM "Project"') ? "project-lock" : text.includes('FROM "Task"') ? "task-lock" : "actor-lock";
      calls.push(kind); return [{ id: values[0] }];
    }),
    task: {
      findUnique: vi.fn(async () => { calls.push("task-read"); return { ...task }; }),
      updateMany: vi.fn(async ({ where, data }: { where: { version: number }; data: { version: { increment: number }; title?: string; description?: string | null; priority?: string; deadline?: Date | null } }) => {
        calls.push("task-cas"); if (where.version !== task.version) return { count: 0 }; const { version, ...changes } = data; Object.assign(task, changes); task.version += version.increment; task.updatedAt = new Date("2026-10-21T01:00:00Z"); return { count: 1 };
      }),
    },
    user: { findUnique: vi.fn(async () => { calls.push("fresh-actor"); return actor; }) },
    taskAssignee: { findMany: vi.fn(async () => [{ userId: "actor" }]) },
    taskRequest: { findUnique: vi.fn(async () => { calls.push("marker-read"); return marker; }) },
    project: { findUnique: vi.fn(async () => { calls.push("project-access"); return project; }) },
    activity: { create: vi.fn(async () => { calls.push("activity"); return { id: "activity" }; }) },
    taskCommandOperation: {
      findUnique: vi.fn(async ({ where }: { where: { actorId_operationId: { actorId: string; operationId: string } } }) => { calls.push("receipt-read"); return receipts.get(`${where.actorId_operationId.actorId}/${where.actorId_operationId.operationId}`) ?? null; }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { calls.push("receipt-write"); const row = structuredClone(data); receipts.set(`${data.actorId}/${data.operationId}`, row); return row; }),
    },
  };
  const transaction = vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx));
  const service = createTaskCommandService({ $transaction: transaction } as unknown as Parameters<typeof createTaskCommandService>[0]);
  const input = (changes: Parameters<typeof service.saveDetails>[0]["changes"] = { title: "Updated" }, expectedVersion = 3, id: string = randomUUID()) => ({ actorId: "actor", taskId: "task", operationId: id, expectedVersion, changes });
  return { service, tx, transaction, task, project, receipts, calls, input, setActor: (value: typeof actor) => { actor = value; }, setMarker: (value: unknown) => { marker = value; } };
}

describe("Task scalar command transaction protocol (mock DB, no rollback/concurrency claim)", () => {
  it.each(["USER", "ADMIN"] as const)("denies a non-executor %s before receipt/write, even on deadline replay", async globalRole => {
    const f = fixture();
    f.setActor({ id: "actor", globalRole });
    const input = f.input({ deadline: "2026-10-24T12:00:00Z" });
    await f.service.saveDetails(input);
    vi.clearAllMocks();
    f.tx.taskAssignee.findMany.mockResolvedValue([{ userId: "other" }]);
    await expect(f.service.saveDetails(input)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.tx.taskCommandOperation.findUnique).not.toHaveBeenCalled();
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.tx.activity.create).not.toHaveBeenCalled();
  });
  it("uses operation→Project→Column→Task→fresh actor→real project-access→receipt and scalar CAS only", async () => {
    const f = fixture(); const result = await f.service.saveDetails(f.input());
    expect(result.ack).toEqual({ taskId: "task", projectId: "project", version: 4, changed: true, replayed: false });
    expect(f.calls.slice(0, 11)).toEqual(["operation-lock", "task-read", "project-lock", "column-lock", "task-lock", "task-read", "actor-lock", "fresh-actor", "project-access", "marker-read", "receipt-read"]);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(f.tx.task.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: "task", projectId: "project", columnId: "column", version: 3 }, data: { version: { increment: 1 }, title: "Updated" } });
    expect(f.task).toMatchObject({ rank: "rank-unchanged", status: "TODO", position: 1024, projectId: "project", columnId: "column" });
    expect(f.tx.activity.create).toHaveBeenCalledExactlyOnceWith({ data: { taskId: "task", userId: "actor", action: "title_changed", oldValue: { title: "Original" }, newValue: { title: "Updated" } } });
    const receipt = [...f.receipts.values()][0]; expect(Object.keys(receipt).sort()).toEqual(["actorId", "changed", "committedVersion", "expectedVersion", "operationId", "projectId", "requestHash", "taskId"]); expect(JSON.stringify(receipt)).not.toMatch(/Original|Updated|description/);
  });
  it("records no-op receipt without Task.updatedAt/version/activity changes", async () => {
    const f = fixture(), updatedAt = f.task.updatedAt;
    expect(await f.service.saveDetails(f.input({ title: " Original ", description: "Original description" }))).toEqual({ ack: { taskId: "task", projectId: "project", version: 3, changed: false, replayed: false }, effects: null });
    expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(f.tx.taskCommandOperation.create).toHaveBeenCalledOnce(); expect(f.task.updatedAt).toBe(updatedAt);
  });
  it("normalizes UUID case, changes field order and equivalent timezone before hashing/replay", async () => {
    const f = fixture(), id = randomUUID();
    const first = await f.service.saveDetails(f.input({ deadline: "2026-10-21T14:00:00+02:00", priority: "HIGH" }, 3, id.toUpperCase()));
    expect(first.effects).toEqual({ priority: { oldValue: "MEDIUM", newValue: "HIGH" }, deadlineSet: "2026-10-21T12:00:00.000Z" });
    const replay = await f.service.saveDetails(f.input({ priority: "HIGH", deadline: "2026-10-21T12:00:00Z" }, 3, id)); expect(replay).toEqual({ ack: { ...first.ack, replayed: true }, effects: null }); expect(f.receipts.size).toBe(1); expect(f.tx.activity.create).toHaveBeenCalledTimes(2);
  });
  it("returns an old ACK after a later update without applying its historical contents", async () => {
    const f = fixture(), firstInput = f.input(), first = await f.service.saveDetails(firstInput);
    await f.service.saveDetails(f.input({ title: "Current" }, 4)); vi.clearAllMocks();
    expect(await f.service.saveDetails(firstInput)).toEqual({ ack: { ...first.ack, replayed: true }, effects: null }); expect(f.task.title).toBe("Current"); expect(f.task.version).toBe(5); expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled();
  });
  it.each(["missing-actor", "revoked-membership"])("rechecks %s before replay rather than treating receipt as authorization", async failure => {
    const f = fixture(), input = f.input(); await f.service.saveDetails(input); vi.clearAllMocks();
    if (failure === "missing-actor") f.setActor(null); else f.project.ownerId = "other";
    await expect(f.service.saveDetails(input)).rejects.toMatchObject({ name: "NotFoundError" }); expect(f.tx.taskCommandOperation.findUnique).not.toHaveBeenCalled(); expect(f.tx.task.updateMany).not.toHaveBeenCalled();
  });
  it("reads current actor only after resource locks have finished waiting", async () => {
    const f = fixture(), gate = deferred(); const normal = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementationOnce(async (...args) => { await gate.promise; return normal(...args); });
    const pending = f.service.saveDetails(f.input()); expect(f.tx.user.findUnique).not.toHaveBeenCalled(); f.setActor(null); gate.resolve(); await expect(pending).rejects.toMatchObject({ name: "NotFoundError" });
  });
  it.each(["project", "column"])("rejects %s identity drift before access/receipt/CAS", async resource => {
    const f = fixture(); f.tx.task.findUnique.mockResolvedValueOnce({ ...f.task });
    if (resource === "project") f.task.projectId = "other-project"; else f.task.columnId = "other-column";
    await expect(f.service.saveDetails(f.input())).rejects.toMatchObject({ code: "IDENTITY_CHANGED" }); expect(f.tx.user.findUnique).not.toHaveBeenCalled(); expect(f.tx.taskCommandOperation.findUnique).not.toHaveBeenCalled(); expect(f.tx.task.updateMany).not.toHaveBeenCalled();
  });
  it("rejects stale version and a failed scalar CAS without Activity or receipt", async () => {
    const f = fixture(); await expect(f.service.saveDetails(f.input({ title: "Updated" }, 2))).rejects.toMatchObject({ code: "STALE_TASK_VERSION" }); expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    f.tx.task.updateMany.mockResolvedValueOnce({ count: 0 }); await expect(f.service.saveDetails(f.input())).rejects.toMatchObject({ code: "STALE_TASK_VERSION" }); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
  });
  it("rejects overflow before mutation while allowing an unchanged max-version receipt", async () => {
    const f = fixture(); f.task.version = 2147483647;
    await expect(f.service.saveDetails(f.input({ title: "Updated" }, f.task.version))).rejects.toMatchObject({ code: "VERSION_EXHAUSTED" }); expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect((await f.service.saveDetails(f.input({ title: "Original" }, f.task.version))).ack).toMatchObject({ version: 2147483647, changed: false });
  });
  it.each(["changes", "version", "task"])("rejects same operation UUID with changed %s fingerprint", async changed => {
    const f = fixture(), input = f.input(); await f.service.saveDetails(input);
    const next = { ...input, changes: changed === "changes" ? { title: "Other" } : input.changes, expectedVersion: changed === "version" ? 4 : 3, taskId: changed === "task" ? "other-task" : "task" };
    await expect(f.service.saveDetails(next)).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" }); expect(f.receipts.size).toBe(1);
  });
  it.each(["version", "actor", "resource", "changed"])("fails closed on corrupt stored receipt %s", async corruption => {
    const f = fixture(), input = f.input(); await f.service.saveDetails(input); const receipt = [...f.receipts.values()][0];
    if (corruption === "version") receipt.committedVersion = 99; if (corruption === "actor") receipt.actorId = "other"; if (corruption === "resource") receipt.projectId = "other"; if (corruption === "changed") receipt.changed = "true";
    vi.clearAllMocks(); await expect(f.service.saveDetails(input)).rejects.toMatchObject({ code: "INVALID_RECEIPT" }); expect(f.tx.task.updateMany).not.toHaveBeenCalled();
  });
  it("captures immutable normalized scalar changes and actor metadata before waiting", async () => {
    const f = fixture(), gate = deferred(); f.tx.$queryRaw.mockImplementationOnce(async () => { await gate.promise; return []; });
    const input = f.input(), originalId = input.operationId; const pending = f.service.saveDetails(input); input.changes.title = "Changed caller"; input.actorId = "other"; input.taskId = "other-task"; input.operationId = randomUUID(); input.expectedVersion = 99; gate.resolve();
    expect((await pending).ack).toMatchObject({ taskId: "task", version: 4 }); expect(f.task.title).toBe("Updated"); expect([...f.receipts.values()][0]).toMatchObject({ actorId: "actor", operationId: originalId, expectedVersion: 3 });
  });
  it.each(["activity", "receipt"])("awaits mandatory %s persistence and propagates its rejection", async stage => {
    const f = fixture(), gate = deferred(); let settled = false; const failure = Error(`Synthetic ${stage} rejection`);
    const target = stage === "activity" ? f.tx.activity.create : f.tx.taskCommandOperation.create; target.mockImplementationOnce(async () => { await gate.promise; throw failure; });
    const pending = f.service.saveDetails(f.input()).finally(() => { settled = true; }); const rejected = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(target).toHaveBeenCalledOnce()); expect(settled).toBe(false); gate.resolve(); await rejected;
  });
});

describe("Task scalar command refuses explicit request markers before receipts or writes", () => {
  const states = ["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"] as const;
  const modes = ["new", "noop", "historical"] as const;
  const marker = (state: typeof states[number]) => ({ taskId: "task", contractVersion: 1, state, authorId: "request-author", executorId: ["IN_PROGRESS", "NEEDS_INFO", "COMPLETED"].includes(state) ? "executor" : null });
  function untouched(f: ReturnType<typeof fixture>) {
    expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(f.tx.taskCommandOperation.create).not.toHaveBeenCalled();
    expect(f.tx.taskCommandOperation.findUnique).not.toHaveBeenCalled();
  }
  it.each(states.flatMap(state => modes.map(mode => ({ state, mode }))))("blocks $state/$mode without CAS, Activity or receipt access", async ({ state, mode }) => {
    const f = fixture(), input = f.input(mode === "noop" ? { title: "Original" } : { title: "Updated" });
    if (mode === "historical") await f.service.saveDetails(input);
    const before = structuredClone(f.task), receipts = structuredClone([...f.receipts]); vi.clearAllMocks(); f.setMarker(marker(state));
    await expect(f.service.saveDetails(input)).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); untouched(f);
    expect(f.task).toEqual(before); expect([...f.receipts]).toEqual(receipts);
    expect(f.tx.project.findUnique.mock.invocationCallOrder[0]).toBeLessThan(f.tx.taskRequest.findUnique.mock.invocationCallOrder[0]);
  });
  it.each([undefined, { ...marker("DRAFT"), contractVersion: 2 }, { ...marker("DRAFT"), privateTitle: "private-request-text" }])("blocks malformed marker %# without treating it as absence", async value => {
    const f = fixture(); f.setMarker(value); await expect(f.service.saveDetails(f.input())).rejects.toMatchObject({ code: "INVALID_REQUEST_MARKER" }); untouched(f);
  });
  it.each(["missing-actor", "outsider"])("checks fresh %s before touching any marker or receipt", async scenario => {
    const f = fixture(); f.setMarker(marker("DRAFT"));
    if (scenario === "missing-actor") f.setActor(null); else f.project.ownerId = "other";
    await expect(f.service.saveDetails(f.input())).rejects.toMatchObject({ name: "NotFoundError" }); expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled(); untouched(f);
  });
  it("does not bypass a marker for a global administrator", async () => {
    const f = fixture(); f.setActor({ id: "actor", globalRole: "ADMIN" }); f.setMarker(marker("DRAFT"));
    await expect(f.service.saveDetails(f.input())).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); untouched(f);
  });
  it.each(["missing-delegate", "database-error"])("fails closed on %s rather than guessing legacy absence", async scenario => {
    const f = fixture(), original = Error("synthetic marker storage failure");
    if (scenario === "missing-delegate") Reflect.deleteProperty(f.tx, "taskRequest"); else f.tx.taskRequest.findUnique.mockRejectedValue(original);
    const operation = f.service.saveDetails(f.input()); if (scenario === "database-error") await expect(operation).rejects.toBe(original); else await expect(operation).rejects.toBeInstanceOf(Error);
    untouched(f);
  });
});
