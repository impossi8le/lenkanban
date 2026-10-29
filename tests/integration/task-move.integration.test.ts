import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { createBase36RankService } from "@/features/kanban/rank/rank-service";
import { derivedTaskStatus } from "@/features/kanban/server/move-contract";
import { MoveTaskError } from "@/features/kanban/server/move-errors";
import {
  moveTask,
  type MoveTaskRepository,
} from "@/features/kanban/server/move-task-service";
import { loopbackDatabaseUrl } from "./support/test-database";
import { PrismaMoveRepository } from "@/features/kanban/server/prisma-move-repository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const testRunId = `task-move-${randomUUID()}`;

function assertIsolatedTestDatabase(urlValue: string): void {
  const testUrl = new URL(urlValue);
  const databaseName = decodeURIComponent(
    testUrl.pathname.replace(/^\/+/, ""),
  );
  if (!databaseName.includes("_test")) {
    throw new Error(
      "TEST_DATABASE_URL database name must contain _test",
    );
  }

  const productionUrls = [
    process.env.PRODUCTION_DATABASE_URL,
    process.env.DATABASE_URL,
  ].filter((value): value is string => Boolean(value));
  for (const productionUrlValue of productionUrls) {
    const productionUrl = new URL(productionUrlValue);
    if (productionUrl.hostname === testUrl.hostname) {
      throw new Error(
        "TEST_DATABASE_URL hostname must not match the production database hostname",
      );
    }
  }
}

if (testDatabaseUrl) {
  assertIsolatedTestDatabase(testDatabaseUrl);
}

interface Fixture {
  userId: string;
  groupId: string;
  projectId: string;
  todoId: string;
  doingId: string;
  emptyId: string;
  taskAId: string;
  taskBId: string;
  taskCId: string;
  taskDId: string;
}

let database: PrismaClient;
const projectIds = new Set<string>();
const userIds = new Set<string>();
const groupIds = new Set<string>();

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const userId = `${testRunId}-user-${suffix}`;
  const projectId = `${testRunId}-project-${suffix}`;
  const todoId = `${testRunId}-todo-${suffix}`;
  const doingId = `${testRunId}-doing-${suffix}`;
  const emptyId = `${testRunId}-empty-${suffix}`;
  const taskAId = `${testRunId}-a-${suffix}`;
  const taskBId = `${testRunId}-b-${suffix}`;
  const taskCId = `${testRunId}-c-${suffix}`;
  const taskDId = `${testRunId}-d-${suffix}`;

  await database.user.create({
    data: {
      id: userId,
      email: `${suffix}@${testRunId}.invalid`,
      name: testRunId,
    },
  });
  userIds.add(userId);
  const groupId = `${testRunId}-group-${suffix}`;
  await database.responsibleGroup.create({ data: {
    id: groupId, name: testRunId, members: { create: { userId } },
  } });
  groupIds.add(groupId);
  await database.project.create({
    data: {
      id: projectId,
      name: `${testRunId}-${suffix}`,
      ownerId: userId,
      responsibleGroupId: groupId,
      columns: {
        create: [
          {
            id: todoId,
            name: "Todo",
            color: "#111111",
            position: 0,
            workflowKey: "TODO",
          },
          {
            id: doingId,
            name: "Doing",
            color: "#222222",
            position: 1,
            workflowKey: "IN_PROGRESS",
          },
          {
            id: emptyId,
            name: "Review",
            color: "#333333",
            position: 2,
            workflowKey: "REVIEW",
          },
        ],
      },
    },
  });
  projectIds.add(projectId);
  await database.task.createMany({
    data: [
      {
        id: taskAId,
        title: `${testRunId}-a`,
        projectId,
        columnId: todoId,
        status: "TODO",
        rank: "0|0000000000000000002S",
        position: 1024,
      },
      {
        id: taskBId,
        title: `${testRunId}-b`,
        projectId,
        columnId: todoId,
        status: "TODO",
        rank: "0|0000000000000000005K",
        position: 2048,
      },
      {
        id: taskCId,
        title: `${testRunId}-c`,
        projectId,
        columnId: todoId,
        status: "TODO",
        rank: "0|0000000000000000008C",
        position: 3072,
      },
      {
        id: taskDId,
        title: `${testRunId}-d`,
        projectId,
        columnId: doingId,
        status: "IN_PROGRESS",
        rank: "0|0000000000000000002S",
        position: 1024,
      },
    ],
  });

  return {
    userId,
    groupId,
    projectId,
    todoId,
    doingId,
    emptyId,
    taskAId,
    taskBId,
    taskCId,
    taskDId,
  };
}

