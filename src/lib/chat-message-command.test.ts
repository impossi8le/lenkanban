import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const policy = vi.hoisted(() => ({ content: vi.fn(), internal: vi.fn(), internalIds: vi.fn(), access: vi.fn() }));
vi.mock("@/features/kanban/server/task-lifecycle-service", () => ({ authorizeTaskRequestContentWrite: policy.content }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-access", () => ({ canActorReadInternal: policy.internal, loadInternalMessageIds: policy.internalIds, loadProjectDiscussionFacts: async () => ({}) }));
vi.mock("@/lib/project-access", () => ({ getProjectAccess: policy.access }));
import { changeOwnMessage } from "./chat-message-command";
import { NotFoundError, ForbiddenError } from "./errors";
const command = { actorId: "author", taskId: "task", messageId: "message", action: "edit" as const, operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 0, contentText: "After" };
function fixture() {
  const state = { message: { id: "message", taskId: "task", authorId: "author", contentText: "Before", version: 0, deletedAt: null as Date | null, editedAt: null as Date | null, isInternal: false,
    attachments: [{ url: "/file" }], mentions: ["reader"], reactions: { "ok": ["reader"] }, readBy: { reader: true }, author: { id: "author" } }, activities: [] as Record<string, unknown>[], receipts: [] as Record<string, unknown>[] }; let working = state;
  const options = { cas: false, activityFailure: false, receiptFailure: false, locked: true, onLock: undefined as undefined | (() => void) };
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => { if (query.join("").includes('FROM "ChatMessage"')) { options.onLock?.(); return options.locked ? [{ id: "message" }] : []; } return []; }),
    task: { findUnique: vi.fn(async () => ({ projectId: "project" })) }, user: { findUnique: vi.fn(async () => ({ id: "author", globalRole: "USER" })) },
    chatMessage: { findUnique: vi.fn(async () => structuredClone(working.message)), findUniqueOrThrow: vi.fn(async () => structuredClone(working.message)),
      updateMany: vi.fn(async ({ where, data }: { where: { version: number }; data: { contentText?: string; editedAt?: Date; deletedAt?: Date } }) => {
        if (options.cas || where.version !== working.message.version) return { count: 0 }; Object.assign(working.message, data, { version: working.message.version + 1 }); return { count: 1 }; }) },
    activity: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { if (options.activityFailure) throw Error("synthetic"); working.activities.push(data); return data; }) },
    taskMoveOperation: { findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => working.receipts.find(row => row.operationId === where.operationId) ?? null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { if (options.receiptFailure) throw Error("synthetic"); working.receipts.push(data); return data; }) },
  };
  const database = { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => { working = structuredClone(state); const result = await run(tx); Object.assign(state, working); return result; } };
  return { state, options, tx, setLockedAuthor: (id: string) => { working.message.authorId = id; }, run: (body: Parameters<typeof changeOwnMessage>[1] = command) => changeOwnMessage(database as never, body) };
}
beforeEach(() => { vi.resetAllMocks(); policy.content.mockResolvedValue({ allowed: true, marked: true }); policy.access.mockResolvedValue({ canWrite: false }); policy.internal.mockResolvedValue(true); policy.internalIds.mockResolvedValue(new Set()); });
describe("own message commands (transactional mock, no real DB)", () => {
  it("edits with message CAS, old/new Activity and metadata-only durable receipt; exact retry does not repeat effects", async () => {
    const f = fixture(); const result = await f.run(); expect(result.ack).toEqual({ taskId: "task", messageId: "message", version: 1, changed: true, replayed: false });
    expect(f.state.message.contentText).toBe("After"); expect(f.state.message.editedAt).toBeInstanceOf(Date);
    expect(f.state.activities).toEqual([{ taskId: "task", userId: "author", action: "message_edited", oldValue: { messageId: "message", contentText: "Before", isInternal: false }, newValue: { messageId: "message", contentText: "After", isInternal: false } }]);
    expect(JSON.stringify(f.state.receipts)).not.toContain("Before"); expect(JSON.stringify(f.state.receipts)).not.toContain("After");
    expect((await f.run()).ack).toMatchObject({ replayed: true, version: 1 }); expect(f.tx.chatMessage.updateMany).toHaveBeenCalledOnce(); expect(policy.content).toHaveBeenCalledTimes(2);
  });
  it("soft-deletes and emits a safe tombstone while retaining content/files in storage and Activity", async () => {
    const f = fixture(); const result = await f.run({ ...command, action: "delete", contentText: undefined });
    expect(f.state.message.deletedAt).toBeInstanceOf(Date); expect(f.state.message.contentText).toBe("Before"); expect(f.state.message.attachments).toHaveLength(1);
    expect(result.message).toMatchObject({ contentText: "", attachments: [], mentions: [], reactions: {}, readBy: {}, version: 1 });
    expect(f.state.activities[0]).toMatchObject({ action: "message_deleted", oldValue: { contentText: "Before" }, newValue: { contentText: "" } });
  });
  it("rejects a parallel stale version and changed retry intent", async () => { const f = fixture(); await f.run(); await expect(f.run({ ...command, contentText: "Different" })).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
    await expect(f.run({ ...command, operationId: "22222222-2222-4222-8222-222222222222" })).rejects.toMatchObject({ code: "STALE_TASK_VERSION" });
    f.state.receipts = []; await expect(f.run()).rejects.toMatchObject({ code: "STALE_TASK_VERSION" }); });
  it("does not trust foreign author, wrong task or absent locked message", async () => { const f = fixture(); f.state.message.authorId = "other"; await expect(f.run()).rejects.toBeInstanceOf(ForbiddenError);
    f.state.message.authorId = "author"; f.state.message.taskId = "other"; await expect(f.run()).rejects.toBeInstanceOf(NotFoundError);
    f.state.message.taskId = "task"; f.options.locked = false; await expect(f.run()).rejects.toBeInstanceOf(NotFoundError); expect(f.state.activities).toEqual([]); });
  it("rechecks current read/content permission on replay after revocation", async () => { const f = fixture(); await f.run(); policy.content.mockRejectedValueOnce(new NotFoundError()); await expect(f.run()).rejects.toBeInstanceOf(NotFoundError); expect(f.state.activities).toHaveLength(1); });
  it("denies editing own internal text after internal access is revoked", async () => { const f = fixture(); f.state.message.isInternal = true; policy.internal.mockResolvedValue(false); await expect(f.run()).rejects.toBeInstanceOf(NotFoundError); expect(f.state.message.version).toBe(0); });
  it.each(["cas", "activityFailure", "receiptFailure"] as const)("rolls back the whole correction after %s", async failure => { const f = fixture(); f.options[failure] = true; await expect(f.run()).rejects.toBeDefined(); expect(f.state.message.contentText).toBe("Before"); expect(f.state.activities).toEqual([]); expect(f.state.receipts).toEqual([]); });
  it("records no Activity or editedAt for identical text", async () => { const f = fixture(); const result = await f.run({ ...command, contentText: "Before" }); expect(result.ack).toMatchObject({ changed: false, version: 0 }); expect(f.state.activities).toEqual([]); expect(f.state.message.editedAt).toBeNull(); });
  it("rejects blank text without files, deleted messages, malformed commands and corrupt receipts", async () => { const f = fixture(); f.state.message.attachments = []; await expect(f.run({ ...command, contentText: "  " })).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    f.state.message.deletedAt = new Date(); await expect(f.run()).rejects.toMatchObject({ code: "MESSAGE_DELETED" }); f.state.message.deletedAt = null;
    await expect(f.run({ ...command, operationId: "invalid" })).rejects.toMatchObject({ code: "INVALID_COMMAND" }); await f.run(); (f.state.receipts[0].response as { version: number }).version = 99; await expect(f.run()).rejects.toMatchObject({ code: "INVALID_RECEIPT" }); });
});

it("keeps legacy read-only observers from editing own text; legacy write capability is still required", async () => {
  const f = fixture(); policy.content.mockResolvedValue({ allowed: true, marked: false });
  await expect(f.run()).rejects.toBeInstanceOf(NotFoundError); expect(f.tx.chatMessage.updateMany).not.toHaveBeenCalled();
  policy.access.mockResolvedValue({ canWrite: true }); expect((await f.run()).ack.changed).toBe(true);
});

it("checks the current author only after acquiring the message lock", async () => { const f = fixture(); f.options.onLock = () => f.setLockedAuthor("other"); await expect(f.run()).rejects.toBeInstanceOf(ForbiddenError); expect(f.state.activities).toEqual([]); expect(f.state.message.version).toBe(0); });
