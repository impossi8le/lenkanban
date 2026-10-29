import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { executeAutomationMutations, automationActionOperationId } from "./automation-mutation-phase";
import type { AutomationAction } from "./automation-actions";
import { createBase36RankService, formatRank } from "@/features/kanban/rank/rank-service";

type Row = Record<string, unknown>;
function fixture() {
  const task = { id: "task", projectId: "project", columnId: "source", version: 3,
    title: "Synthetic task", description: null, deadline: null, priority: "MEDIUM",
    status: "TODO", rank: formatRank(100n), position: 1024 };
  const sibling = { ...task, id: "sibling", columnId: "destination", rank: formatRank(200n) };
  const project = { id: "project", ownerId: "actor", members: [] as { role: string }[], boardRevision: 9,
    // Status changes require responsible-group membership (docs/REQUEST_LIFECYCLE.md).
    responsibleGroup: { archivedAt: null as Date | null, members: [{ userId: "actor" }] } };
  const columns = [{ id: "source", projectId: "project", name: "Source", workflowKey: "TODO", position: 10 },
    { id: "destination", projectId: "project", name: "Destination", workflowKey: "DONE", position: 30 }];
  const activities: Row[] = [], scalarReceipts: Row[] = [], moveReceipts: Row[] = [];
  let assigned = ["existing"];
  const people = ["existing", "eligible"].map(id => ({ id, name: `Name ${id}`, email: `${id}@example.test` }));
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "ProjectColumn"')) return columns.filter(column => values.includes(column.id));
      if (sql.includes('FROM "Project"') && sql.includes('"ResponsibleGroupMember"')) return [{ id: "group", userId: "actor" }];
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) {
        if (sql.includes('"priority"')) return [{ id: task.id, projectId: task.projectId, priority: task.priority, version: task.version }];
        return [{ id: task.id, projectId: task.projectId, columnId: task.columnId }];
      }
      return [{ id: "actor" }];
    }),
    task: {
      findUnique: vi.fn(async () => ({ ...task })),
      findUniqueOrThrow: vi.fn(async () => ({ ...task })),
      findFirst: vi.fn(async ({ where }: { where: { columnId: string } }) => sibling.columnId === where.columnId ? { id: sibling.id } : null),
      findMany: vi.fn(async ({ where }: { where: { columnId: string } }) => [task, sibling].filter(row => row.columnId === where.columnId).map(row => ({ ...row }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = where.id === task.id ? task : sibling; Object.assign(row, data); return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { version: number }; data: Row & { version: { increment: number } } }) => {
        if (where.version !== task.version) return { count: 0 };
        const { version, ...changes } = data; Object.assign(task, changes); task.version += version.increment; return { count: 1 };
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "actor", globalRole: "USER" })),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => people.filter(person => where.id.in.includes(person.id))),
    },
    project: {
      findUnique: vi.fn(async () => project),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ boardRevision: ++project.boardRevision })),
    },
    projectColumn: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => columns.find(column => column.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; position: { lt: number } } }) =>
        columns.filter(column => column.projectId === where.projectId && column.position < where.position.lt)
          .sort((a, b) => b.position - a.position)[0] ?? null),
    },
    projectMember: { findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => people.filter(person => where.userId.in.includes(person.id)).map(person => ({ userId: person.id }))) },
    taskRequest: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    taskAssignee: {
      findMany: vi.fn(async () => assigned.map(userId => ({ userId, user: people.find(person => person.id === userId)! }))),
      deleteMany: vi.fn(async () => { assigned = []; }),
      createMany: vi.fn(async ({ data }: { data: { userId: string }[] }) => { assigned = data.map(row => row.userId); }),
    },
    activity: { create: vi.fn(async ({ data }: { data: Row }) => { activities.push(structuredClone(data)); return data; }) },
    taskCommandOperation: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Row }) => { scalarReceipts.push(structuredClone(data)); return data; }),
    },
    taskMoveOperation: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Row }) => { moveReceipts.push(structuredClone(data)); return data; }),
    },
  };
  const run = (actions: AutomationAction[]) => executeAutomationMutations({ tx: tx as unknown as Prisma.TransactionClient,
    actions, ruleKey: "rule:event-operation", event: { trigger: "task_created", taskId: "task", projectId: "project", userId: "actor" } });
  return { task, sibling, project, activities, scalarReceipts, moveReceipts, tx, run, assignees: () => assigned };
}

