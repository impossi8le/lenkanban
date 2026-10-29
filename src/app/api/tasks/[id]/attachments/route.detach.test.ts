import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ detach: vi.fn(), auth: vi.fn(), rate: vi.fn(), load: vi.fn(), emit: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/attachments/detach-command", async original => ({ ...await original<typeof import("@/lib/attachments/detach-command")>(), detachTaskAttachment: api.detach }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: api.auth, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: api.rate, rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: api.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: api.emit }));
import { DELETE } from "./route";
import { AttachmentInMessageError } from "@/lib/attachments/detach-command";
import { TaskCommandError } from "@/lib/task-command";
import { NotFoundError } from "@/lib/errors";
afterEach(() => vi.unstubAllEnvs());
const body = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 7, url: "/private-file" };
const send = (value: unknown = body, origin = "https://app.test") => DELETE(new Request("https://app.test/api/tasks/task/attachments", { method: "DELETE", headers: { origin }, body: JSON.stringify(value) }), { params: Promise.resolve({ id: "task" }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); api.rate.mockResolvedValue(undefined);
  api.detach.mockResolvedValue({ taskId: "task", projectId: "project", version: 8, changed: true, replayed: false }); api.load.mockResolvedValue({ id: "task", project: { id: "project" } });
});
it("uses the authenticated actor, safe origin, shared rate bucket and publishes a committed ACK", async () => {
  const response = await send(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(api.detach).toHaveBeenCalledWith({}, { ...body, actorId: "actor", taskId: "task" }); expect(api.rate).toHaveBeenCalledWith("tasks:update", "actor"); expect(api.emit).toHaveBeenCalledOnce();
});
it("does not publish effects again for an exact replay", async () => { api.detach.mockResolvedValue({ taskId: "task", projectId: "project", version: 8, changed: true, replayed: true }); expect((await send()).status).toBe(200); expect(api.emit).not.toHaveBeenCalled(); });
it("denies a foreign origin or exceeded quota before invoking the command", async () => {
  expect((await send(body, "https://foreign.invalid")).status).toBe(403); api.rate.mockRejectedValueOnce(Error("limited")); expect((await send()).status).toBe(429); expect(api.detach).not.toHaveBeenCalled();
});
it("rejects unversioned replacement lists without weakening legacy PATCH", async () => { expect((await send({ attachments: [] })).status).toBe(422); expect(api.detach).not.toHaveBeenCalled(); });
it("explains immutable message attachments without revealing raw metadata", async () => { api.detach.mockRejectedValue(new AttachmentInMessageError()); const response = await send(); expect(response.status).toBe(422); const value = await response.json(); expect(value.error.code).toBe("ATTACHMENT_IN_MESSAGE"); expect(value.error.message).toContain("остаётся частью переписки"); expect(JSON.stringify(value)).not.toContain("private-file"); });
it.each([new NotFoundError(), new TaskCommandError("STALE_TASK_VERSION")])("keeps refused writes free of effects %j", async error => { api.detach.mockRejectedValue(error); expect((await send()).status).toBe(error instanceof NotFoundError ? 404 : 409); expect(api.emit).not.toHaveBeenCalled(); });
it("retains a committed result when realtime fails and hides an unknown storage error", async () => {
  api.emit.mockRejectedValueOnce(Error("secret")); expect((await send()).status).toBe(200);
  api.detach.mockRejectedValueOnce(Error("raw-private-storage")); const response = await send(); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("raw-private-storage");
});
