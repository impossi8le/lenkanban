import { beforeEach, describe, expect, it, vi } from "vitest";

type Activity = { taskId: string; userId: string; action: string; oldValue?: unknown; newValue?: unknown };
type Item = { id: string; taskId: string; text: string; completed: boolean; position: number };
type State = { task: Record<string, unknown>; assignees: string[]; items: Item[]; activities: Activity[] };
const fake = vi.hoisted(() => {
  const runtime = { state: {} as State, failActivity: false, authenticated: true, allowed: true };
  const people = [{ id: "old", name: "Old Assignee", email: "old@example.test" }, { id: "new", name: "New Assignee", email: "new@example.test" }];
  function client(state: () => State) {
    return {
      $queryRaw: async (query: TemplateStringsArray) => {
        const sql = query.join("?");
        if (sql.includes('FROM "Task"')) return [{ id: state().task.id, projectId: state().task.projectId,
          ...(sql.includes('"priority"') ? { priority: state().task.priority, version: state().task.version } : {}) }];
        return [{ id: sql.includes('FROM "Project"') ? state().task.projectId : "locked" }];
      },
      taskRequest: { findUnique: async () => null, findMany: async () => [] },
      task: {
        findFirst: async () => runtime.allowed ? structuredClone(state().task) : null,
        findUnique: async () => runtime.allowed ? structuredClone(state().task) : null,
        findUniqueOrThrow: async () => structuredClone(state().task),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(state().task, data); return structuredClone(state().task);
        },
      },
      projectMember: {
        findFirst: async () => runtime.allowed ? { userId: "actor" } : null,
        findMany: async () => people.map(person => ({ userId: person.id })),
      },
      project: {
        findFirst: async () => null,
        findUnique: async () => runtime.allowed ? { id: "project", ownerId: "actor", members: [] } : null,
      },
      user: {
        findUnique: async () => ({ id: "actor", globalRole: "ADMIN" }),
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => people.filter(person => where.id.in.includes(person.id)),
      },
      taskAssignee: {
        findMany: async () => state().assignees.map(userId => ({ userId, user: people.find(person => person.id === userId)! })),
        deleteMany: async () => { state().assignees = []; return { count: 1 }; },
        createMany: async ({ data }: { data: { userId: string }[] }) => { state().assignees = data.map(row => row.userId); return { count: data.length }; },
      },
      taskChecklistItem: {
        findFirst: async ({ where }: { where: { id?: string; taskId: string } }) => structuredClone(state().items.find(item => (!where.id || item.id === where.id) && item.taskId === where.taskId) ?? null),
        create: async ({ data }: { data: Omit<Item, "id" | "completed"> }) => {
          const item = { ...data, id: "created-item", completed: false }; state().items.push(item); return structuredClone(item);
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Item> }) => {
          const item = state().items.find(item => item.id === where.id)!; Object.assign(item, data); return structuredClone(item);
        },
        delete: async ({ where }: { where: { id: string } }) => { state().items = state().items.filter(item => item.id !== where.id); },
      },
      activity: { create: async ({ data }: { data: Activity }) => {
        if (runtime.failActivity) throw new Error("Activity storage failed");
        state().activities.push(structuredClone(data)); return data;
      } },
    };
  }
  const prisma = {
    ...client(() => runtime.state),
    $transaction: async (operation: ((tx: ReturnType<typeof client>) => Promise<unknown>) | Promise<unknown>[]) => {
      if (Array.isArray(operation)) return Promise.all(operation);
      const working = structuredClone(runtime.state);
      const result = await operation(client(() => working));
      runtime.state = working;
      return result;
    },
  };
  return { runtime, prisma };
});
vi.mock("@/lib/prisma", () => ({ prisma: fake.prisma }));
vi.mock("@/lib/require-api-user", () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError, requireApiUser: async () => {
    if (!fake.runtime.authenticated) throw new UnauthorizedError();
    // This suite verifies privileged legacy mutation auditing and atomicity;
    // ordinary task ownership is covered by the shared access-policy suites.
    return { id: "actor", globalRole: "ADMIN", name: "Actor", email: "actor@example.test" };
  } };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => {}, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskAssigned: async () => {}, notifyTaskStatusChanged: async () => {} }));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  // The real shared event builder stays in place; only rule processing is inert.
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processAutomationRules: async () => {},
}));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: async () => null }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: () => {}, emitTaskMoved: () => {}, emitTaskDeleted: () => {} }));
vi.mock("@/lib/telemetry/store", () => ({ projectChecklistTelemetry: async () => {} }));

