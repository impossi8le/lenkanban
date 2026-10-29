import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Canonical move -> automation integration coverage (issues #35/#41).
 *
 * These tests call the real route handlers with a real PostgreSQL database and
 * the real `moveTask` / `PrismaMoveRepository` / `processAutomationRules`
 * stack. Only the HTTP session, the socket bridge and the loggers are stubbed;
 * automation rows and notifications are read back from the database.
 */

const harness = vi.hoisted(() => ({
  client: null as unknown,
  session: null as unknown,
  transactionWrapper: null as
    | null
    | ((
        callback: (tx: unknown) => Promise<unknown>,
        options?: unknown,
      ) => Promise<unknown>),
}));

vi.mock("next-auth", () => ({
  getServerSession: async () => harness.session,
}));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/logger", () => {
  const noop = () => {};
  return {
    apiLogger: { error: noop, warn: noop, info: noop, debug: noop },
    automationLogger: { error: noop, warn: noop, info: noop, debug: noop },
    dbLogger: { error: noop, warn: noop, info: noop, debug: noop },
    socketLogger: { error: noop, warn: noop, info: noop, debug: noop },
  };
});
vi.mock("@/socket/board-events", () => ({
  emitTaskMoved: async () => {},
  emitTaskUpdated: () => {},
  emitUserNotification: () => {},
}));
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol" || key === "then") return undefined;
        if (key === "$transaction" && harness.transactionWrapper) {
          return harness.transactionWrapper;
        }
        const client = harness.client as Record<string, unknown> | null;
        if (!client) return undefined;
        const value = client[key];
        return typeof value === "function" ? value.bind(client) : value;
      },
    },
  ),
}));

import { POST as moveTaskRoute } from "@/app/api/tasks/[id]/move/route";
import { POST as bulkUpdateRoute } from "@/app/api/tasks/bulk-update/route";
import { loopbackDatabaseUrl } from "./support/test-database";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const testRunId = `task-automation-${randomUUID()}`;

function assertIsolatedTestDatabase(urlValue: string): void {
  const testUrl = new URL(urlValue);
  const databaseName = decodeURIComponent(testUrl.pathname.replace(/^\/+/, ""));
  if (!databaseName.includes("_test")) {
    throw new Error("TEST_DATABASE_URL database name must contain _test");
  }
  for (const productionUrlValue of [
    process.env.PRODUCTION_DATABASE_URL,
    process.env.DATABASE_URL,
  ]) {
    if (productionUrlValue && new URL(productionUrlValue).hostname === testUrl.hostname) {
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
  ownerId: string;
  ownerEmail: string;
  memberId: string;
  projectId: string;
  todoId: string;
  doingId: string;
  reviewId: string;
  taskAId: string;
  taskBId: string;
  taskCId: string;
}

let database: PrismaClient;
const projectIds = new Set<string>();
const userIds = new Set<string>();
const groupIds = new Set<string>();

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const ownerId = `${testRunId}-owner-${suffix}`;
  const memberId = `${testRunId}-member-${suffix}`;
  const ownerEmail = `${ownerId}@synthetic.invalid`;
  for (const id of [ownerId, memberId]) {
    await database.user.create({
      data: { id, email: `${id}@synthetic.invalid`, name: testRunId },
    });
    userIds.add(id);
  }

  const projectId = `${testRunId}-project-${suffix}`;
  const todoId = `${testRunId}-todo-${suffix}`;
  const doingId = `${testRunId}-doing-${suffix}`;
  const reviewId = `${testRunId}-review-${suffix}`;
  const groupId = `${testRunId}-group-${suffix}`;
  await database.responsibleGroup.create({ data: {
    id: groupId, name: testRunId, members: { create: { userId: ownerId } },
  } });
  groupIds.add(groupId);
  await database.project.create({
    data: {
      id: projectId,
      name: `${testRunId}-${suffix}`,
      ownerId,
      responsibleGroupId: groupId,
      members: { create: { userId: memberId, role: "MEMBER" } },
      columns: {
        create: [
          { id: todoId, name: "Todo", color: "#111111", position: 0, workflowKey: "TODO" },
          { id: doingId, name: "Doing", color: "#222222", position: 1, workflowKey: "IN_PROGRESS" },
          { id: reviewId, name: "Review", color: "#333333", position: 2, workflowKey: "REVIEW" },
        ],
      },
    },
  });
  projectIds.add(projectId);

  const taskAId = `${testRunId}-a-${suffix}`;
  const taskBId = `${testRunId}-b-${suffix}`;
  const taskCId = `${testRunId}-c-${suffix}`;
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
        columnId: doingId,
        status: "IN_PROGRESS",
        rank: "0|0000000000000000002S",
        position: 1024,
      },
    ],
  });
  await database.taskAssignee.createMany({
    data: [taskAId, taskBId, taskCId].map((taskId) => ({
      taskId,
      userId: memberId,
    })),
  });

  return {
    ownerId,
    ownerEmail,
    memberId,
    projectId,
    todoId,
    doingId,
    reviewId,
    taskAId,
    taskBId,
    taskCId,
  };
}

