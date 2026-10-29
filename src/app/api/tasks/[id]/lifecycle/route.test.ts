import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  auth: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: runtime.auth,
  UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError,
}));
vi.mock("@/features/kanban/server/task-lifecycle-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/kanban/server/task-lifecycle-service")>();
  return {
    ...actual,
    createTaskLifecycleService: () => ({ snapshot: runtime.snapshot }),
  };
});

import { GET } from "./route";
import { NotFoundError, UnauthorizedError } from "@/lib/errors";
import { TaskLifecycleError } from "@/features/kanban/server/task-lifecycle-service";

const snapshot = {
  taskId: "task",
  projectId: "project",
  version: 4,
  marked: true,
  deleted: false,
  state: "SUBMITTED",
  authorId: "author",
  executorId: null,
  executorName: null,
  permissions: {
    isAuthor: true,
    isExecutor: false,
    isLeader: false,
    isGroupMember: false,
    canParticipate: true,
    canExecute: false,
    canAssign: false,
  },
  assignees: null,
  attachments: [],
};

function invoke() {
  return GET(
    new Request("https://app.test/api/tasks/task/lifecycle"),
    { params: Promise.resolve({ id: "task" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.auth.mockResolvedValue({ id: "author", globalRole: "USER" });
  runtime.snapshot.mockResolvedValue(snapshot);
});

describe("GET /api/tasks/[id]/lifecycle", () => {
  it("returns the actor-bound projection with no-store", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: snapshot });
    expect(runtime.snapshot).toHaveBeenCalledWith({ actorId: "author", taskId: "task" });
  });

  it.each([
    [new UnauthorizedError(), 401],
    [new NotFoundError(), 404],
    [new TaskLifecycleError("INVALID_REQUEST_MARKER"), 409],
    [new TaskLifecycleError("NOT_A_REQUEST"), 404],
    [new TaskLifecycleError("FORBIDDEN_ROLE"), 403],
    [new Error("synthetic-private"), 500],
  ])("maps %s to %i without leaking the reason", async (error, status) => {
    runtime.snapshot.mockRejectedValue(error);
    const response = await invoke();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("synthetic-private");
  });
});
