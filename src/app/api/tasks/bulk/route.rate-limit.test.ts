import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ auth: vi.fn(), session: vi.fn(), query: vi.fn(), read: vi.fn(), transaction: vi.fn(), updated: vi.fn(), moved: vi.fn(), automation: vi.fn(), method: "PATCH" }));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: api.query, task: { findMany: api.read }, $transaction: api.transaction } }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: api.auth }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: async () => ({}) }));
vi.mock("next-auth", () => ({ getServerSession: api.session })); vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: api.updated, emitTaskMoved: api.moved }));
vi.mock("@/lib/automation-processor", () => ({ processBulkMoveAutomation: api.automation }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), warn: vi.fn() } }));
import { PATCH } from "./route";
import { POST } from "../bulk-update/route";
import { UnauthorizedError, ForbiddenError } from "@/lib/errors";
const id = "cm0000000000000000000001", row = { id, projectId: "project", columnId: "todo", priority: "LOW", version: 2, project: { id: "project", ownerId: "actor", members: [] } };
const body = { taskIds: [id], updates: { priority: "HIGH" } };
let counts: Map<string, number>;
function invoke(method = "PATCH", value: unknown = body) { api.method = method; const request = new Request("http://localhost/api/tasks/bulk", { method, headers: { "content-type": "application/json", "x-user-id": "forged" }, body: JSON.stringify(value) }); return method === "PATCH" ? PATCH(request) : POST(request as never); }
beforeEach(() => {
  vi.resetAllMocks(); counts = new Map(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); api.session.mockResolvedValue({ user: { id: "actor" } });
  api.query.mockImplementation(async (_sql, key: string, ...values: unknown[]) => { const limit = Number(values.at(-1)), count = counts.get(key) ?? 0; if (count >= limit) return []; counts.set(key, count + 1); return [{ count: count + 1 }]; });
  api.read.mockResolvedValue([row]); api.transaction.mockImplementation(async () => api.method === "PATCH" ? { tasks: [row], moves: [] } : []);
});
function noDataOrEffects() { expect(api.read).not.toHaveBeenCalled(); expect(api.transaction).not.toHaveBeenCalled(); expect(api.updated).not.toHaveBeenCalled(); expect(api.moved).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled(); }
it.each(["USER", "ADMIN"])("shares20 admissions across PATCH and existing bulk POST,21st is429 (%s)", async role => {
  api.auth.mockResolvedValue({ id: "actor", globalRole: role });
  for (let index = 0; index < 20; index++) expect((await invoke(index % 2 ? "POST" : "PATCH")).status).toBe(200);
  const reads = api.read.mock.calls.length; const response = await invoke(); expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: "RateLimited", retryAfter: 60 }); expect(response.headers.get("Retry-After")).toBe("60");
  expect(api.read).toHaveBeenCalledTimes(reads); expect(api.transaction).toHaveBeenCalledTimes(20); expect(counts.get("tasks:bulk:actor")).toBe(20);
  api.auth.mockResolvedValue({ id: "second", globalRole: "ADMIN" }); expect((await invoke()).status).toBe(200); expect(counts.get("tasks:bulk:second")).toBe(1);
});
it("uses actor key once per request, including identical batches, before task query", async () => {
  expect((await invoke()).status).toBe(200); expect((await invoke()).status).toBe(200); expect(counts.get("tasks:bulk:actor")).toBe(2); expect(api.query.mock.calls[0][1]).toBe("tasks:bulk:actor"); expect(api.query.mock.invocationCallOrder[0]).toBeLessThan(api.read.mock.invocationCallOrder[0]);
});
it("does not look up tasks or run a transaction/effect when quota is exhausted", async () => {
  api.query.mockResolvedValue([]); expect((await invoke()).status).toBe(429); noDataOrEffects();
});
it("fails quota storage closed as safe500 with zero reads/mutations/effects", async () => {
  api.query.mockRejectedValue(new Error("synthetic-private-store synthetic-token")); const response = await invoke(); expect(response.status).toBe(500); expect(response.headers.has("Retry-After")).toBe(false); expect(await response.text()).not.toMatch(/synthetic-private|synthetic-token/); noDataOrEffects();
});
it.each([new UnauthorizedError(), new ForbiddenError()])("does not charge failed authentication", async error => {
  api.auth.mockRejectedValue(error); expect((await invoke()).status).toBe(error instanceof UnauthorizedError ? 401 : 403); expect(api.query).not.toHaveBeenCalled(); noDataOrEffects();
});
it("keeps existing status-only422 ahead of quota", async () => {
  expect((await invoke("PATCH", { taskIds: [id], updates: { status: "DONE" } })).status).toBe(422); expect(api.query).not.toHaveBeenCalled(); noDataOrEffects();
});
