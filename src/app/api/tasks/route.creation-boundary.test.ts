import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  transaction: vi.fn(), project: vi.fn(), column: vi.fn(), auth: vi.fn(),
  emit: vi.fn(), automation: vi.fn(), diagnostic: vi.fn(), allocate: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: api.transaction,
  project: { findFirst: api.project },
  projectColumn: { findFirst: api.column },
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: api.auth,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: api.emit }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: api.automation }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: api.diagnostic, warn: api.diagnostic } }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response("{}", { status: 429 }),
}));
vi.mock("@/features/kanban/server/append-task-rank", () => ({
  allocateAppendRank: api.allocate,
  createGuardedAppendTaskRankPort: vi.fn(() => ({})),
  TaskRankMaintenanceError: class TaskRankMaintenanceError extends Error {},
}));
// This file isolates committed response/effects; authority and real rank coverage
// live in task-creation-port.test.ts and append-consumers.test.ts.
vi.mock("@/features/kanban/server/task-creation-port", () => ({
  prepareLegacyTaskCreation: async () => ({
    column: { id: "cm0000000000000000000002", workflowKey: "TODO" }, rank: await api.allocate(),
  }),
}));

import { POST } from "./route";

const projectId = "cm0000000000000000000001";
const columnId = "cm0000000000000000000002";
function makeRow() {
  return {
    id: "cm0000000000000000000003", projectId, columnId,
    title: "Synthetic created title", description: "synthetic-private-description",
    status: "TODO", priority: "MEDIUM", position: 1024,
    rank: "0|HZZZZZZZZZZZZZZZZZZZ", version: 0, createdById: "actor",
    createdAt: new Date("2026-10-21T10:00:00Z"),
    assignees: [{ userId: "actor", user: { id: "actor", name: "Synthetic actor", email: "synthetic@example.invalid", avatarUrl: null } }],
    tags: [{ tagId: "tag", tag: { id: "tag", name: "synthetic-private-tag", color: "#000000" } }],
    _count: { messages: 0 },
  };
}
type Row = ReturnType<typeof makeRow>;
const jsonRow = (row: Row) => JSON.parse(JSON.stringify(row));
const flushEffects = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture() {
  const row = makeRow(), expected = jsonRow(row), trace: string[] = [];
  let committed = false;
  const tx = { project:{findUnique:vi.fn(async()=>({name:"Техподдержка"}))},taskRequest:{create:vi.fn()}, activity: { create: vi.fn() }, task: {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(async () => { trace.push("create"); return row; }),
  } };
  api.transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<Row>) => {
    trace.push("begin");
    const result = await callback(tx);
    committed = true; trace.push("commit");
    return result;
  });
  api.emit.mockImplementation(() => { expect(committed).toBe(true); trace.push("emit"); });
  api.automation.mockImplementation(async () => { expect(committed).toBe(true); trace.push("automation"); });
  const run = () => POST(new Request("http://localhost/api/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, columnId, title: row.title, description: row.description }),
  }));
  const expectCommitted = async (response: Response) => {
    await flushEffects();
    expect(response.status).toBe(201);
    expect((await response.json()).data).toEqual(expected);
    expect(api.transaction).toHaveBeenCalledOnce(); expect(tx.task.create).toHaveBeenCalledOnce();
    expect(api.emit).toHaveBeenCalledOnce(); expect(api.automation).toHaveBeenCalledOnce();
  };
  return { row, expected, tx, trace, run, expectCommitted };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  api.project.mockResolvedValue({ id: projectId });
  api.column.mockResolvedValue({ id: columnId, workflowKey: "TODO" });
  api.allocate.mockResolvedValue("0|HZZZZZZZZZZZZZZZZZZZ");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("POST /api/tasks committed response boundary", () => {
  it("returns the transaction-created projection and invokes each effect once after commit", async () => {
    const f = fixture(); await f.expectCommitted(await f.run());
    expect(f.trace).toEqual(["begin", "create", "commit", "emit", "automation"]);
    expect(f.tx.task.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      projectId, columnId, createdById: "actor", priority: "MEDIUM", status: "TODO", position: 1024,
    }) }));
    expect(api.emit).toHaveBeenCalledWith(projectId, f.row);
    expect(api.automation).toHaveBeenCalledWith({
      trigger: "task_created", taskId: f.row.id, projectId, userId: "actor", task: f.row,
    });
  });

  it.each(["sync", "async"] as const)("keeps exact 201 and attempts automation after %s realtime failure", async mode => {
    const f = fixture();
    api.emit.mockImplementation(() => {
      if (mode === "sync") throw new Error("synthetic-private-realtime");
      return Promise.reject(new Error("synthetic-private-realtime"));
    });
    await f.expectCommitted(await f.run());
    expect(api.diagnostic).toHaveBeenCalled();
    expect(JSON.stringify(api.diagnostic.mock.calls)).not.toMatch(/synthetic-private|Synthetic created|synthetic@example/);
  });

  it.each(["sync", "async"] as const)("keeps exact 201 and avoids raw console output after %s automation failure", async mode => {
    const f = fixture(); const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    api.automation.mockImplementation(() => {
      if (mode === "sync") throw new Error("synthetic-private-automation");
      return Promise.reject(new Error("synthetic-private-automation"));
    });
    await f.expectCommitted(await f.run());
    expect(consoleError).not.toHaveBeenCalled(); expect(api.diagnostic).toHaveBeenCalled();
    expect(JSON.stringify(api.diagnostic.mock.calls)).not.toMatch(/synthetic-private|Synthetic created|synthetic@example/);
  });

  it.each(["sync", "async"] as const)("contains %s diagnostic failures after both independent effects fail", async mode => {
    const f = fixture(); const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = () => {
      if (mode === "sync") throw new Error("synthetic-private-sink");
      return Promise.reject(new Error("synthetic-private-sink"));
    };
    api.emit.mockImplementation(fail); api.automation.mockImplementation(fail); api.diagnostic.mockImplementation(fail);
    await f.expectCommitted(await f.run());
    expect(api.diagnostic).toHaveBeenCalledTimes(2); expect(consoleError).not.toHaveBeenCalled();
  });

  it("isolates nested realtime payload mutation from automation and exact committed response", async () => {
    const f = fixture(); let automationSnapshot: unknown;
    api.emit.mockImplementation((_project: string, payload: Row) => {
      payload.title = "mutated"; payload.tags[0].tag.name = "mutated";
      payload.assignees[0].user.email = "mutated"; payload._count.messages = 99;
    });
    api.automation.mockImplementation(async ({ task }: { task: Row }) => {
      automationSnapshot = jsonRow(task);
    });
    await f.expectCommitted(await f.run());
    expect(automationSnapshot).toEqual(f.expected);
    expect(api.emit.mock.calls[0][1]).not.toBe(api.automation.mock.calls[0][0].task);
    expect(api.emit.mock.calls[0][1].tags).not.toBe(api.automation.mock.calls[0][0].task.tags);
  });

  it("isolates nested automation payload mutation from exact committed response", async () => {
    const f = fixture();
    api.automation.mockImplementation(async ({ task }: { task: Row }) => {
      task.title = "mutated"; task.tags.length = 0; task.assignees[0].user.name = "mutated";
    });
    await f.expectCommitted(await f.run());
  });

  it("does not delay the response or automation behind a pending realtime promise", async () => {
    const f = fixture(); let release!: () => void;
    api.emit.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    const pendingResponse = f.run();
    try {
      const response = await Promise.race([pendingResponse, flushEffects().then(() => null)]);
      expect(response).not.toBeNull();
      expect(api.automation).toHaveBeenCalledOnce();
      await f.expectCommitted(response!);
    } finally { release(); await pendingResponse; }
  });

  it.each(["realtime", "automation"] as const)("contains a throwing then getter from the %s effect", async kind => {
    const f = fixture();
    const effect = kind === "realtime" ? api.emit : api.automation;
    effect.mockImplementation(() => Object.defineProperty({}, "then", {
      get() { throw new Error("synthetic-private-then-getter"); },
    }));
    await f.expectCommitted(await f.run());
    expect(api.diagnostic).toHaveBeenCalledOnce();
    expect(api.diagnostic).toHaveBeenCalledWith({ event: `task.create.${kind}.failed`, route: "/api/tasks" });
  });

  it("preserves Date values and isolates their mutation between both effect payloads", async () => {
    const f = fixture(); let realtimeWasDate = false, automationWasDate = false, automationTime: number | undefined;
    api.emit.mockImplementation((_project: string, task: Row) => {
      realtimeWasDate = task.createdAt instanceof Date;
      task.createdAt.setUTCFullYear(2000);
    });
    api.automation.mockImplementation(async ({ task }: { task: Row }) => {
      automationWasDate = task.createdAt instanceof Date;
      automationTime = task.createdAt.getTime(); task.createdAt.setUTCFullYear(1990);
    });
    await f.expectCommitted(await f.run());
    expect(realtimeWasDate).toBe(true); expect(automationWasDate).toBe(true);
    expect(automationTime).toBe(new Date(f.expected.createdAt).getTime());
    expect(f.row.createdAt.getTime()).toBe(new Date(f.expected.createdAt).getTime());
  });

  it.each(["create", "commit"] as const)("returns safe 500 and sends no effect on %s failure", async failure => {
    const f = fixture();
    if (failure === "create") f.tx.task.create.mockRejectedValue(new Error("synthetic-private-create"));
    else api.transaction.mockImplementation(async (callback: (client: typeof f.tx) => Promise<Row>) => {
      await callback(f.tx); throw new Error("synthetic-private-commit");
    });
    const response = await f.run(); await flushEffects();
    expect(response.status).toBe(500); expect(await response.text()).not.toMatch(/synthetic-private|Synthetic created/);
    expect(api.emit).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled();
    expect(api.transaction).toHaveBeenCalledOnce(); expect(f.tx.task.create).toHaveBeenCalledOnce();
  });
});

it("initializes a NEW server-classified BezNal marker to WAITING before any author file can exist",async()=>{
 const f=fixture();f.tx.project.findUnique.mockResolvedValue({name:"Безнал ОП"});
 expect((await f.run()).status).toBe(201);
 expect(f.tx.taskRequest.create).toHaveBeenCalledWith({data:expect.objectContaining({taskId:f.row.id,state:"DRAFT",beznalPhase:"WAITING",authorId:"actor"})});
 expect(f.tx.task.create.mock.invocationCallOrder[0]).toBeLessThan(f.tx.taskRequest.create.mock.invocationCallOrder[0]);
});