import { PATCH as patchTask } from "./[id]/route";
import { PUT as putAssignees } from "./[id]/assignees/route";
import { POST as createChecklist } from "./[id]/checklist/route";
import { PATCH as patchChecklist, DELETE as deleteChecklist } from "./[id]/checklist/[itemId]/route";

function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/tasks/task", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const taskContext = { params: Promise.resolve({ id: "task" }) };
const legacyContext = { params: Promise.resolve({ id: "task", itemId: "item" }) };

beforeEach(() => {
  fake.runtime.authenticated = true; fake.runtime.allowed = true; fake.runtime.failActivity = false;
  fake.runtime.state = {
    task: { id: "task", projectId: "project", columnId: "column", createdById: "actor", version: 1, title: "Before", description: "Old description", priority: "MEDIUM", status: "TODO", deadline: null, project: { id: "project", ownerId: "actor" } },
    assignees: ["old"],
    items: [{ id: "item", taskId: "task", text: "Verify report", completed: false, position: 0 }],
    activities: [],
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("task mutations commit activity with the change", () => {
  it.each([
    { patch: { title: "After" }, action: "title_changed", oldValue: { title: "Before" }, newValue: { title: "After" } },
    { patch: { description: null }, action: "description_changed", oldValue: { description: "Old description" }, newValue: { description: null } },
    { patch: { priority: "HIGH" }, action: "priority_changed", oldValue: { priority: "MEDIUM" }, newValue: { priority: "HIGH" } },
    { patch: { deadline: "2026-10-01T00:00:00.000Z" }, action: "deadline_set", oldValue: { deadline: null }, newValue: { deadline: "2026-10-01T00:00:00.000Z" } },
  ])("records $action with actor and old/new values", async ({ patch, action, oldValue, newValue }) => {
    if ("deadline" in patch) fake.runtime.state.assignees = ["actor"];
    expect((await patchTask(request("PATCH", patch), taskContext)).status).toBe(200);
    expect(fake.runtime.state.activities).toEqual([{ taskId: "task", userId: "actor", action, oldValue, newValue }]);
  });

  it("does not create duplicate activity for unchanged fields", async () => {
    fake.runtime.state.assignees = ["actor"];
    expect((await patchTask(request("PATCH", { title: "Before", priority: "MEDIUM", deadline: null }), taskContext)).status).toBe(200);
    expect(fake.runtime.state.activities).toEqual([]);
  });

  it.each([
    { deadline: null, action: "deadline_removed" },
    { deadline: "2026-10-02T00:00:00.000Z", action: "deadline_changed" },
  ])("records $action for an existing deadline", async ({ deadline, action }) => {
    fake.runtime.state.assignees = ["actor"];
    fake.runtime.state.task.deadline = new Date("2026-10-01T00:00:00.000Z");
    expect((await patchTask(request("PATCH", { deadline }), taskContext)).status).toBe(200);
    expect(fake.runtime.state.activities).toEqual([expect.objectContaining({ action, oldValue: { deadline: "2026-10-01T00:00:00.000Z" }, newValue: { deadline } })]);
  });

  it("treats equivalent deadline timestamps as unchanged", async () => {
    fake.runtime.state.assignees = ["actor"];
    fake.runtime.state.task.deadline = new Date("2026-10-01T00:00:00.000Z");
    expect((await patchTask(request("PATCH", { deadline: "2026-10-01T03:00:00+03:00" }), taskContext)).status).toBe(200);
    expect(fake.runtime.state.activities).toEqual([]);
  });

  it("rolls scalar updates back if the activity cannot be saved", async () => {
    fake.runtime.failActivity = true;
    expect((await patchTask(request("PATCH", { title: "After" }), taskContext)).status).toBe(500);
    expect(fake.runtime.state.task.title).toBe("Before");
  });

  it("records only added/removed assignees with readable names", async () => {
    expect((await putAssignees(request("PUT", { userIds: ["new"] }), legacyContext)).status).toBe(200);
    expect(fake.runtime.state.assignees).toEqual(["new"]);
    expect(fake.runtime.state.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "assigned", taskId: "task", userId: "actor", newValue: { assigneeId: "new", assigneeName: "New Assignee" } }),
      expect.objectContaining({ action: "unassigned", taskId: "task", userId: "actor", oldValue: { assigneeId: "old", assigneeName: "Old Assignee" } }),
    ]));
    expect(fake.runtime.state.activities).toHaveLength(2);
  });

  it("does not log re-submission of the same assignee set", async () => {
    expect((await putAssignees(request("PUT", { userIds: ["old"] }), legacyContext)).status).toBe(200);
    expect(fake.runtime.state.activities).toEqual([]);
  });

  it("logs checklist creation with text and identity", async () => {
    expect((await createChecklist(request("POST", { text: "New item" }), legacyContext)).status).toBe(201);
    expect(fake.runtime.state.activities).toEqual([expect.objectContaining({ action: "checklist_item_added", taskId: "task", userId: "actor", newValue: { itemId: "created-item", text: "New item", completed: false } })]);
  });

  it("logs checklist completion once", async () => {
    expect((await patchChecklist(request("PATCH", { completed: true }), legacyContext)).status).toBe(200);
    expect(fake.runtime.state.activities).toEqual([expect.objectContaining({ action: "checklist_item_completed", oldValue: { itemId: "item", text: "Verify report", completed: false }, newValue: { itemId: "item", text: "Verify report", completed: true } })]);
    await patchChecklist(request("PATCH", { completed: true }), legacyContext);
    expect(fake.runtime.state.activities).toHaveLength(1);
  });

  it("logs checklist deletion retaining its text", async () => {
    expect((await deleteChecklist(request("DELETE"), legacyContext)).status).toBe(200);
    expect(fake.runtime.state.items).toEqual([]);
    expect(fake.runtime.state.activities).toEqual([expect.objectContaining({ action: "checklist_item_deleted", oldValue: { itemId: "item", text: "Verify report", completed: false } })]);
  });

  it("logs reopening a completed checklist item", async () => {
    fake.runtime.state.items[0].completed = true;
    expect((await patchChecklist(request("PATCH", { completed: false }), legacyContext)).status).toBe(200);
    expect(fake.runtime.state.activities).toEqual([expect.objectContaining({ action: "checklist_item_reopened" })]);
  });

  it("rejects a checklist item belonging to another task without logging", async () => {
    fake.runtime.state.items[0].taskId = "other-task";
    expect((await patchChecklist(request("PATCH", { completed: true }), legacyContext)).status).toBe(404);
    expect(fake.runtime.state.activities).toEqual([]);
    expect(fake.runtime.state.items[0].completed).toBe(false);
  });

  it.each(["task", "assignee", "checklist-create", "checklist-update", "checklist-delete"])("does not mutate or audit unauthenticated %s requests", async operation => {
    fake.runtime.authenticated = false;
    const before = structuredClone(fake.runtime.state);
    const response = operation === "task" ? await patchTask(request("PATCH", { title: "After" }), taskContext)
      : operation === "assignee" ? await putAssignees(request("PUT", { userIds: ["new"] }), legacyContext)
      : operation === "checklist-create" ? await createChecklist(request("POST", { text: "New item" }), legacyContext)
      : operation === "checklist-update" ? await patchChecklist(request("PATCH", { completed: true }), legacyContext)
      : await deleteChecklist(request("DELETE"), legacyContext);
    expect(response.status).toBe(401);
    expect(fake.runtime.state).toEqual(before);
  });

  it.each(["assignee", "checklist-create", "checklist-update", "checklist-delete"])("rolls back %s when activity write fails", async operation => {
    fake.runtime.failActivity = true;
    const before = structuredClone(fake.runtime.state);
    const response = operation === "assignee" ? await putAssignees(request("PUT", { userIds: ["new"] }), legacyContext)
      : operation === "checklist-create" ? await createChecklist(request("POST", { text: "New item" }), legacyContext)
      : operation === "checklist-update" ? await patchChecklist(request("PATCH", { completed: true }), legacyContext)
      : await deleteChecklist(request("DELETE"), legacyContext);
    expect(response.status).toBe(500);
    expect(fake.runtime.state).toEqual(before);
  });
});
