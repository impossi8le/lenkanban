import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level checks for the selection → bulk action path (#49).
 *
 * The UI sends one POST per batch, so the route itself must decide whether the
 * whole batch is allowed. These tests cover the server boundary only: the
 * per-task authorization gate, cross-board refusal, the no-op payload and the
 * "committed but realtime failed" case. Database semantics stay synthetic.
 */

const api = vi.hoisted(() => ({
  database: {} as Record<string, unknown>,
  session: { user: { id: "actor" } } as { user: { id: string } } | null,
  moved: vi.fn(),
  updated: vi.fn(),
  automation: vi.fn(),
  scalarBatch: vi.fn(),
  diagnostic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(api.database, key) }) }));
vi.mock("next-auth", () => ({ getServerSession: async () => api.session }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: vi.fn(),
  rateLimitErrorResponse: () => new Response(null, { status: 429 }),
}));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: api.moved, emitTaskUpdated: api.updated }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: api.diagnostic, warn: api.diagnostic } }));
vi.mock("@/lib/automation-processor", () => ({ processBulkMoveAutomation: api.automation }));
vi.mock("@/lib/task-command", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/task-command")>(),
  prepareLegacyTaskScalarBatch: api.scalarBatch,
}));

import { POST } from "./route";

const ownTaskId = "cm0000000000000000000001";
const secondTaskId = "cm0000000000000000000002";

type PrecheckRow = {
  id: string;
  projectId: string;
  columnId: string;
  status: string;
  priority: string;
  version: number;
  deadline: Date | null;
  project: { id: string; ownerId: string; members: Array<{ id: string }> };
};

function precheckTask(id: string, options: { ownerId?: string; member?: boolean } = {}): PrecheckRow {
  return {
    id,
    projectId: "project",
    columnId: "column-one",
    status: "TODO",
    priority: "LOW",
    version: 3,
    deadline: null,
    project: {
      id: "project",
      ownerId: options.ownerId ?? "actor",
      members: options.member === false ? [] : [{ id: "membership" }],
    },
  };
}

function fixture(options: {
  precheck: PrecheckRow[];
  columnProjectId?: string;
  emitFailure?: boolean;
} = { precheck: [precheckTask(ownTaskId)] }) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join("?");
      if (sql.includes('FROM "ProjectColumn"')) {
        calls.push("column-identity");
        return [{ id: "column-two", projectId: options.columnProjectId ?? "project", name: "Two", workflowKey: "DONE" }];
      }
      calls.push("unexpected-raw");
      throw new Error("Unexpected fixture query");
    }),
    task: {
      update: vi.fn(async () => { calls.push("task-update"); return {}; }),
      updateMany: vi.fn(async () => { calls.push("task-cas"); return { count: 1 }; }),
    },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
    calls.push("transaction");
    return callback(tx);
  });
  const database = {
    task: {
      findMany: vi.fn(async () => {
        calls.push("precheck-read");
        return options.precheck.map(row => structuredClone(row));
      }),
    },
    $transaction: transaction,
  };
  api.database = database;
  api.scalarBatch.mockImplementation(async () => options.precheck.map(row => ({
    id: row.id, projectId: row.projectId, priority: row.priority, version: row.version,
  })));
  api.moved.mockImplementation(() => undefined);
  api.updated.mockImplementation(() => {
    if (options.emitFailure) throw new Error("synthetic-private-transport");
  });
  api.automation.mockResolvedValue(undefined);
  const run = (body: unknown) => POST(new Request("http://localhost/api/tasks/bulk-update", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never);
  return { calls, tx, database, transaction, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.session = { user: { id: "actor" } };
  api.diagnostic.mockImplementation(() => undefined);
});

describe("POST /api/tasks/bulk-update authorization gate", () => {
  it("refuses the whole batch when one selected task belongs to another board's owner", async () => {
    const f = fixture({
      precheck: [
        precheckTask(ownTaskId),
        precheckTask(secondTaskId, { ownerId: "other-owner", member: false }),
      ],
    });
    const response = await f.run({ taskIds: [ownTaskId, secondTaskId], updates: { priority: "HIGH" } });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    // Nothing is written: the foreign task is not captured and the allowed task
    // is not partially updated either.
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(api.moved).not.toHaveBeenCalled();
    expect(api.updated).not.toHaveBeenCalled();
  });

  it("returns a safe 404 when one selected ID does not exist, without writing the rest", async () => {
    const f = fixture({ precheck: [precheckTask(ownTaskId)] });
    const response = await f.run({ taskIds: [ownTaskId, secondTaskId], updates: { priority: "HIGH" } });

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toMatch(/cm0000000000000000000002|other-owner/);
    expect(f.transaction).not.toHaveBeenCalled();
    expect(api.updated).not.toHaveBeenCalled();
  });

  it("rejects a column that belongs to another board before any task write", async () => {
    const f = fixture({ precheck: [precheckTask(ownTaskId)], columnProjectId: "another-board" });
    const response = await f.run({ taskIds: [ownTaskId], updates: { columnId: "column-two" } });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_TARGET_COLUMN");
    expect(f.calls).toEqual(["precheck-read", "transaction", "column-identity"]);
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(api.moved).not.toHaveBeenCalled();
  });

  it("rejects an empty updates object instead of reporting a no-op success", async () => {
    const f = fixture();
    const response = await f.run({ taskIds: [ownTaskId], updates: {} });

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(f.database.task.findMany).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("keeps the committed batch when a realtime emit fails", async () => {
    const f = fixture({ precheck: [precheckTask(ownTaskId)], emitFailure: true });
    const response = await f.run({ taskIds: [ownTaskId], updates: { priority: "HIGH" } });

    expect(response.status).toBe(200);
    expect(f.tx.task.update).toHaveBeenCalledWith({ where: { id: ownTaskId }, data: { priority: "HIGH" } });
    expect(api.updated).toHaveBeenCalled();
    expect(api.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "task.bulk.update.realtime.failed" }));
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private-transport/);
  });
});
