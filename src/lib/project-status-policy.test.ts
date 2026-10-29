import { describe, expect, it, vi } from "vitest";
import { getProjectStatusPolicy, lockProjectStatusAuthority } from "./project-status-policy";
import { createTaskRelocationPort, prepareTaskRelocation } from "@/features/kanban/server/task-relocation";
import { PrismaMoveRepository } from "@/features/kanban/server/prisma-move-repository";
import { moveTask } from "@/features/kanban/server/move-task-service";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";

// Existing write authorization is deliberately granted: the additional guard must still deny applicants.
vi.mock("@/lib/project-access", () => ({ getProjectAccess: vi.fn(async () => ({ canWrite: true })) }));

type Group = { archivedAt: Date | null; leaderId: string | null; members: { userId: string }[] } | null;
const actor = { id: "applicant", globalRole: "USER" as const };
const member: Group = { archivedAt: null, leaderId: null, members: [{ userId: actor.id }] };
const leader: Group = { archivedAt: null, leaderId: actor.id, members: [{ userId: actor.id }] };
const revokedLeader: Group = { archivedAt: null, leaderId: actor.id, members: [] };
const outsider: Group = { archivedAt: null, leaderId: "other", members: [] };
const archived: Group = { ...member!, archivedAt: new Date() };
const task = { id: "task-1", projectId: "project-1", columnId: "todo", status: "TODO", version: 1 };
const operationId = "b1e62929-6741-4860-a6a3-5f90b82d5a11";

function database(group: Group, globalRole: "USER" | "ADMIN" = "USER") {
  const db = {
    project: { findUnique: vi.fn<(input: unknown) => Promise<{ responsibleGroup: Group }>>(async () => ({ responsibleGroup: group })) },
    user: { findUnique: vi.fn(async () => ({ ...actor, globalRole })) },
    taskRequest: { findUnique: vi.fn(async () => null) },
    task: { findUnique: vi.fn(async () => task), findFirst: vi.fn(async () => null), update: vi.fn() },
    taskMoveOperation: { findUnique: vi.fn() },
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join("?");
      if (sql.includes("FOR SHARE OF g, gm")) return group && group.archivedAt === null && group.members.some(row => row.userId === actor.id)
        ? [{ id: "group-1", userId: actor.id }] : [];
      if (sql.includes('FROM "ResponsibleGroup"')) return group ? [{ id: "group-1" }] : [];
      if (sql.includes('FROM "ResponsibleGroupMember"')) return group?.members ?? [];
      if (sql.includes('FROM "Task"')) return [task];
      if (sql.includes('FROM "ProjectColumn"')) return [{ id: "todo", projectId: "project-1", workflowKey: "TODO" }];
      if (sql.includes('FROM "Project"')) return [{ id: "project-1" }];
      return [];
    }),
  };
  return db;
}

