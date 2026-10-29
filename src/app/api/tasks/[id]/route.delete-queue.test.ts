import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), transaction: vi.fn(), remove: vi.fn(), invalidate: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findFirst: mocks.read }, $transaction: mocks.transaction } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: mocks.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/features/kanban/server/task-lifecycle-service", async original => ({ ...await original<typeof import("@/features/kanban/server/task-lifecycle-service")>(), deleteTaskLifecycleAware: mocks.remove }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: async () => ({}), requireTaskWrite: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: vi.fn() }));
vi.mock("@/socket/request-queue-events", () => ({ emitRequestQueueInvalidation: mocks.invalidate }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: mocks.load, TASK_WITH_RELATIONS_INCLUDE: {} }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: vi.fn(), emitTaskDeleted: vi.fn(), emitTaskMoved: vi.fn() }));
import { DELETE } from "./route";

const run = () => DELETE(new Request("http://localhost/api/tasks/task", { method: "DELETE" }), { params: Promise.resolve({ id: "task" }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.read.mockResolvedValue({ id: "task", projectId: "board" });
  mocks.remove.mockResolvedValue({ logical: true, changed: true, previousQueueRecipientIds: ["previous-reader"] });
  mocks.transaction.mockImplementation(async callback => callback({}));
  mocks.load.mockResolvedValue(null);
  mocks.invalidate.mockResolvedValue(undefined);
});

describe("queue clearing after caller-owned delete transaction", () => {
  it("carries prior recipients across commit and invalidates after the outer transaction", async () => {
    let committed = false;
    mocks.transaction.mockImplementation(async callback => { const result = await callback({}); committed = true; return result; });
    mocks.invalidate.mockImplementation(async () => { expect(committed).toBe(true); });
    const response = await run();
    expect(response.status).toBe(200);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith({ taskId: "task", projectId: "board", previousRecipientIds: ["previous-reader"] });
    expect(JSON.stringify(await response.json())).not.toContain("previous-reader");
  });
  it("does not emit a queue change when the transaction rolls back", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("rollback"));
    expect((await run()).status).toBe(500);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("does not emit without a changed queue projection", async () => {
    mocks.remove.mockResolvedValueOnce({ logical: true, changed: false });
    expect((await run()).status).toBe(200);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it("preserves the committed delete ACK if invalidation transport fails", async () => {
    mocks.invalidate.mockRejectedValueOnce(new Error("offline"));
    expect((await run()).status).toBe(200);
  });
});
