import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const policy = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/features/kanban/server/task-lifecycle-service", () => ({ authorizeTaskAttachmentDetach: policy.authorize }));
import { detachTaskAttachment, AttachmentInMessageError } from "./detach-command";
import { NotFoundError } from "@/lib/errors";
const file = { url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "File.pdf", size: 10, mime: "application/pdf" };
const other = { ...file, url: "/other", name: "Keep.pdf" };
const command = { actorId: "author", taskId: "task", operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 7, url: file.url };
function fixture() {
  const state = { version: 7, attachments: [file, other], activities: [] as unknown[], receipts: [] as Record<string, unknown>[] }; let working = state;
  const options = { published: false, cas: false, activityFailure: false };
  const tx = {
    taskRequest:{updateMany:vi.fn(async()=>({count:0}))},
    $queryRaw: vi.fn(async () => []),
    task: { findUnique: vi.fn(async ({ select }: { select: { projectId?: boolean } }) => select.projectId ? { projectId: "project" } : { attachments: working.attachments }),
      updateMany: vi.fn(async ({ where, data }: { where: { version: number }; data: { attachments: typeof file[] } }) => { if (options.cas || where.version !== working.version) return { count: 0 }; working.attachments = data.attachments; working.version++; return { count: 1 }; }) },
    chatMessage: { findFirst: vi.fn(async () => options.published ? { id: "message" } : null) },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => { if (options.activityFailure) throw Error("synthetic-storage"); working.activities.push(data); return data; }) },
    taskCommandOperation: { findUnique: vi.fn(async () => working.receipts[0] ?? null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { working.receipts.push(data); return data; }) },
  };
  policy.authorize.mockImplementation(async () => ({ actor: { id: "author", globalRole: "USER" }, projectId: "project", version: working.version }));
  const database = { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => { working = structuredClone(state); const value = await run(tx); Object.assign(state, working); return value; } };
  return { state, tx, options, run: (body = command) => detachTaskAttachment(database as never, body) };
}
beforeEach(() => { vi.resetAllMocks(); });
describe("versioned attachment detach transaction", () => {
  it("keeps other metadata, increments once, persists a receipt/activity and replays without another write", async () => {
    const f = fixture(); const ack = await f.run(); expect(ack).toEqual({ taskId: "task", projectId: "project", version: 8, changed: true, replayed: false });
    expect(f.state.attachments).toEqual([other]); expect(f.state.activities).toEqual([expect.objectContaining({ action: "attachment_removed", newValue: { count: 1 } })]);
    expect(await f.run()).toMatchObject({ version: 8, replayed: true }); expect(f.tx.task.updateMany).toHaveBeenCalledOnce(); expect(f.state.receipts).toHaveLength(1);
    expect(policy.authorize).toHaveBeenCalledTimes(2);
  });
  it("rejects stale or changed replay intent without writes", async () => {
    const f = fixture(); await expect(f.run({ ...command, expectedVersion: 6 })).rejects.toMatchObject({ code: "STALE_TASK_VERSION" }); expect(f.state.version).toBe(7);
    await f.run(); await expect(f.run({ ...command, url: other.url })).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" }); expect(f.state.version).toBe(8);
  });
  it("protects every published message reference with a scoped JSON containment query", async () => {
    const f = fixture(); f.options.published = true; await expect(f.run()).rejects.toBeInstanceOf(AttachmentInMessageError);
    expect(f.tx.chatMessage.findFirst).toHaveBeenCalledWith({ where: { taskId: "task", attachments: { array_contains: [{ url: file.url }] } }, select: { id: true } });
    expect(f.state.attachments).toEqual([file, other]); expect(f.state.receipts).toEqual([]);
  });
  it("does not treat an absent reference or revoked writer as removable", async () => {
    const f = fixture(); await expect(f.run({ ...command, url: "/missing" })).rejects.toBeInstanceOf(NotFoundError);
    policy.authorize.mockRejectedValueOnce(new NotFoundError()); await expect(f.run()).rejects.toBeInstanceOf(NotFoundError); expect(f.state.version).toBe(7); expect(f.state.activities).toEqual([]);
  });
  it.each(["cas", "activityFailure"] as const)("rolls back metadata and receipts after %s", async failure => {
    const f = fixture(); f.options[failure] = true; await expect(f.run()).rejects.toBeDefined(); expect(f.state.attachments).toEqual([file, other]); expect(f.state.version).toBe(7); expect(f.state.receipts).toEqual([]);
  });
  it("fails closed on a corrupt receipt", async () => { const f = fixture(); await f.run(); f.state.receipts[0].committedVersion = 99; await expect(f.run()).rejects.toMatchObject({ code: "INVALID_RECEIPT" }); });
});

it("clears only the currently referenced invoice in the same versioned detach transaction",async()=>{
 const f=fixture();await f.run();expect(f.tx.taskRequest.updateMany).toHaveBeenCalledExactlyOnceWith({where:{taskId:"task",currentInvoiceUrl:file.url},data:{beznalPhase:"WAITING",currentInvoiceUrl:null}});
 await f.run();expect(f.tx.taskRequest.updateMany).toHaveBeenCalledTimes(1);
});
