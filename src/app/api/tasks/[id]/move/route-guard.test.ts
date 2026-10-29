import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoveTaskError } from "@/features/kanban/server/move-errors";

const mocks = vi.hoisted(() => ({ move: vi.fn(), emit: vi.fn(), automation: vi.fn() }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: async () => ({ id: "actor", globalRole: "ADMIN" }),
  UnauthorizedError: class extends Error {},
}));
vi.mock("@/lib/project-access", () => ({ requireProjectWrite: async () => {} }));
// Quota SQL is exercised by adjacent route.rate-limit tests; retain this
// fixture's focused transactional/receipt/rollback assertions behind admission.
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => undefined, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findUnique: async () => ({ projectId: "project", status: "TODO", version: 2 }) } } }));
vi.mock("@/features/kanban/server/prisma-move-repository", () => ({ PrismaMoveRepository: class {} }));
vi.mock("@/features/kanban/server/move-task-service", () => ({ moveTask: mocks.move }));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: mocks.emit }));
vi.mock("@/lib/automation-processor", () => ({ processMoveAutomation: mocks.automation }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn() } }));
import { POST } from "./route";

describe("move route rejection contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a typed 422 without post-commit effects for an invalid route", async () => {
    // The code is deliberately passed at runtime until the shared error union is extended.
    mocks.move.mockRejectedValue(new MoveTaskError("INVALID_MOVE_ROUTE" as never));
    const response = await POST(new Request("http://localhost/api/tasks/task/move", {
      method: "POST",
      body: JSON.stringify({ toColumnId: "done", beforeTaskId: null, afterTaskId: null, expectedVersion: 2, operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11" }),
    }), { params: Promise.resolve({ id: "task" }) });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_MOVE_ROUTE", message: expect.any(String) } });
    expect(mocks.automation).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
