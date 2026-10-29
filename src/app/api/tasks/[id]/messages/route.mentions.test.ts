import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ db: {} as object, validate: vi.fn(), persist: vi.fn(), deliver: vi.fn(), ordinary: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(api.db, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: async () => ({ id: "actor", globalRole: "USER" }), UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: async () => ({ id: "task" }) }));
vi.mock("@/features/kanban/server/task-lifecycle-service", () => ({ authorizeTaskRequestContentWrite: async () => ({ allowed: true, marked: true }), TaskLifecycleError: class TaskLifecycleError extends Error {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => undefined, rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/activity-logger", () => ({ logActivityWithClient: async () => undefined }));
vi.mock("@/lib/task-mentions", async original => ({ ...await original<typeof import("@/lib/task-mentions")>(), validateTaskMentions: api.validate, persistTaskMentions: api.persist }));
vi.mock("@/lib/notifications", () => ({ deliverNotifications: api.deliver }));
vi.mock("./discussion-notifications", () => ({ persistTaskContentNotifications: api.ordinary }));
vi.mock("@/socket/board-events", () => ({ emitTaskMessageCreated: api.emit }));
import { POST } from "./route";
import { TaskMentionError } from "@/lib/task-mentions";
function fixture() {
  const state = { messages: [] as Record<string, unknown>[], receipts: [] as Record<string, unknown>[] }; let working = state; let active = false;
  const tx = {
    $queryRaw: vi.fn(async () => []), task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    chatMessage: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: "message", ...data, author: { id: "actor", email: "actor@example.invalid", name: "Actor", avatarUrl: null }, createdAt: new Date("2026-10-27T12:00:00Z") }; working.messages.push(row); return row; }) },
    taskMoveOperation: { findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => working.receipts.find(row => row.operationId === where.operationId) ?? null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { working.receipts.push(data); return data; }) },
  };
  api.db = { task: { findFirst: async () => ({ id: "task", projectId: "board" }) }, $transaction: async (run: (client: typeof tx) => Promise<unknown>) => { active = true; working = structuredClone(state); try { const value = await run(tx); Object.assign(state, working); return value; } finally { active = false; } } };
  api.persist.mockImplementation(async () => { expect(active).toBe(true); return [{ id: "notification", userId: "selected" }]; });
  api.deliver.mockImplementation(() => expect(active).toBe(false));
  const send = (body: object) => POST(new Request("http://localhost/api/tasks/task/messages", { method: "POST", headers: { Origin: "http://localhost" }, body: JSON.stringify({ contentText: "@Анна сообщение", ...body }) }), { params: Promise.resolve({ id: "task" }) });
  return { state, tx, send };
}
beforeEach(() => { vi.resetAllMocks(); api.validate.mockResolvedValue(undefined); api.ordinary.mockResolvedValue([]); });
describe("HTTP explicit mention transaction", () => {
  it("stores selected IDs, persists in the transaction, delivers after commit and excludes the ordinary duplicate", async () => {
    const f = fixture(); const response = await f.send({ mentionUserIds: ["selected"] }); expect(response.status).toBe(201);
    expect(f.state.messages[0].mentions).toEqual(["selected"]); expect(api.validate).toHaveBeenCalledWith(f.tx, "task", "board", ["selected"], "PUBLIC");
    expect(api.persist).toHaveBeenCalledWith(f.tx, expect.objectContaining({ mentionUserIds: ["selected"], messageId: "message" }));
    expect(api.deliver).toHaveBeenCalledOnce(); expect(api.ordinary).toHaveBeenCalledWith(expect.objectContaining({ excludedRecipientIds: ["selected"] }));
  });
  it("rolls back the whole message for inaccessible recipients or persistence failure", async () => {
    const f = fixture(); api.validate.mockRejectedValueOnce(new TaskMentionError("MENTION_RECIPIENT_UNAVAILABLE"));
    const response = await f.send({ mentionUserIds: ["hidden"] }); expect(response.status).toBe(422); expect(JSON.stringify(await response.json())).not.toContain("hidden"); expect(f.state.messages).toEqual([]);
    api.persist.mockRejectedValueOnce(new Error("storage")); expect((await f.send({ mentionUserIds: ["selected"] })).status).toBe(500); expect(f.state.messages).toEqual([]); expect(api.deliver).not.toHaveBeenCalled(); expect(api.ordinary).not.toHaveBeenCalled();
  });
  it("includes the normalized ID set in receipt identity and does not repeat effects", async () => {
    const f = fixture(); const command = { operationId: "66666666-6666-4666-8666-666666666666", expectedVersion: 7, mentionUserIds: ["z", "a"] };
    expect((await f.send(command)).status).toBe(201); expect((await f.send({ ...command, mentionUserIds: ["a", "z"] })).status).toBe(200);
    expect((await f.send({ ...command, mentionUserIds: ["other"] })).status).toBe(409);
    expect(f.state.messages).toHaveLength(1); expect(api.persist).toHaveBeenCalledOnce(); expect(api.deliver).toHaveBeenCalledOnce(); expect(api.ordinary).toHaveBeenCalledOnce();
  });
  it.each([{ mentionUserIds: ["same", "same"] }, { mentionUserIds: Array.from({ length: 21 }, (_, id) => `user${id}`) }])("rejects invalid intent before the transaction %j", async ({ mentionUserIds }) => {
    const f = fixture(); expect((await f.send({ mentionUserIds })).status).toBe(422); expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
  });
});