describe("project raw status policy", () => {
  it.each([
    [null, false], [outsider, false], [archived, false], [member, true], [leader, true], [revokedLeader, false],
  ] as const)("resolves configured group %#", async (group, expected) => {
    const db = database(group);
    await expect(getProjectStatusPolicy(actor, "project-1", db as never)).resolves.toEqual({ canChangeStatus: expected });
  });

  it("preserves the existing ADMIN bypass without creating a group dependency", async () => {
    const db = database(null);
    await expect(getProjectStatusPolicy({ ...actor, globalRole: "ADMIN" }, "project-1", db as never))
      .resolves.toEqual({ canChangeStatus: true });
    expect(db.project.findUnique).not.toHaveBeenCalled();
  });

  it("denies missing boards and propagates database failures", async () => {
    const db = database(member);
    db.project.findUnique.mockResolvedValueOnce(null as never);
    await expect(getProjectStatusPolicy(actor, "missing", db as never)).resolves.toEqual({ canChangeStatus: false });
    db.project.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getProjectStatusPolicy(actor, "project-1", db as never)).rejects.toThrow("database unavailable");
  });

  it("needs no leader column: existing membership works and a revoked leader is denied", async () => {
    const db = database(revokedLeader);
    await expect(getProjectStatusPolicy(actor, "project-1", db as never)).resolves.toEqual({ canChangeStatus: false });
    expect(db.project.findUnique.mock.calls[0][0]).toMatchObject({ select: { responsibleGroup: { select: { members: expect.any(Object) } } } });
    expect(db.project.findUnique.mock.calls[0][0]).not.toHaveProperty("select.responsibleGroup.select.leaderId");
    const memberDb = database({ archivedAt: null, members: [{ userId: actor.id }] } as Group);
    await expect(getProjectStatusPolicy(actor, "project-1", memberDb as never)).resolves.toEqual({ canChangeStatus: true });
  });

  it("never invokes an accessor or trusts inherited leader values", async () => {
    const getter = vi.fn(() => actor.id);
    const withAccessor = { ...outsider! };
    Object.defineProperty(withAccessor, "leaderId", { get: getter });
    await expect(getProjectStatusPolicy(actor, "project-1", database(withAccessor) as never))
      .resolves.toEqual({ canChangeStatus: false });
    expect(getter).not.toHaveBeenCalled();
    const inherited = Object.assign(Object.create({ leaderId: actor.id }), { archivedAt: null, members: [] });
    await expect(getProjectStatusPolicy(actor, "project-1", database(inherited) as never))
      .resolves.toEqual({ canChangeStatus: false });
  });

  it.each([null, outsider, archived, revokedLeader])("blocks DnD before reading an old operation receipt %#", async group => {
    const tx = database(group);
    const repository = new PrismaMoveRepository({ $transaction: async (run: (db: unknown) => unknown) => run(tx) } as never, {
      actorId: actor.id, taskId: task.id, toColumnId: "todo", operationId,
    });
    await expect(moveTask({
      taskId: task.id, request: { operationId, toColumnId: "todo", expectedVersion: 1, beforeTaskId: null, afterTaskId: null },
      repository, ranks: createBase36RankService(),
    })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(tx.taskMoveOperation.findUnique).not.toHaveBeenCalled();
    expect(tx.taskRequest.findUnique).not.toHaveBeenCalled();
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it.each([null, outsider, archived, revokedLeader])("blocks the shared PATCH/bulk relocation port even for same-column calls %#", async group => {
    const tx = database(group);
    const ranks = createBase36RankService();
    await expect(prepareTaskRelocation({
      taskId: task.id, expectedProjectId: task.projectId, toColumnId: "todo",
      port: createTaskRelocationPort(tx as never, ranks, actor.id), ranks,
    })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(tx.task.findFirst).not.toHaveBeenCalled();
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it("locks the active group and matching membership together using IDs only", async () => {
    const tx = database(member);
    await expect(lockProjectStatusAuthority(tx as never, actor.id, task.projectId)).resolves.toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = tx.$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toMatch(/SELECT g\."id", gm\."userId"/);
    expect(sql).toContain('g."archivedAt" IS NULL');
    expect(sql).toContain("FOR SHARE OF g, gm");
  });

  it("does not attempt a membership lock without a group", async () => {
    const tx = database(null);
    await expect(lockProjectStatusAuthority(tx as never, actor.id, task.projectId)).resolves.toBe(false);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], [{ id: "group-1", userId: "other" }], [{ id: "", userId: actor.id }],
    [{ id: "group-1", userId: actor.id }, { id: "group-2", userId: actor.id }]])("denies absent or malformed locked authority %#", async rows => {
    const tx = { $queryRaw: vi.fn(async () => rows) };
    await expect(lockProjectStatusAuthority(tx as never, actor.id, task.projectId)).resolves.toBe(false);
  });

  it.each([member, leader])("allows the active group through both raw move ports %#", async group => {
    const tx = database(group);
    const repository = new PrismaMoveRepository({ $transaction: async (run: (db: unknown) => unknown) => run(tx) } as never, {
      actorId: actor.id, taskId: task.id, toColumnId: "todo", operationId,
    });
    await expect(repository.transact(port => port.assertLegacyMoveAllowed(task.id))).resolves.toBeUndefined();
    const ranks = createBase36RankService();
    await expect(prepareTaskRelocation({
      taskId: task.id, expectedProjectId: task.projectId, toColumnId: "todo",
      port: createTaskRelocationPort(tx as never, ranks, actor.id), ranks,
    })).resolves.toEqual({ columnId: "todo", status: "TODO" });
  });

  it("denies both ports without a locked membership even if a later policy read would grant it", async () => {
    const tx = database(member);
    const query = tx.$queryRaw.getMockImplementation()!;
    tx.$queryRaw.mockImplementation(async sql => sql.join("?").includes("FOR SHARE OF g, gm") ? [] : query(sql));
    const repository = new PrismaMoveRepository({ $transaction: async (run: (db: unknown) => unknown) => run(tx) } as never, {
      actorId: actor.id, taskId: task.id, toColumnId: "todo", operationId,
    });
    await expect(repository.transact(port => port.assertLegacyMoveAllowed(task.id)))
      .rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const ranks = createBase36RankService();
    await expect(prepareTaskRelocation({ taskId: task.id, expectedProjectId: task.projectId, toColumnId: "todo",
      port: createTaskRelocationPort(tx as never, ranks, actor.id), ranks }))
      .rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(tx.project.findUnique).not.toHaveBeenCalled();
    expect(tx.task.update).not.toHaveBeenCalled();
  });
});
