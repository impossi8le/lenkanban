import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(), freshActor: vi.fn(), boards: vi.fn(), grants: vi.fn(),
  task: vi.fn(), broadTask: vi.fn(), project: vi.fn(), transaction: vi.fn(),
  arrivals: vi.fn(),
}));
// The fresh queue projector has its own core/ACL suites. Keep this route seam
// actor-specific; an omitted ID must still deny the earlier readable snapshot.
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: mocks.arrivals }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  project: { findMany: mocks.boards, findUnique: mocks.project },
  scopedPrivilegeAssignment: { findMany: mocks.grants },
  task: { findFirst: mocks.task, findUnique: mocks.broadTask },
  $transaction: mocks.transaction,
} }));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: mocks.actor, UnauthorizedError: (await import("./errors")).UnauthorizedError,
}));
vi.mock("@/lib/notification-triggers", () => ({}));
vi.mock("@/lib/automation-processor", () => ({}));
vi.mock("@/socket/board-events", () => ({}));
vi.mock("@/middleware/api-logger", () => ({
  withApiLogging: async (request: Request, handler: (request: Request, context: object) => Promise<Response>) => handler(request, {}),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn() }, dbLogger: { error: vi.fn() } }));
import { GET } from "@/app/api/tasks/[id]/route";
import { getTaskReadWhere } from "./project-access";

const actor = { id: "reader", globalRole: "USER" as const };
const stored = {
  id: "task", title: "Synthetic task", description: "Synthetic details", projectId: "board",
  project: { name: "Board" }, columnId: "column", status: "TODO", priority: "LOW", position: 1,
  version: 1, createdById: actor.id, deadline: null, createdAt: new Date(0), updatedAt: new Date(0),
  attachments: [], assignees: [], tags: [], checklistItems: [], request: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(actor);
  mocks.freshActor.mockResolvedValue(actor);
  mocks.boards.mockResolvedValue([{ id: "board" }]);
  mocks.grants.mockResolvedValue([]);
  mocks.task.mockResolvedValue(stored);
  mocks.arrivals.mockImplementation(async (_database, actorId, ids: string[]) =>
    new Map(actorId === actor.id && ids.length === 1 && ids[0] === stored.id
      ? [[stored.id, null]] : []));
  // These broad queries would leak a foreign task if either fallback returned.
  mocks.broadTask.mockResolvedValue(stored);
  mocks.project.mockResolvedValue({ id: "board", ownerId: actor.id, members: [{ role: "PROJECT_ADMIN" }] });
  mocks.transaction.mockImplementation(async operation => operation({
    user: { findUnique: mocks.freshActor },
    project: { findMany: mocks.boards, findUnique: mocks.project },
    scopedPrivilegeAssignment: { findMany: mocks.grants },
    task: { findFirst: mocks.task, findUnique: mocks.broadTask },
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["", "board", "unrelated", "*"])("mandatory task GET policy with config %j (mock database)", config => {
  it.each(["", "?view=details"])("always applies the shared task predicate for %j", async query => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", config);
    const expected = await getTaskReadWhere(actor, { id: "task" });
    const response = await GET(new Request(`http://localhost/api/tasks/task${query}`), { params: Promise.resolve({ id: "task" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: "task", title: stored.title, projectId: "board", queueArrival: null });
    expect(mocks.task).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: expected }));
    expect(mocks.arrivals).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ task: expect.objectContaining({ findFirst: mocks.task }) }),
      actor.id, [stored.id]);
    expect(mocks.broadTask).not.toHaveBeenCalled();
    expect(mocks.project).not.toHaveBeenCalled();
    if (query) expect(mocks.freshActor.mock.invocationCallOrder[0]).toBeLessThan(mocks.task.mock.invocationCallOrder[0]);
  });

  it.each(["", "?view=details"])("keeps a denied task hidden despite broad project access for %j", async query => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", config);
    mocks.task.mockResolvedValue(null);
    const response = await GET(new Request(`http://localhost/api/tasks/task${query}`), { params: Promise.resolve({ id: "task" }) });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(stored.title);
    expect(mocks.broadTask).not.toHaveBeenCalled();
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.arrivals).not.toHaveBeenCalled();
  });
});

it.each(["", "?view=details"])("does not restore a readable snapshot omitted by the fresh actor projection for %j", async query => {
  mocks.arrivals.mockResolvedValue(new Map());
  const response = await GET(new Request(`http://localhost/api/tasks/task${query}`), { params: Promise.resolve({ id: "task" }) });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain(stored.title);
  expect(mocks.arrivals).toHaveBeenCalledOnce();
  expect(mocks.broadTask).not.toHaveBeenCalled();
  expect(mocks.project).not.toHaveBeenCalled();
});