async function createRule(
  fixture: Fixture,
  options: {
    trigger?: string;
    active?: boolean;
    conditions?: unknown;
    actions?: unknown;
  } = {},
): Promise<string> {
  const rule = await database.automationRule.create({
    data: {
      name: `${testRunId}-rule`,
      projectId: fixture.projectId,
      createdById: fixture.ownerId,
      active: options.active ?? true,
      trigger: options.trigger ?? "status_changed",
      conditions: (options.conditions ?? []) as Prisma.InputJsonValue,
      actions: (options.actions ?? [
        { type: "notify_assignees", params: { title: "Synthetic move notice" } },
      ]) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return rule.id;
}

function useSession(fixture: Fixture): void {
  harness.session = {
    user: { id: fixture.ownerId, email: fixture.ownerEmail },
  };
}

function moveRequest(
  fixture: Fixture,
  input: {
    taskId: string;
    toColumnId: string;
    beforeTaskId: string | null;
    afterTaskId: string | null;
    operationId: string;
    expectedVersion: number;
  },
): Promise<Response> {
  return moveTaskRoute(
    new Request(`http://localhost/api/tasks/${input.taskId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toColumnId: input.toColumnId,
        beforeTaskId: input.beforeTaskId,
        afterTaskId: input.afterTaskId,
        operationId: input.operationId,
        expectedVersion: input.expectedVersion,
      }),
    }),
    { params: Promise.resolve({ id: input.taskId }) },
  );
}

function automationNotifications(fixture: Fixture) {
  return database.notification.count({
    where: { userId: { in: [fixture.ownerId, fixture.memberId] }, type: "automation_rule" },
  });
}

async function readTask(taskId: string) {
  return database.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      columnId: true,
      status: true,
      version: true,
      rank: true,
      position: true,
    },
  });
}

describeWithDatabase("canonical move automation on PostgreSQL", () => {
  beforeAll(() => {
    const isolatedPoolUrl = new URL(testDatabaseUrl!);
    // This suite is sequential; a small pool keeps its footprint low while
    // still leaving room for the move and automation transactions.
    isolatedPoolUrl.searchParams.set("connection_limit", "2");
    database = new PrismaClient({
      datasourceUrl: loopbackDatabaseUrl(isolatedPoolUrl),
    });
    harness.client = database;
  });

  afterAll(async () => {
    if (!database) return;
    try {
      await database.notification.deleteMany({
        where: { userId: { in: [...userIds] } },
      });
      await database.automationRule.deleteMany({
        where: { projectId: { in: [...projectIds] } },
      });
      await database.project.deleteMany({
        where: { id: { in: [...projectIds] }, name: { contains: testRunId } },
      });
      await database.responsibleGroup.deleteMany({
        where: { id: { in: [...groupIds] }, name: testRunId },
      });
      await database.user.deleteMany({
        where: { id: { in: [...userIds] }, name: testRunId },
      });
      await database.rateLimit.deleteMany({
        where: { key: { contains: testRunId } },
      });
    } finally {
      await database.$disconnect();
    }
  });

  it("runs exactly one matching status_changed rule once for a committed move", async () => {
    const fixture = await createFixture();
    useSession(fixture);
    const matchingRuleId = await createRule(fixture);
    await createRule(fixture, {
      conditions: [{ field: "status", operator: "equals", value: "DONE" }],
    });
    await createRule(fixture, { active: false });
    await createRule(fixture, { trigger: "priority_changed" });

    const response = await moveRequest(fixture, {
      taskId: fixture.taskAId,
      toColumnId: fixture.doingId,
      beforeTaskId: null,
      afterTaskId: fixture.taskCId,
      operationId: randomUUID(),
      expectedVersion: 0,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        task: { id: fixture.taskAId, columnId: fixture.doingId, version: 1, status: "IN_PROGRESS" },
      },
    });
    await expect(readTask(fixture.taskAId)).resolves.toMatchObject({
      columnId: fixture.doingId,
      status: "IN_PROGRESS",
      version: 1,
    });
    // One row: the matching rule fired once; the condition-mismatched,
    // inactive and foreign-trigger rules produced nothing.
    await expect(
      database.notification.findMany({
        where: { userId: fixture.memberId, type: "automation_rule" },
        select: { title: true, metadata: true },
      }),
    ).resolves.toEqual([
      {
        title: "Synthetic move notice",
        metadata: {
          taskId: fixture.taskAId,
          projectId: fixture.projectId,
          ruleType: "notify_assignees",
        },
      },
    ]);
    await expect(
      database.activity.count({ where: { taskId: fixture.taskAId, action: "moved" } }),
    ).resolves.toBe(1);
    expect(matchingRuleId).toBeTruthy();
  });

  it("stays silent for a same-column reorder that keeps the derived status", async () => {
    const fixture = await createFixture();
    useSession(fixture);
    await createRule(fixture);

    const response = await moveRequest(fixture, {
      taskId: fixture.taskAId,
      toColumnId: fixture.todoId,
      beforeTaskId: fixture.taskBId,
      afterTaskId: null,
      operationId: randomUUID(),
      expectedVersion: 0,
    });

    expect(response.status).toBe(200);
    await expect(readTask(fixture.taskAId)).resolves.toMatchObject({
      columnId: fixture.todoId,
      status: "TODO",
      version: 1,
    });
    await expect(automationNotifications(fixture)).resolves.toBe(0);
    // The reorder itself still commits one Activity row.
    await expect(
      database.activity.count({ where: { taskId: fixture.taskAId, action: "moved" } }),
    ).resolves.toBe(1);
  });

  it("replays the same operationId without a second side effect", async () => {
    const fixture = await createFixture();
    useSession(fixture);
    await createRule(fixture);
    const operationId = randomUUID();
    const input = {
      taskId: fixture.taskAId,
      toColumnId: fixture.doingId,
      beforeTaskId: null,
      afterTaskId: fixture.taskCId,
      operationId,
      expectedVersion: 0,
    };

    const first = await moveRequest(fixture, input);
    const replay = await moveRequest(fixture, input);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(first.json()).resolves.toEqual(await replay.json());
    await expect(
      database.taskMoveOperation.count({ where: { operationId } }),
    ).resolves.toBe(1);
    await expect(
      database.activity.count({ where: { taskId: fixture.taskAId, action: "moved" } }),
    ).resolves.toBe(1);
    await expect(automationNotifications(fixture)).resolves.toBe(1);
    await expect(
      database.project.findUniqueOrThrow({
        where: { id: fixture.projectId },
        select: { boardRevision: true },
      }),
    ).resolves.toEqual({ boardRevision: 1 });
  });

  it("suppresses an old operationId replayed after a later move", async () => {
    const fixture = await createFixture();
    useSession(fixture);
    await createRule(fixture);
    const firstOperationId = randomUUID();
    const first = {
      taskId: fixture.taskAId,
      toColumnId: fixture.doingId,
      beforeTaskId: null,
      afterTaskId: fixture.taskCId,
      operationId: firstOperationId,
      expectedVersion: 0,
    };
    expect((await moveRequest(fixture, first)).status).toBe(200);
    expect(
      (
        await moveRequest(fixture, {
          taskId: fixture.taskAId,
          toColumnId: fixture.reviewId,
          beforeTaskId: null,
          afterTaskId: null,
          operationId: randomUUID(),
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    await expect(automationNotifications(fixture)).resolves.toBe(2);

    // The stored response still says IN_PROGRESS while the task is IN_REVIEW:
    // only the replay marker can keep this from emitting a stale event.
    const replay = await moveRequest(fixture, first);

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { task: { id: fixture.taskAId, columnId: fixture.doingId, version: 1, status: "IN_PROGRESS" } },
    });
    await expect(readTask(fixture.taskAId)).resolves.toMatchObject({
      columnId: fixture.reviewId,
      status: "IN_REVIEW",
      version: 2,
    });
    await expect(automationNotifications(fixture)).resolves.toBe(2);
  });

  it("leaves no automation row or notification when the move transaction rolls back", async () => {
    const fixture = await createFixture();
    useSession(fixture);
    await createRule(fixture);
    const operationId = randomUUID();
    const originalWrapper = harness.transactionWrapper;
    harness.transactionWrapper = (callback, options) => {
      const typed = options as
        | { isolationLevel?: Prisma.TransactionIsolationLevel }
        | undefined;
      // Only the canonical move opens a Serializable transaction; the
      // automation rule transaction stays untouched and must not be mistaken
      // for the rolled-back move.
      if (typed?.isolationLevel !== Prisma.TransactionIsolationLevel.Serializable) {
        return database.$transaction(
          callback as (tx: Prisma.TransactionClient) => Promise<unknown>,
          typed,
        );
      }
      return database.$transaction(async (tx) => {
        await callback(tx);
        throw new Error("synthetic rollback after move");
      }, typed);
    };

    try {
      const response = await moveRequest(fixture, {
        taskId: fixture.taskAId,
        toColumnId: fixture.doingId,
        beforeTaskId: null,
        afterTaskId: fixture.taskCId,
        operationId,
        expectedVersion: 0,
      });
      expect(response.status).toBe(500);
    } finally {
      harness.transactionWrapper = originalWrapper;
    }

    await expect(readTask(fixture.taskAId)).resolves.toMatchObject({
      columnId: fixture.todoId,
      status: "TODO",
      version: 0,
      rank: "0|0000000000000000002S",
      position: 1024,
    });
    await expect(automationNotifications(fixture)).resolves.toBe(0);
    await expect(
      database.activity.count({ where: { taskId: fixture.taskAId } }),
    ).resolves.toBe(0);
    await expect(
      database.taskMoveOperation.count({ where: { operationId } }),
    ).resolves.toBe(0);
    await expect(
      database.project.findUniqueOrThrow({
        where: { id: fixture.projectId },
        select: { boardRevision: true },
      }),
    ).resolves.toEqual({ boardRevision: 0 });
  });

  it("keeps the committed move and ACK when the automation rule fails", async () => {
    const fixture = await createFixture();
    useSession(fixture);
    // notify_creator cannot be planned: the fixture tasks have no creator, so
    // the rule transaction throws RECIPIENT_UNAVAILABLE after the move committed.
    await createRule(fixture, {
      actions: [{ type: "notify_creator", params: {} }],
    });
    await expect(
      database.task.findUniqueOrThrow({
        where: { id: fixture.taskAId },
        select: { createdById: true },
      }),
    ).resolves.toEqual({ createdById: null });

    const response = await moveRequest(fixture, {
      taskId: fixture.taskAId,
      toColumnId: fixture.doingId,
      beforeTaskId: null,
      afterTaskId: fixture.taskCId,
      operationId: randomUUID(),
      expectedVersion: 0,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { task: { id: fixture.taskAId, status: "IN_PROGRESS", version: 1 } },
    });
    await expect(readTask(fixture.taskAId)).resolves.toMatchObject({
      columnId: fixture.doingId,
      status: "IN_PROGRESS",
      version: 1,
    });
    await expect(automationNotifications(fixture)).resolves.toBe(0);
  });

  it("emits one status event per actually moved row in a bulk move", async () => {
    const fixture = await createFixture();
    useSession(fixture);
    await createRule(fixture);

    const response = await bulkUpdateRoute(
      new Request("http://localhost/api/tasks/bulk-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskIds: [fixture.taskAId, fixture.taskBId, fixture.taskCId],
          updates: { columnId: fixture.doingId },
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { success: true, updatedCount: 3 },
    });
    // A and B really moved; C was already in the destination column.
    await expect(readTask(fixture.taskAId)).resolves.toMatchObject({
      columnId: fixture.doingId,
      status: "IN_PROGRESS",
    });
    await expect(readTask(fixture.taskBId)).resolves.toMatchObject({
      columnId: fixture.doingId,
      status: "IN_PROGRESS",
    });
    await expect(readTask(fixture.taskCId)).resolves.toMatchObject({
      columnId: fixture.doingId,
      status: "IN_PROGRESS",
      version: 0,
    });
    const rows = await database.notification.findMany({
      where: { userId: fixture.memberId, type: "automation_rule" },
      select: { metadata: true },
    });
    expect(rows).toHaveLength(2);
    const notifiedTaskIds = rows
      .map((row) => (row.metadata as { taskId?: string }).taskId)
      .sort();
    expect(notifiedTaskIds).toEqual(
      [fixture.taskAId, fixture.taskBId].sort(),
    );
    await expect(
      database.activity.count({
        where: { taskId: { in: [fixture.taskAId, fixture.taskBId] }, action: "moved" },
      }),
    ).resolves.toBe(2);
    await expect(
      database.activity.count({ where: { taskId: fixture.taskCId, action: "moved" } }),
    ).resolves.toBe(0);
    await expect(
      database.project.findUniqueOrThrow({
        where: { id: fixture.projectId },
        select: { boardRevision: true },
      }),
    ).resolves.toEqual({ boardRevision: 2 });
  }, 30_000);
});