function repository(
  fixture: Fixture,
  input: {
    taskId: string;
    toColumnId: string;
    operationId: string;
  },
): PrismaMoveRepository {
  return new PrismaMoveRepository(database, {
    ...input,
    actorId: fixture.userId,
  });
}

// Hold the real project row lock until PostgreSQL reports both move sessions
// waiting on it (directly or behind another waiter). A JS barrier alone does
// not prove that the transactions actually overlap.
async function runQueuedMoves<T>(projectId: string, start: () => Promise<T>[]) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const unlocked = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<number>((resolve) => { ready = resolve; });
  const blocker = database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(backend.pid);
    await unlocked;
  }, { timeout: 20_000 });
  let outcomes: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    const blockerPid = await Promise.race([
      locked,
      blocker.then(() => { throw new Error("Project blocker ended before becoming ready"); }),
    ]);
    outcomes = Promise.allSettled(start());
    const deadline = Date.now() + 8_000;
    let waiting = 0;
    do {
      const [state] = await database.$queryRaw<{ count: number }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity
          WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        )
        SELECT count(*)::int AS count FROM blocked
      `;
      waiting = state.count;
      if (waiting >= 2) break;
      await delay(20);
    } while (Date.now() < deadline);
    expect(waiting, "Both move sessions must be queued on the held project lock").toBeGreaterThanOrEqual(2);
  } finally {
    release();
    await blocker;
    // Drain attempts even when overlap verification fails, before fixture cleanup.
    if (outcomes) await outcomes;
  }
  return outcomes!;
}

describeWithDatabase("PostgreSQL transactional task movement", () => {
  beforeAll(() => {
    // Two queued moves, their blocker, and the lock observer need four
    // connections even on single-CPU CI hosts (Prisma otherwise defaults to 3).
    const isolatedPoolUrl = new URL(testDatabaseUrl!);
    isolatedPoolUrl.searchParams.set("connection_limit", "5");
    database = new PrismaClient({
      datasourceUrl: loopbackDatabaseUrl(isolatedPoolUrl),
    });
  });

  afterAll(async () => {
    if (!database) {
      return;
    }
    if (projectIds.size > 0) {
      await database.project.deleteMany({
        where: {
          id: { in: [...projectIds] },
          name: { contains: testRunId },
        },
      });
    }
    if (groupIds.size > 0) {
      await database.responsibleGroup.deleteMany({ where: { id: { in: [...groupIds] }, name: testRunId } });
    }
    if (userIds.size > 0) {
      await database.user.deleteMany({
        where: {
          id: { in: [...userIds] },
          email: { contains: testRunId },
        },
      });
    }
    await database.$disconnect();
  });

  it("commits exact same-column and cross-column rank, position, and version results", async () => {
    const fixture = await createFixture();
    const sameColumnOperation = randomUUID();
    await moveTask({
      taskId: fixture.taskCId,
      request: {
        toColumnId: fixture.todoId,
        beforeTaskId: null,
        afterTaskId: fixture.taskAId,
        operationId: sameColumnOperation,
        expectedVersion: 0,
      },
      repository: repository(fixture, {
        taskId: fixture.taskCId,
        toColumnId: fixture.todoId,
        operationId: sameColumnOperation,
      }),
      ranks: createBase36RankService(),
    });

    const sameColumnTasks = await database.task.findMany({
      where: { columnId: fixture.todoId },
      orderBy: { rank: "asc" },
      select: { id: true, rank: true, position: true, version: true },
    });
    expect(sameColumnTasks).toEqual([
      {
        id: fixture.taskCId,
        rank: "0|0000000000000000001E",
        position: 1024,
        version: 1,
      },
      {
        id: fixture.taskAId,
        rank: "0|0000000000000000002S",
        position: 2048,
        version: 0,
      },
      {
        id: fixture.taskBId,
        rank: "0|0000000000000000005K",
        position: 3072,
        version: 0,
      },
    ]);

    const crossColumnOperation = randomUUID();
    await moveTask({
      taskId: fixture.taskCId,
      request: {
        toColumnId: fixture.doingId,
        beforeTaskId: fixture.taskDId,
        afterTaskId: null,
        operationId: crossColumnOperation,
        expectedVersion: 1,
      },
      repository: repository(fixture, {
        taskId: fixture.taskCId,
        toColumnId: fixture.doingId,
        operationId: crossColumnOperation,
      }),
      ranks: createBase36RankService(),
    });

    const movedTask = await database.task.findUniqueOrThrow({
      where: { id: fixture.taskCId },
      select: {
        columnId: true,
        rank: true,
        position: true,
        version: true,
        status: true,
      },
    });
    expect(movedTask).toEqual({
      columnId: fixture.doingId,
      rank: "0|I000000000000000001D",
      position: 2048,
      version: 2,
      status: "IN_PROGRESS",
    });
    await expect(
      database.project.findUniqueOrThrow({
        where: { id: fixture.projectId },
        select: { boardRevision: true },
      }),
    ).resolves.toEqual({ boardRevision: 2 });
  });

  it("replays an identical operation without a second write", async () => {
    const fixture = await createFixture();
    const operationId = randomUUID();
    const moveInput = {
      taskId: fixture.taskCId,
      request: {
        toColumnId: fixture.doingId,
        beforeTaskId: fixture.taskDId,
        afterTaskId: null,
        operationId,
        expectedVersion: 0,
      },
      repository: repository(fixture, {
        taskId: fixture.taskCId,
        toColumnId: fixture.doingId,
        operationId,
      }),
      ranks: createBase36RankService(),
    };
    const first = await moveTask(moveInput);
    const replay = await moveTask(moveInput);

    expect(replay).toEqual(first);
    await expect(
      database.activity.count({
        where: { taskId: fixture.taskCId, action: "moved" },
      }),
    ).resolves.toBe(1);
    await expect(
      database.project.findUniqueOrThrow({
        where: { id: fixture.projectId },
        select: { boardRevision: true },
      }),
    ).resolves.toEqual({ boardRevision: 1 });
  });

  it("denies a new move and historical replay after actual group membership is revoked", async () => {
    const fixture = await createFixture();
    const operationId = randomUUID();
    const input = {
      taskId: fixture.taskCId,
      request: { toColumnId: fixture.doingId, beforeTaskId: fixture.taskDId, afterTaskId: null, operationId, expectedVersion: 0 },
      repository: repository(fixture, { taskId: fixture.taskCId, toColumnId: fixture.doingId, operationId }),
      ranks: createBase36RankService(),
    };
    await moveTask(input);
    const before = await database.task.findMany({ where: { projectId: fixture.projectId }, orderBy: { id: "asc" } });
    const revision = await database.project.findUniqueOrThrow({ where: { id: fixture.projectId }, select: { ownerId: true, boardRevision: true } });
    const activities = await database.activity.count({ where: { task: { projectId: fixture.projectId } } });
    // Coarse owner authority remains. Only the real status-membership row goes.
    expect(revision.ownerId).toBe(fixture.userId);
    await database.responsibleGroupMember.delete({ where: { groupId_userId: { groupId: fixture.groupId, userId: fixture.userId } } });
    await expect(moveTask(input)).rejects.toEqual(new MoveTaskError("TASK_NOT_FOUND"));
    const newOperationId = randomUUID();
    await expect(moveTask({
      taskId: fixture.taskAId,
      request: { toColumnId: fixture.doingId, beforeTaskId: null, afterTaskId: null, operationId: newOperationId, expectedVersion: 0 },
      repository: repository(fixture, { taskId: fixture.taskAId, toColumnId: fixture.doingId, operationId: newOperationId }),
      ranks: createBase36RankService(),
    })).rejects.toEqual(new MoveTaskError("TASK_NOT_FOUND"));
    expect(await database.task.findMany({ where: { projectId: fixture.projectId }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await database.project.findUniqueOrThrow({ where: { id: fixture.projectId }, select: { ownerId: true, boardRevision: true } })).toEqual(revision);
    expect(await database.activity.count({ where: { task: { projectId: fixture.projectId } } })).toBe(activities);
    expect(await database.taskMoveOperation.count({ where: { projectId: fixture.projectId } })).toBe(1);
    expect(await database.taskMoveOperation.count({ where: { operationId: newOperationId } })).toBe(0);
  });

  it("serializes two commands into one gap and rejects the stale neighbor pair", async () => {
    const fixture = await createFixture();
    const taskEId = `${testRunId}-e-${randomUUID()}`;
    await database.task.create({
      data: {
        id: taskEId,
        title: `${testRunId}-e`,
        projectId: fixture.projectId,
        columnId: fixture.doingId,
        status: "IN_PROGRESS",
        rank: "0|0000000000000000005K",
        position: 2048,
      },
    });
    const operationIds = [randomUUID(), randomUUID()];
    const outcomes = await Promise.allSettled(
      [fixture.taskBId, fixture.taskCId].map((taskId, index) =>
        moveTask({
          taskId,
          request: {
            toColumnId: fixture.doingId,
            beforeTaskId: fixture.taskDId,
            afterTaskId: taskEId,
            operationId: operationIds[index],
            expectedVersion: 0,
          },
          repository: repository(fixture, {
            taskId,
            toColumnId: fixture.doingId,
            operationId: operationIds[index],
          }),
          ranks: createBase36RankService(),
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled"))
      .toHaveLength(1);
    const rejection = outcomes.find(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejection).toMatchObject({
      reason: new MoveTaskError("INVALID_MOVE_NEIGHBORS"),
    });
    const destinationIds = await database.task.findMany({
      where: { columnId: fixture.doingId },
      orderBy: { rank: "asc" },
      select: { id: true },
    });
    expect(destinationIds[0]?.id).toBe(fixture.taskDId);
    expect(destinationIds[2]?.id).toBe(taskEId);
  });

  it("commits only one of two queued moves of the same task version", async () => {
    const fixture = await createFixture();
    const operationIds = [randomUUID(), randomUUID()];
    const destinations = [fixture.doingId, fixture.emptyId];
    const outcomes = await runQueuedMoves(fixture.projectId, () => destinations.map((toColumnId, index) =>
      moveTask({
        taskId: fixture.taskCId,
        request: {
          toColumnId, beforeTaskId: index === 0 ? fixture.taskDId : null,
          afterTaskId: null, operationId: operationIds[index], expectedVersion: 0,
        },
        repository: repository(fixture, { taskId: fixture.taskCId, toColumnId, operationId: operationIds[index] }),
        ranks: createBase36RankService(),
      }),
    ));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({
      reason: new MoveTaskError("STALE_TASK_VERSION"),
    });
    const winner = outcomes.findIndex(result => result.status === "fulfilled");
    const tasks = await database.task.findMany({
      where: { projectId: fixture.projectId }, orderBy: { id: "asc" },
      select: { id: true, columnId: true, rank: true, position: true, version: true, status: true },
    });
    expect(tasks).toEqual([
      { id: fixture.taskAId, columnId: fixture.todoId, rank: "0|0000000000000000002S", position: 1024, version: 0, status: "TODO" },
      { id: fixture.taskBId, columnId: fixture.todoId, rank: "0|0000000000000000005K", position: 2048, version: 0, status: "TODO" },
      {
        id: fixture.taskCId, columnId: destinations[winner],
        rank: winner === 0 ? "0|I000000000000000001D" : "0|HZZZZZZZZZZZZZZZZZZZ",
        position: winner === 0 ? 2048 : 1024, version: 1,
        // Status follows the destination column's workflow key; the REVIEW
        // column maps to the IN_REVIEW status, as move-contract asserts.
        status: winner === 0 ? derivedTaskStatus("IN_PROGRESS") : derivedTaskStatus("REVIEW"),
      },
      { id: fixture.taskDId, columnId: fixture.doingId, rank: "0|0000000000000000002S", position: 1024, version: 0, status: "IN_PROGRESS" },
    ]);
    await expect(database.taskMoveOperation.findMany({
      where: { projectId: fixture.projectId }, select: { operationId: true },
    })).resolves.toEqual([{ operationId: operationIds[winner] }]);
    await expect(database.activity.count({ where: { taskId: fixture.taskCId, action: "moved" } })).resolves.toBe(1);
    await expect(database.project.findUniqueOrThrow({
      where: { id: fixture.projectId }, select: { boardRevision: true },
    })).resolves.toEqual({ boardRevision: 1 });
  }, 30_000);

  it("replays two simultaneously queued identical operations with one commit", async () => {
    const fixture = await createFixture();
    const operationId = randomUUID();
    const outcomes = await runQueuedMoves(fixture.projectId, () => [0, 1].map(() => moveTask({
      taskId: fixture.taskCId,
      request: {
        toColumnId: fixture.doingId, beforeTaskId: fixture.taskDId, afterTaskId: null,
        operationId, expectedVersion: 0,
      },
      repository: repository(fixture, { taskId: fixture.taskCId, toColumnId: fixture.doingId, operationId }),
      ranks: createBase36RankService(),
    })));
    expect(outcomes.every(result => result.status === "fulfilled")).toBe(true);
    expect(outcomes[1]).toEqual(outcomes[0]);
    await expect(database.task.findUniqueOrThrow({
      where: { id: fixture.taskCId },
      select: { columnId: true, rank: true, position: true, version: true, status: true },
    })).resolves.toEqual({
      columnId: fixture.doingId, rank: "0|I000000000000000001D", position: 2048,
      version: 1, status: "IN_PROGRESS",
    });
    await expect(database.taskMoveOperation.count({ where: { operationId } })).resolves.toBe(1);
    await expect(database.activity.count({ where: { taskId: fixture.taskCId, action: "moved" } })).resolves.toBe(1);
    await expect(database.project.findUniqueOrThrow({
      where: { id: fixture.projectId }, select: { boardRevision: true },
    })).resolves.toEqual({ boardRevision: 1 });
  }, 30_000);

  it("rejects a forced stale version without writes", async () => {
    const fixture = await createFixture();
    const operationId = randomUUID();

    await expect(
      moveTask({
        taskId: fixture.taskCId,
        request: {
          toColumnId: fixture.doingId,
          beforeTaskId: fixture.taskDId,
          afterTaskId: null,
          operationId,
          expectedVersion: 7,
        },
        repository: repository(fixture, {
          taskId: fixture.taskCId,
          toColumnId: fixture.doingId,
          operationId,
        }),
        ranks: createBase36RankService(),
      }),
    ).rejects.toEqual(new MoveTaskError("STALE_TASK_VERSION"));
    await expect(
      database.taskMoveOperation.count({
        where: { operationId },
      }),
    ).resolves.toBe(0);
  });

  it("rolls back the real adapter after a test-only transaction exception", async () => {
    const fixture = await createFixture();
    const operationId = randomUUID();
    const baseRepository = repository(fixture, {
      taskId: fixture.taskCId,
      toColumnId: fixture.doingId,
      operationId,
    });
    const failingRepository: MoveTaskRepository = {
      transact: (operation) =>
        baseRepository.transact(async (tx) => {
          await operation(tx);
          throw new Error("test-only rollback");
        }),
    };

    await expect(
      moveTask({
        taskId: fixture.taskCId,
        request: {
          toColumnId: fixture.doingId,
          beforeTaskId: fixture.taskDId,
          afterTaskId: null,
          operationId,
          expectedVersion: 0,
        },
        repository: failingRepository,
        ranks: createBase36RankService(),
      }),
    ).rejects.toThrow("test-only rollback");

    await expect(
      database.task.findUniqueOrThrow({
        where: { id: fixture.taskCId },
        select: { columnId: true, version: true, position: true },
      }),
    ).resolves.toEqual({
      columnId: fixture.todoId,
      version: 0,
      position: 3072,
    });
    await expect(
      database.taskMoveOperation.count({ where: { operationId } }),
    ).resolves.toBe(0);
    await expect(
      database.activity.count({
        where: { taskId: fixture.taskCId },
      }),
    ).resolves.toBe(0);
    await expect(
      database.project.findUniqueOrThrow({
        where: { id: fixture.projectId },
        select: { boardRevision: true },
      }),
    ).resolves.toEqual({ boardRevision: 0 });
  });
});
