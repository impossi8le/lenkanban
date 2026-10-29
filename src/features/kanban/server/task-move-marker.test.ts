import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
import { createBase36RankService, formatRank } from "../rank/rank-service";
import { moveTask } from "./move-task-service";
import { PrismaMoveRepository } from "./prisma-move-repository";
import { createCanonicalTaskRelocationPort, relocateTaskToColumn } from "./task-relocation";

const operationId = "b1e62929-6741-4860-a6a3-5f90b82d5a11";
const baseRanks = createBase36RankService();
type Row = { id: string; projectId: string; columnId: string; rank: string; position: number; version: number; status: string };
function fixture() {
  const rows: Row[] = [
    { id: "moving", projectId: "project", columnId: "source", rank: formatRank(100n), position: 1024, version: 2, status: "TODO" },
    { id: "source-sibling", projectId: "project", columnId: "source", rank: formatRank(200n), position: 2048, version: 0, status: "TODO" },
    { id: "destination-a", projectId: "project", columnId: "destination", rank: formatRank(100n), position: 1024, version: 0, status: "IN_PROGRESS" },
    { id: "destination-b", projectId: "project", columnId: "destination", rank: formatRank(200n), position: 2048, version: 0, status: "IN_PROGRESS" },
  ];
  const columns = [{ id: "source", projectId: "project", name: "Source", workflowKey: "TODO", position: 10 }, { id: "destination", projectId: "project", name: "Destination", workflowKey: "IN_PROGRESS", position: 90 }];
  const markers = new Map<string, unknown>(), operations = new Map<string, unknown>(), trace: string[] = [];
  // Rank/marker scenarios require a permitted legacy writer under mandatory OWN.
  let actor: { id: string; globalRole: "USER" | "ADMIN" } | null = { id: "actor", globalRole: "ADMIN" }, allowed = true, revision = 7;
  let afterLocks: (() => void | Promise<void>) | undefined;
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const query = sql.join("?");
      if (query.includes('FROM "User"')) { trace.push("actor-lock"); return actor ? [{ id: actor.id }] : []; }
      if (query.includes('FROM "ProjectColumn"')) { trace.push(query.includes("FOR UPDATE") ? "column-lock" : "column-read"); return (typeof values[0] === "string" ? columns.filter(column => column.id === values[0]) : columns).map(column => ({ ...column, precedingColumnId: columns.filter(candidate => candidate.projectId === column.projectId && candidate.position < column.position).toSorted((a, b) => b.position - a.position)[0]?.id ?? null })); }
      if (query.includes('FROM "Project"') && query.includes('"ResponsibleGroupMember"')) { trace.push("status-authority"); return actor ? [{ id: "group", userId: actor.id }] : []; }
      if (query.includes('FROM "Project"')) { trace.push("project-lock"); return [{ id: "project" }]; }
      if (query.includes('FROM "Task"')) {
        trace.push(query.includes("FOR UPDATE") ? "task-lock" : "identity");
        if (query.includes("FOR UPDATE")) await afterLocks?.();
        if (query.includes('WHERE "columnId" =')) return rows.filter(row => row.columnId === values[0]).toSorted((a, b) => a.id.localeCompare(b.id)).map(row => ({ ...row }));
        return typeof values[0] === "string" ? rows.filter(row => row.id === values[0]).map(row => ({ ...row })) : [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ ...row }));
      }
      throw Error("Unexpected fixture SQL");
    }),
    user: { findUnique: vi.fn(async () => { trace.push("fresh-actor"); return actor; }) },
    project: {
      findUnique: vi.fn(async () => { trace.push("project-access"); return { id: "project", ownerId: allowed ? "actor" : "other", members: [], responsibleGroup: { archivedAt: null, leaderId: "actor", members: allowed ? [{ userId: "actor" }] : [] } }; }),
      update: vi.fn(async () => ({ boardRevision: ++revision })),
    },
    projectColumn: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => columns.find(column => column.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; position: { lt: number } } }) => columns.filter(column => column.projectId === where.projectId && column.position < where.position.lt).toSorted((a, b) => b.position - a.position)[0] ?? null),
    },
    taskRequest: {
      findUnique: vi.fn(async ({ where }: { where: { taskId: string } }) => { trace.push("target-marker"); return markers.has(where.taskId) ? markers.get(where.taskId) : null; }),
      findMany: vi.fn(async ({ where }: { where: { taskId: { in: string[] } } }) => { trace.push("sibling-markers"); return where.taskId.in.filter(id => markers.has(id)).map(id => markers.get(id)); }),
    },
    task: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { trace.push("fresh-task"); const row = rows.find(row => row.id === where.id); return row ? { ...row } : null; }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...rows.find(row => row.id === where.id)! })),
      findMany: vi.fn(async ({ where }: { where: { columnId: string } }) => rows.filter(row => row.columnId === where.columnId).toSorted((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)).map(row => ({ ...row }))),
      findFirst: vi.fn(async ({ where, orderBy }: { where: { columnId: string }; orderBy: { rank?: string; position?: string } }) => rows.filter(row => row.columnId === where.columnId).toSorted((a, b) => orderBy.position ? b.position - a.position : b.rank.localeCompare(a.rank))[0] ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => { trace.push(data.rank?.startsWith("~") ? "TEMP-write" : "task-write"); const row = rows.find(row => row.id === where.id)!; Object.assign(row, data); return { ...row }; }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; version: number }; data: { version: { increment: number }; columnId: string; status: string; rank?: string; position?: number } }) => { const row = rows.find(row => row.id === where.id && row.version === where.version); if (!row) return { count: 0 }; const { version, ...changes } = data; Object.assign(row, changes); row.version += version.increment; return { count: 1 }; }),
    },
    taskMoveOperation: {
      findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => { trace.push("receipt-read"); return operations.get(where.operationId) ?? null; }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { operations.set(String(data.operationId), structuredClone(data)); return data; }),
    },
    activity: { create: vi.fn(async () => ({})) },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
  const repository = new PrismaMoveRepository({ $transaction: transaction } as never, { taskId: "moving", toColumnId: "destination", operationId, actorId: "actor" });
  const request = { operationId, expectedVersion: 2, toColumnId: "destination", beforeTaskId: "destination-a", afterTaskId: "destination-b" };
  const move = () => moveTask({ taskId: "moving", request, repository, ranks: baseRanks });
  const canonical = (toColumnId = "destination", ranks = baseRanks) => relocateTaskToColumn({ taskId: "moving", expectedProjectId: "project", toColumnId, expectedVersion: 2, operationId, ranks, port: createCanonicalTaskRelocationPort(tx as never, ranks, "actor") });
  function assertNoWrites() { for (const method of [tx.task.update, tx.task.updateMany, tx.project.update, tx.taskMoveOperation.create, tx.activity.create]) expect(method).not.toHaveBeenCalled(); expect(trace).not.toContain("TEMP-write"); }
  return { columns, rows, markers, operations, trace, tx, transaction, repository, request, move, canonical, assertNoWrites, setActor: (value: typeof actor) => { actor = value; }, setAllowed: (value: boolean) => { allowed = value; if (actor) actor.globalRole = value ? "ADMIN" : "USER"; }, afterLocks: (value: typeof afterLocks) => { afterLocks = value; } };
}
function marker(taskId: string) { return { taskId, contractVersion: 1, state: "DRAFT", authorId: "private-author", executorId: null }; }

