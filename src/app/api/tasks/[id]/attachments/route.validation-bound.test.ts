import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), transaction: vi.fn(), emit: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findFirst: api.read }, $transaction: api.transaction } }));
vi.mock("@/lib/require-api-user", async original => ({ ...await original<typeof import("@/lib/require-api-user")>(), requireApiUser: api.auth }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: api.emit }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: api.load }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn() } }));
import { PATCH } from "./route";
import { UnauthorizedError } from "@/lib/errors";
import { MAX_TASK_ATTACHMENTS } from "@/lib/attachments/append";
const invoke = (request: Request) => PATCH(request, { params: Promise.resolve({ id: "task" }) });
function request(attachments: unknown[]) { return new Request("http://localhost/api/tasks/task/attachments", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachments }),
}); }
beforeEach(() => { vi.resetAllMocks(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); api.read.mockResolvedValue(null); });
function noBusinessWork() { expect(api.read).not.toHaveBeenCalled(); expect(api.transaction).not.toHaveBeenCalled(); expect(api.emit).not.toHaveBeenCalled(); expect(api.load).not.toHaveBeenCalled(); }
it("rejects101 small invalid entries with one existing-quota bound issue before business work", async () => {
  const response = await invoke(request(Array(MAX_TASK_ATTACHMENTS + 1).fill(null)));
  expect(response.status).toBe(422); const body = await response.json();
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(body.error.details).toEqual([{ path: "attachments", message: "Не более 100 вложений у задачи" }]); noBusinessWork();
});
it("does not read or parse an unauthenticated request body", async () => {
  api.auth.mockRejectedValue(new UnauthorizedError()); const req = request([]); const readBody = vi.spyOn(req, "json");
  expect((await invoke(req)).status).toBe(401); expect(readBody).not.toHaveBeenCalled(); noBusinessWork();
});
it("keeps authenticated malformedJSON at400 before task work", async () => {
  const req = new Request("http://localhost/api/tasks/task/attachments", { method: "PATCH", body: "{" });
  const response = await invoke(req); expect(response.status).toBe(400); expect(api.auth).toHaveBeenCalledOnce(); noBusinessWork();
});
it("retains the normal actor-scoped read policy for100 valid legacy metadata entries", async () => {
  const attachments = Array.from({ length: MAX_TASK_ATTACHMENTS }, (_, i) => ({ url: `https://example.invalid/file-${i}`, name: "Synthetic", size: 1, mime: "text/plain" }));
  expect((await invoke(request(attachments))).status).toBe(404);
  expect(api.read).toHaveBeenCalledExactlyOnceWith({ where: { id: "task", project: {
    OR: [{ ownerId: "actor" }, { members: { some: { userId: "actor" } } }],
  } }, select: { id: true, projectId: true } });
  expect(api.transaction).not.toHaveBeenCalled(); expect(api.emit).not.toHaveBeenCalled();
});