describe("automation mutation phase using real shared services and Prisma repository (in-memory client)", () => {
  it("changes priority through scalar CAS, version, Activity and command receipt", async () => {
    const f = fixture(); const effects = await f.run([{ type: "change_priority", params: { priority: "HIGH" } }]);
    const operationId = automationActionOperationId("rule:event-operation", 0);
    expect(f.task).toMatchObject({ priority: "HIGH", version: 4, columnId: "source", rank: formatRank(100n), position: 1024 });
    expect(f.tx.task.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: "task", projectId: "project", columnId: "source", version: 3 }, data: { priority: "HIGH", version: { increment: 1 } } });
    expect(f.activities).toEqual([{ taskId: "task", userId: "actor", action: "priority_changed", oldValue: { priority: "MEDIUM" }, newValue: { priority: "HIGH" } }]);
    expect(f.scalarReceipts).toEqual([{ actorId: "actor", operationId, taskId: "task", projectId: "project", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), expectedVersion: 3, committedVersion: 4, changed: true }]);
    expect(effects).toEqual({ updated: true, moves: [], events: [{ trigger: "priority_changed", taskId: "task", projectId: "project", userId: "actor", operationId, origin: "automation", oldValue: "MEDIUM", newValue: "HIGH" }] });
  });

  it("moves after the final sibling through canonical rank/position, version, board revision, Activity and receipt", async () => {
    const f = fixture(); const effects = await f.run([{ type: "move_to_column", params: { columnId: "destination" } }]);
    const operationId = automationActionOperationId("rule:event-operation", 0);
    const rank = createBase36RankService().between(f.sibling.rank, null);
    expect(f.task).toMatchObject({ columnId: "destination", status: "DONE", version: 4, rank, position: 2048 });
    expect(f.sibling).toMatchObject({ columnId: "destination", rank: formatRank(200n), position: 1024, version: 3 });
    expect(f.project.boardRevision).toBe(10);
    expect(f.activities).toEqual([{ taskId: "task", userId: "actor", action: "moved", oldValue: { columnId: "source", columnName: "Source", status: "TODO" }, newValue: { columnId: "destination", columnName: "Destination", status: "DONE" } }]);
    const response = { operationId, boardRevision: 10, task: { id: "task", columnId: "destination", version: 4, status: "DONE" } };
    expect(f.moveReceipts).toEqual([{ operationId, taskId: "task", projectId: "project", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), response }]);
    expect(effects.moves).toEqual([response]);
    expect(effects.events).toEqual([{ trigger: "status_changed", taskId: "task", projectId: "project", userId: "actor", operationId, origin: "automation", oldValue: "TODO", newValue: "DONE" }]);
  });

  it("adds an eligible assignee through shared guard and Activity preserving legacy version", async () => {
    const f = fixture(); const effects = await f.run([{ type: "assign_user", params: { userId: "eligible" } }]);
    expect(f.assignees()).toEqual(["existing", "eligible"]);
    expect(f.task.version).toBe(3);
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.activities).toEqual([{ taskId: "task", userId: "actor", action: "assigned", newValue: { assigneeId: "eligible", assigneeName: "Name eligible" } }]);
    expect(f.tx.projectMember.findMany).toHaveBeenCalledExactlyOnceWith({ where: { projectId: "project", userId: { in: ["existing", "eligible"] } } });
    expect(effects.updated).toBe(true);
    expect(effects.events).toEqual([{ trigger: "assignee_added", taskId: "task", projectId: "project", userId: "actor", operationId: automationActionOperationId("rule:event-operation", 0), origin: "automation", oldValue: undefined, newValue: "eligible" }]);
  });

  it("rejects an ineligible target before child writes or Activity", async () => {
    const f = fixture();
    await expect(f.run([{ type: "assign_user", params: { userId: "outsider" } }])).rejects.toMatchObject({ name: "BadRequestError" });
    expect(f.assignees()).toEqual(["existing"]);
    expect(f.tx.taskAssignee.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.taskAssignee.createMany).not.toHaveBeenCalled();
    expect(f.activities).toEqual([]);
    expect(f.task.version).toBe(3);
  });

  it.each<AutomationAction>([
    { type: "change_priority", params: { priority: "HIGH" } },
    { type: "move_to_column", params: { columnId: "destination" } },
    { type: "assign_user", params: { userId: "eligible" } },
  ])("retains fresh actor project authorization for $type", async action => {
    const f = fixture(); f.project.ownerId = "other";
    await expect(f.run([action])).rejects.toMatchObject({ name: action.type === "move_to_column" ? "MoveTaskError" : "NotFoundError" });
    expect(f.task).toMatchObject({ version: 3, priority: "MEDIUM", columnId: "source" });
    expect(f.assignees()).toEqual(["existing"]);
    expect(f.activities).toEqual([]); expect(f.scalarReceipts).toEqual([]); expect(f.moveReceipts).toEqual([]);
  });

  it("uses the fresh version for each shared command in the same rule", async () => {
    const f = fixture();
    await f.run([{ type: "change_priority", params: { priority: "URGENT" } }, { type: "move_to_column", params: { columnId: "destination" } }]);
    expect(f.task).toMatchObject({ priority: "URGENT", version: 5, columnId: "destination" });
    expect(f.scalarReceipts[0]).toMatchObject({ expectedVersion: 3, committedVersion: 4, operationId: automationActionOperationId("rule:event-operation", 0) });
    expect(f.moveReceipts[0]).toMatchObject({ operationId: automationActionOperationId("rule:event-operation", 1), response: { task: { version: 5 } } });
    expect(f.activities.map(row => row.action)).toEqual(["priority_changed", "moved"]);
  });
});