describe("actual Prisma move repository request preflight and all rank writes", () => {
  it.each([false, true])("uses database column order for DONE through canonical=%s", async canonical => {
    const f = fixture();
    f.columns[1].workflowKey = "DONE";
    f.columns.push({ id: "resolved", projectId: "project", name: "Resolved", workflowKey: "REVIEW", position: 40 });
    await expect(canonical ? f.canonical() : f.move()).rejects.toMatchObject({ code: "INVALID_MOVE_ROUTE" });
    f.assertNoWrites();
    // A gap in numeric positions is valid: the nearest lower position wins.
    f.columns[0].position = 70;
    await expect(canonical ? f.canonical() : f.move()).resolves.toMatchObject({ task: { columnId: "destination", status: "DONE", version: 3 } });
  });

  it("replays a committed DONE entry without applying the route guard to historical state", async () => {
    const f = fixture(); f.columns[1].workflowKey = "DONE";
    const first = await f.move();
    f.columns.push({ id: "resolved", projectId: "project", name: "Resolved", workflowKey: "REVIEW", position: 40 });
    vi.clearAllMocks(); f.trace.length = 0;
    await expect(f.move()).resolves.toEqual(first);
    f.assertNoWrites();
  });
  it.each(["marked", "malformed"])("refuses %s target before receipt, including a historical replay", async kind => {
    const f = fixture(); await f.move(); const before = structuredClone(f.rows); vi.clearAllMocks(); f.trace.length = 0;
    f.markers.set("moving", kind === "marked" ? marker("moving") : { ...marker("moving"), rawSecret: "private" });
    await expect(f.move()).rejects.toMatchObject({ code: kind === "marked" ? "REQUEST_LIFECYCLE_NOT_ENABLED" : "INVALID_REQUEST_MARKER" });
    expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled(); f.assertNoWrites(); expect(f.rows).toEqual(before); expect(f.transaction).toHaveBeenCalledOnce();
  });
  it.each(["source-sibling", "destination-a", "destination-b"])("guards ordinary reordered sibling %s before the very first TEMP write", async sibling => {
    const f = fixture(), before = structuredClone(f.rows); f.markers.set(sibling, marker(sibling));
    await expect(f.move()).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); f.assertNoWrites(); expect(f.rows).toEqual(before);
  });
  it("refuses a marked sibling during a forced rank-gap rebalance before any temporary or final rank write", async () => {
    const f = fixture(); f.rows.find(row => row.id === "destination-b")!.rank = formatRank(101n); f.markers.set("destination-a", marker("destination-a"));
    await expect(f.move()).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); f.assertNoWrites();
  });
  it.each(["revoked", "missing-actor"])("rechecks %s after resource locks and before marker or receipt", async kind => {
    const f = fixture(); f.markers.set("moving", marker("moving")); f.afterLocks(() => { if (kind === "revoked") f.setAllowed(false); else f.setActor(null); });
    await expect(f.move()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" }); expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled(); expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled(); f.assertNoWrites();
  });
  it("takes actor SHARE before fresh actor/access and target marker", async () => {
    const f = fixture(); await f.move();
    expect(f.trace.indexOf("task-lock")).toBeLessThan(f.trace.indexOf("actor-lock")); expect(f.trace.indexOf("actor-lock")).toBeLessThan(f.trace.indexOf("fresh-actor"));
    expect(f.trace.indexOf("fresh-actor")).toBeLessThan(f.trace.indexOf("target-marker")); expect(f.trace.indexOf("target-marker")).toBeLessThan(f.trace.indexOf("receipt-read"));
    expect(f.tx.project.findUnique).not.toHaveBeenCalled(); // Common ADMIN policy needs no membership query.
  });

  it("denies a legacy nonmember under the real project policy before marker and writes", async () => {
    for (const canonical of [false, true]) {
      const f = fixture();
      f.setActor({ id: "actor", globalRole: "USER" });
      f.setAllowed(false);
      await expect(canonical ? f.canonical() : f.move()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(f.tx.project.findUnique).toHaveBeenCalled();
      expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled();
      f.assertNoWrites();
    }
  });
  it("preserves legacy owner writes under OWN while still running marker guards", async () => {
    for (const canonical of [false, true]) {
      const f = fixture();
      f.setActor({ id: "actor", globalRole: "USER" });
      await expect(canonical ? f.canonical() : f.move()).resolves.toMatchObject({
        boardRevision: 8,
        task: { id: "moving", columnId: "destination", status: "IN_PROGRESS", version: 3 },
      });
      expect(f.tx.project.findUnique).toHaveBeenCalled();
      expect(f.tx.taskRequest.findUnique).toHaveBeenCalledOnce();
      expect(f.tx.activity.create).toHaveBeenCalledOnce();
      expect(f.rows.find(row => row.id === "moving")).toMatchObject({ columnId: "destination", version: 3 });
    }
  });
  it("refuses a task ID outside the repository lock context before touching marker or receipt", async () => {
    const f = fixture(); await expect(moveTask({ taskId: "another-task", request: f.request, repository: f.repository, ranks: baseRanks })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled(); expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled(); f.assertNoWrites();
  });
  it("does not bypass marker validation for ADMIN or a malformed sibling", async () => {
    const f = fixture(); f.setActor({ id: "actor", globalRole: "ADMIN" }); f.markers.set("destination-a", { ...marker("destination-a"), executorId: "invalid-shape" });
    await expect(f.move()).rejects.toMatchObject({ code: "INVALID_REQUEST_MARKER" }); f.assertNoWrites();
  });
  it("does not run sibling maintenance on a successful legacy replay", async () => {
    const f = fixture(); const first = await f.move(); f.markers.set("source-sibling", marker("source-sibling")); vi.clearAllMocks(); f.trace.length = 0;
    expect(await f.move()).toEqual(first); expect(f.tx.taskRequest.findUnique).toHaveBeenCalledOnce(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); f.assertNoWrites();
  });
  it.each(["target-storage", "sibling-storage", "missing-delegate"])("propagates %s without fallback or retries/writes", async kind => {
    const f = fixture(), failure = Error("synthetic request storage failure");
    if (kind === "target-storage") f.tx.taskRequest.findUnique.mockRejectedValue(failure); else if (kind === "sibling-storage") f.tx.taskRequest.findMany.mockRejectedValue(failure); else Reflect.deleteProperty(f.tx, "taskRequest");
    if (kind === "missing-delegate") await expect(f.move()).rejects.toBeInstanceOf(Error); else await expect(f.move()).rejects.toBe(failure);
    f.assertNoWrites(); expect(f.transaction).toHaveBeenCalledOnce();
  });
});

describe("actual canonical relocation preflight before same-column and append/rebalance", () => {
  it.each(["source", "destination"])("blocks a marked target moving to %s, including same-column/no-op", async destination => {
    const f = fixture(); f.markers.set("moving", marker("moving")); await expect(f.canonical(destination)).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); f.assertNoWrites();
    expect(f.tx.task.findFirst).not.toHaveBeenCalled();
  });
  it("blocks malformed target before allocation", async () => {
    const f = fixture(); f.markers.set("moving", undefined); await expect(f.canonical()).rejects.toMatchObject({ code: "INVALID_REQUEST_MARKER" }); f.assertNoWrites(); expect(f.tx.task.findFirst).not.toHaveBeenCalled();
  });
  it("checks fresh revoked access before marker and does not replace automation actor with a system bypass", async () => {
    const f = fixture(); f.setAllowed(false); f.markers.set("moving", marker("moving"));
    await expect(f.canonical()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" }); expect(f.tx.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "actor" } })); expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled(); f.assertNoWrites();
  });
  it("locks destination tasks and guards a marked sibling before the existing append rebalance writes", async () => {
    const f = fixture(); f.markers.set("destination-a", marker("destination-a"));
    const ranks = { ...baseRanks, between: vi.fn().mockReturnValueOnce(null).mockReturnValue(formatRank(500n)) };
    await expect(f.canonical("destination", ranks)).rejects.toMatchObject({ code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); f.assertNoWrites();
    expect(f.tx.$queryRaw.mock.calls.some(([query]) => /FROM "Task"[\s\S]*ORDER BY "id"[\s\S]*FOR UPDATE/.test(query.join("?")))).toBe(true);
    expect(f.trace.lastIndexOf("task-lock")).toBeLessThan(f.trace.indexOf("actor-lock"));
  });
  it("keeps unmarked canonical append math, status, version and Activity unchanged", async () => {
    const f = fixture(); const result = await f.canonical(); expect(result).toMatchObject({ boardRevision: 8, task: { id: "moving", columnId: "destination", version: 3, status: "IN_PROGRESS" } });
    const moved = f.rows.find(row => row.id === "moving")!; expect(moved.rank).toBe(baseRanks.between(formatRank(200n), null)); expect(moved.position).toBe(3072); expect(f.tx.activity.create).toHaveBeenCalledOnce();
    expect(f.trace.lastIndexOf("task-lock")).toBeLessThan(f.trace.indexOf("actor-lock"));
  });
  it.each(["missing-delegate", "database-error"])("fails closed on canonical %s without allocation", async kind => {
    const f = fixture(), failure = Error("synthetic marker database failure");
    if (kind === "missing-delegate") Reflect.deleteProperty(f.tx, "taskRequest"); else f.tx.taskRequest.findUnique.mockRejectedValue(failure);
    if (kind === "missing-delegate") await expect(f.canonical()).rejects.toBeInstanceOf(Error); else await expect(f.canonical()).rejects.toBe(failure);
    f.assertNoWrites(); expect(f.tx.task.findFirst).not.toHaveBeenCalled();
  });
});
