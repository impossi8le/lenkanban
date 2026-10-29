import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  transaction: vi.fn(), project: vi.fn(), column: vi.fn(), auth: vi.fn(),
  emit: vi.fn(), automation: vi.fn(), diagnostic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: api.transaction,
  project: { findFirst: api.project, findUnique: async () => ({ownerId: "author", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{id: columnId}]}) },
  projectColumn: { findFirst: api.column },
} }));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: api.auth,
  UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError,
}));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: api.emit }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: api.automation }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: api.diagnostic, error: api.diagnostic } }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response("{}", { status: 429 }),
}));
vi.mock("@/features/kanban/server/task-creation-port", () => ({
  prepareLegacyTaskCreation: async () => ({
    column: { id: "cm0000000000000000000002", workflowKey: "TODO" },
    rank: "0|HZZZZZZZZZZZZZZZZZZZ",
  }),
}));

import { POST } from "./route";

const projectId = "cm0000000000000000000001";
const columnId = "cm0000000000000000000002";

function fixture() {
  const created: Record<string, unknown>[] = [];
  const markers: Record<string, unknown>[] = [];
  const trace: string[] = [];
  let committed = false;
  const options = { markerFailure: false };

  const tx = {
    project: { findUnique: vi.fn(async () => api.project()) },
    activity: { create: vi.fn() },
    task: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        trace.push("task");
        const row = {
          id: "cm0000000000000000000003",
          ...data,
          version: 0,
          rank: "0|HZZZZZZZZZZZZZZZZZZZ",
          createdAt: new Date("2026-10-22T10:00:00Z"),
          assignees: [],
          tags: [],
          _count: { messages: 0 },
        };
        created.push(row);
        return row;
      }),
    },
    taskRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        trace.push("marker");
        if (options.markerFailure) throw new Error("synthetic-private-marker");
        markers.push(data);
        return data;
      }),
    },
  };

  api.transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => {
    const result = await callback(tx);
    committed = true;
    trace.push("commit");
    return result;
  });
  api.emit.mockImplementation(() => { expect(committed).toBe(true); trace.push("emit"); });
  api.automation.mockImplementation(async () => { expect(committed).toBe(true); trace.push("automation"); });

  const run = (body: Record<string, unknown> = { projectId, title: "Synthetic request" }) =>
    POST(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

  return { tx, created, markers, trace, options, run };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.auth.mockResolvedValue({ id: "author", globalRole: "USER" });
  api.project.mockResolvedValue({ id: projectId });
  api.column.mockResolvedValue({ id: columnId, workflowKey: "TODO" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/tasks marked draft creation", () => {
  it("uses common creation policy without an extra owner/member-only discovery gate", async () => {
    const f = fixture();
    expect((await f.run()).status).toBe(201);
    expect(api.project).toHaveBeenCalledWith({ where: { id: projectId }, select: { id: true } });
  });

  it("creates structured drafts when all lifecycle targets belong to this board", async () => {
    const lifecycleColumnMap = { contractVersion: 1, submittedColumnId: columnId, inProgressColumnId: "work", needsInfoColumnId: "info", completedColumnId: "review", closedColumnId: "done" };
    api.project.mockResolvedValue({ id: projectId, lifecycleColumnMap, columns: [
      { id: columnId, projectId, workflowKey: "TODO" },
      { id: "work", projectId, workflowKey: "IN_PROGRESS" },
      { id: "info", projectId, workflowKey: "NEEDS_INFO" },
      { id: "review", projectId, workflowKey: "REVIEW" },
      { id: "done", projectId, workflowKey: "DONE" },
    ] });
    const f = fixture();
    expect((await f.run({ projectId, title: "Synthetic request", audience: { mode: "DEPARTMENT", userIds: [] }, requestDetails: { kind: "it", category: "Computer" } })).status).toBe(201);
    expect(f.markers).toHaveLength(1);
    expect(f.markers[0].state).toBe("DRAFT");
  });

  it("rejects structured creation before writing a draft when lifecycle columns are missing", async () => {
    const f = fixture();
    const response = await f.run({ projectId, title: "Synthetic request", audience: { mode: "DEPARTMENT", userIds: [] }, requestDetails: { kind: "it", category: "Computer" } });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("LIFECYCLE_COLUMNS_REQUIRED");
    expect(api.transaction).not.toHaveBeenCalled();
    expect(f.tx.task.create).not.toHaveBeenCalled();
  });

  it("rejects malformed lifecycle configuration before writing a structured draft", async () => {
    api.project.mockResolvedValue({ id: projectId, lifecycleColumnMap: { contractVersion: 1 } });
    const f = fixture();
    const response = await f.run({ projectId, title: "Synthetic request", audience: { mode: "DEPARTMENT", userIds: [] }, requestDetails: { kind: "it", category: "Computer" } });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("INVALID_LIFECYCLE_COLUMNS");
    expect(api.transaction).not.toHaveBeenCalled();
  });

  it("creates the task and its DRAFT marker in one committed transaction", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", projectId);
    const f = fixture();
    const response = await f.run();

    expect(response.status).toBe(201);
    expect(f.trace).toEqual(["task", "marker", "commit", "emit", "automation"]);
    expect(f.markers).toEqual([{
      taskId: "cm0000000000000000000003",
      contractVersion: 1,
      state: "DRAFT",
      authorId: "author", audienceUserIds: [],
    }]);
    expect(f.markers[0]).not.toHaveProperty("executorId");
    // The committed response never exposes the marker projection.
    expect(JSON.stringify(await response.json())).not.toMatch(/contractVersion|authorId|DRAFT/);
  });

  it("keeps legacy creation untouched on a board outside the allowlist", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "another-board");
    const f = fixture();
    expect((await f.run()).status).toBe(201);
    expect(f.tx.taskRequest.create).not.toHaveBeenCalled();
    expect(f.markers).toEqual([]);
  });

  it("binds the marker author to the server actor, never to client fields", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", projectId);
    const f = fixture();
    for (const field of ["authorId", "executorId", "createdById", "request", "assigneeId"]) {
      const response = await f.run({
        projectId,
        title: "Synthetic request",
        [field]: "synthetic-private-value",
      });
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain("synthetic-private-value");
    }
    expect(api.transaction).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.create).not.toHaveBeenCalled();
  });

  it("rolls back the task when the marker cannot be written", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", projectId);
    const f = fixture();
    f.options.markerFailure = true;
    const response = await f.run();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-private");
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(f.tx.taskRequest.create).toHaveBeenCalledOnce();
    expect(api.emit).not.toHaveBeenCalled();
    expect(api.automation).not.toHaveBeenCalled();
  });

  it("rejects a foreign project before any transaction even on a marked board", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", projectId);
    const f = fixture();
    api.project.mockResolvedValue(null);
    const response = await f.run();
    expect(response.status).toBe(404);
    expect(api.transaction).not.toHaveBeenCalled();
    expect(f.tx.task.create).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.create).not.toHaveBeenCalled();
  });
});
