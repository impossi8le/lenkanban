import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ auth: vi.fn(), session: vi.fn(), quota: vi.fn(), read: vi.fn(), transaction: vi.fn(), updated: vi.fn(), moved: vi.fn(), automation: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findMany: api.read }, $transaction: api.transaction } }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: api.auth }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: async () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: api.quota, rateLimitErrorResponse: vi.fn() }));
vi.mock("next-auth", () => ({ getServerSession: api.session }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: api.updated, emitTaskMoved: api.moved }));
vi.mock("@/lib/automation-processor", () => ({ processBulkMoveAutomation: api.automation }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), warn: vi.fn() } }));
import { PATCH } from "./route";
import { POST } from "../bulk-update/route";
import { UnauthorizedError } from "@/lib/errors";
const ids = (count: number) => Array.from({ length: count }, (_, i) => `cm${String(i).padStart(23, "0")}`);
function invoke(method: "PATCH" | "POST", taskIds: unknown[]) {
  const request = new Request("http://localhost/api/tasks/bulk", { method,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ taskIds, updates: { priority: "HIGH" } }) });
  return method === "PATCH" ? PATCH(request) : POST(request as never);
}
beforeEach(() => {
  vi.resetAllMocks(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  api.session.mockResolvedValue({ user: { id: "actor" } }); api.quota.mockResolvedValue(undefined); api.read.mockResolvedValue([]);
});
function noBusinessEffects() { expect(api.read).not.toHaveBeenCalled(); expect(api.transaction).not.toHaveBeenCalled(); expect(api.updated).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled(); }
for (const method of ["PATCH", "POST"] as const) {
  it(`${method} rejects201 small invalid elements with one bound issue before quota/business work`, async () => {
    const response = await invoke(method, Array(201).fill(null));
    expect(response.status).toBe(422);
    const body = await response.json(); expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([{ path: "taskIds", message: "Не более 200 задач за один запрос" }]);
    expect(api.quota).not.toHaveBeenCalled(); noBusinessEffects();
  });
  it(`${method} also rejects201 valid IDs before quota/business work`, async () => {
    expect((await invoke(method, ids(201))).status).toBe(422); expect(api.quota).not.toHaveBeenCalled(); noBusinessEffects();
  });
  it(`${method} admits200 syntactically valid IDs to the existing task visibility check`, async () => {
    expect((await invoke(method, ids(200))).status).toBe(404);
    expect(api.quota).toHaveBeenCalledExactlyOnceWith("tasks:bulk", "actor"); expect(api.read).toHaveBeenCalledOnce(); expect(api.transaction).not.toHaveBeenCalled();
  });
  it(`${method} still validates every element within200 and returns422`, async () => {
    const response = await invoke(method, Array(200).fill(null)); expect(response.status).toBe(422);
    const body = await response.json(); expect(body.error.details).toHaveLength(200);
    expect(body.error.details[0].path).toBe("taskIds.0"); expect(api.quota).not.toHaveBeenCalled(); noBusinessEffects();
  });
  it(`${method} preserves unauthenticated401 without actor quota at the accepted bound`, async () => {
    api.auth.mockRejectedValue(new UnauthorizedError()); api.session.mockResolvedValue(null);
    expect((await invoke(method, ids(200))).status).toBe(401); expect(api.quota).not.toHaveBeenCalled(); noBusinessEffects();
  });
  it(`${method} retains project ACL rejection for an otherwise valid small batch`, async () => {
    const [id] = ids(1); api.read.mockResolvedValue([{ id, project: { id: "project", ownerId: "other", members: [] } }]);
    expect((await invoke(method, [id])).status).toBe(method === "PATCH" ? 401 : 403);
    expect(api.transaction).not.toHaveBeenCalled(); expect(api.updated).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled();
  });
}
