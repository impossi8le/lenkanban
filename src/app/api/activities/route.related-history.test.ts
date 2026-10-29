import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ read: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findFirst: mock.read }, activity: { findMany: mock.history } } }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: async (_actor: unknown, where: unknown) => where }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: async () => ({ id: "reader", globalRole: "USER" }), UnauthorizedError: class extends Error {} }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-access", () => ({ canActorReadInternal: async () => false, loadProjectDiscussionFacts: async () => ({}), loadInternalMessageIds: async () => new Set() }));
import { GET } from "./route";
const read = () => GET(new Request("https://app.test/api/activities?taskId=a"));
function marker(id: string, overrides: Record<string, unknown> = {}) { return { taskId: id, contractVersion: 1, state: "IN_PROGRESS",
  authorId: "author", executorId: "executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null, ...overrides }; }
beforeEach(() => { vi.resetAllMocks(); mock.read.mockImplementation(async ({ where }: { where: { id: string } }) => {
  if (where.id === "hidden") return null;
  if (where.id === "deleted") return { id: where.id, projectId: "project", request: marker(where.id, { deletedAt: new Date() }) };
  if (where.id === "corrupt") return { id: where.id, projectId: "project", request: marker(where.id, { contractVersion: 999 }) };
  return { id: where.id, projectId: "project", request: null };
});
  mock.history.mockResolvedValue([{ id: "visible", action: "related_request_added", newValue: { relatedTaskId: "b" } },
    { id: "secret", action: "related_request_removed", oldValue: { relatedTaskId: "hidden" } },
    { id: "deleted-row", action: "related_request_added", newValue: { relatedTaskId: "deleted" } },
    { id: "corrupt-row", action: "related_request_added", newValue: { relatedTaskId: "corrupt" } },
    { id: "malformed", action: "related_request_added", newValue: { relatedTaskId: 8 } }, { id: "ordinary", action: "created" }]); });
it("omits the entire history row for a hidden, deleted or corrupt endpoint and malformed relation, preserving unrelated history", async () => {
  const data = (await (await read()).json()).data; expect(data.map((row: { id: string }) => row.id)).toEqual(["visible", "ordinary"]);
  expect(JSON.stringify(data)).not.toContain("hidden"); expect(JSON.stringify(data)).not.toContain("deleted"); expect(JSON.stringify(data)).not.toContain("corrupt");
});
it("rechecks endpoint revocation on every read", async () => { expect((await (await read()).json()).data).toHaveLength(2); mock.read.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === "a" ? { id: "a", projectId: "project", request: null } : null);
  expect((await (await read()).json()).data.map((row: { id: string }) => row.id)).toEqual(["ordinary"]); });
it("treats a deleted or corrupt primary task as unavailable without exposing its history", async () => {
  mock.read.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === "a" ? { id: "a", projectId: "project", request: marker("a", { deletedAt: new Date() }) } : null);
  const response = await read(); expect(response.status).toBe(403); expect(await response.text()).not.toContain("visible");
});
