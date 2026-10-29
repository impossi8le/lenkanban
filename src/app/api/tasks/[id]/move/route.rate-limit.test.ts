import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), read: vi.fn(), repository: vi.fn(), move: vi.fn(), emit: vi.fn(), automation: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: api.query, task: { findUnique: api.read } } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: api.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/project-access", () => ({ requireProjectWrite: api.access }));
vi.mock("@/features/kanban/server/prisma-move-repository", () => ({ PrismaMoveRepository: class { constructor() { api.repository(); } } }));
vi.mock("@/features/kanban/server/move-task-service", () => ({ moveTask: api.move }));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: api.emit }));
vi.mock("@/lib/automation-processor", () => ({ processMoveAutomation: api.automation }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn() } }));
import { POST } from "./route";
import { rateLimitOrThrowKey } from "@/lib/rate-limit";
import { UnauthorizedError, ForbiddenError } from "@/lib/errors";
const operationId = "b1e62929-6741-4860-a6a3-5f90b82d5a11";
const payload = { toColumnId: "doing", beforeTaskId: null, afterTaskId: null, expectedVersion: 2, operationId };
let counts: Map<string, number>;
const invoke = (body: unknown = payload) => POST(new Request("http://localhost/api/tasks/task/move", {
  method: "POST", headers: { "content-type": "application/json", "x-user-id": "forged", "x-forwarded-for": "spoofed" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "task" }) });
beforeEach(() => {
  vi.resetAllMocks(); counts = new Map(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  api.query.mockImplementation(async (_sql, key: string, ...values: unknown[]) => { const limit = Number(values.at(-1)), count = counts.get(key) ?? 0; if (count >= limit) return []; counts.set(key, count + 1); return [{ count: count + 1 }]; });
  api.read.mockResolvedValue({ projectId: "project", status: "TODO", version: 2 });
  api.move.mockResolvedValue({ operationId, boardRevision: 1, task: { id: "task", columnId: "doing", version: 3, status: "IN_PROGRESS" } });
  api.emit.mockResolvedValue(undefined); api.automation.mockResolvedValue(undefined);
});
function noDataOrEffects() { expect(api.read).not.toHaveBeenCalled(); expect(api.access).not.toHaveBeenCalled(); expect(api.repository).not.toHaveBeenCalled(); expect(api.move).not.toHaveBeenCalled(); expect(api.emit).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled(); }
it.each(["USER", "ADMIN"])("shares 120 actor admissions with scalar updates and rejects121 before repository (%s)", async role => {
  api.auth.mockResolvedValue({ id: "actor", globalRole: role });
  await rateLimitOrThrowKey("tasks:update", "actor"); // Existing canonical/scalar family uses this same rule/key.
  for (let index = 0; index < 119; index++) expect((await invoke()).status).toBe(200);
  const response = await invoke(); expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: "RateLimited", retryAfter: 60 }); expect(response.headers.get("Retry-After")).toBe("60");
  expect(api.move).toHaveBeenCalledTimes(119); expect(api.repository).toHaveBeenCalledTimes(119); expect(api.emit).toHaveBeenCalledTimes(119); expect(counts.get("tasks:update:actor")).toBe(120);
  api.auth.mockResolvedValue({ id: "second", globalRole: "USER" }); expect((await invoke()).status).toBe(200); expect(counts.get("tasks:update:second")).toBe(1);
});
it("charges a repeated operation before task/repository/receipt dispatch", async () => {
  expect((await invoke()).status).toBe(200); expect((await invoke()).status).toBe(200);
  expect(counts.get("tasks:update:actor")).toBe(2); expect(api.query.mock.calls[0][1]).toBe("tasks:update:actor");
  expect(api.query.mock.invocationCallOrder[0]).toBeLessThan(api.read.mock.invocationCallOrder[0]); expect(api.query.mock.invocationCallOrder[1]).toBeLessThan(api.repository.mock.invocationCallOrder[1]);
});
it("blocks exhausted admission before lookup or any effects", async () => {
  api.query.mockResolvedValue([]); const response = await invoke(); expect(response.status).toBe(429); noDataOrEffects();
});
it("fails store outages closed with safe500, never429 or data/effects", async () => {
  api.query.mockRejectedValue(new Error("synthetic-private-store synthetic-token")); const response = await invoke(); expect(response.status).toBe(500); expect(response.headers.has("Retry-After")).toBe(false); expect(await response.text()).not.toMatch(/synthetic-private|synthetic-token/); noDataOrEffects();
});
it.each([new UnauthorizedError(), new ForbiddenError()])("does not charge an unauthenticated/blocked admission", async error => {
  api.auth.mockRejectedValue(error); expect((await invoke()).status).toBe(error instanceof UnauthorizedError ? 401 : 403); expect(api.query).not.toHaveBeenCalled(); noDataOrEffects();
});
it("retains invalid-payload422 before quota or mutation", async () => {
  expect((await invoke({ ...payload, expectedVersion: -1 })).status).toBe(422); expect(api.query).not.toHaveBeenCalled(); noDataOrEffects();
});
