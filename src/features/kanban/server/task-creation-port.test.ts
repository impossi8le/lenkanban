import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBase36RankService, formatRank, RANK_MAX } from "../rank/rank-service";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { TaskRankMaintenanceError } from "./append-task-rank";
import { prepareLegacyTaskCreation } from "./task-creation-port";

const outside = vi.hoisted(() => ({ project: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findUnique: outside.project } } }));

const projectId = "project", columnId = "column", actorId = "actor";
const ranks = createBase36RankService();
function fixture(exhausted = false) {
  const state = {
    // Ordinary submission uses its own capability; fixtures default to ADMIN for rank tests.
    actor: { id: actorId, globalRole: "ADMIN" } as { id: string; globalRole: string; isBlocked?: boolean; blockedAt?: Date | null } | null,
    project: { id: projectId, ownerId: actorId, members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{ id: columnId }] } as { id: string; ownerId: string; departmentId?: string; department?: { id: string; archivedAt: Date | null }; responsibleGroup: null | { archivedAt: Date | null; members: { userId: string }[] }; columns: { id: string }[]; members: { role: string }[]; applicantPolicyConfig: null | { policy: unknown } } | null,
    column: { id: columnId, projectId, workflowKey: "TODO" } as { id: string; projectId: string; workflowKey: string } | null,
    rows: [{ id: "b", rank: formatRank(100n) }, { id: "a", rank: formatRank(exhausted ? RANK_MAX - 1n : 200n) }],
    markers: [] as unknown[],
  };
  const trace: string[] = [];
  const options = { gate: "", lockRows: undefined as unknown, actualRows: undefined as unknown, raw: {} as Record<string, unknown>, lastRead: 0, exhaustSecondRead: false };
  let entered!: () => void, release!: () => void;
  const gateEntered = new Promise<void>(resolve => { entered = resolve; });
  const gateReleased = new Promise<void>(resolve => { release = resolve; });
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      const lock = sql.includes('FROM "ProjectColumn"') ? "column" : sql.includes('FROM "Project"') ? "project" : sql.includes('FROM "Task"') ? "task" : sql.includes('FROM "User"') ? "actor" : sql.includes('FROM "Department"') ? "department" : "unknown";
      trace.push(`${lock}-lock`);
      if (options.gate === lock) { entered(); await gateReleased; }
      if (Object.hasOwn(options.raw, lock)) return options.raw[lock];
      if (lock === "project") return state.project ? [{ id: state.project.id }] : [];
      if (lock === "column") return state.column ? [structuredClone(state.column)] : [];
      if (lock === "task") return options.lockRows ?? [...state.rows].sort((a, b) => a.id.localeCompare(b.id)).map(({ id }) => ({ id }));
      if (lock === "actor") return state.actor ? [{ id: state.actor.id }] : [];
      if (lock === "department") return [{ id: state.project?.departmentId }];
      throw new Error("Unexpected synthetic query");
    }),
    user: { findUnique: vi.fn(async () => { trace.push("actor-read"); return state.actor && { ...state.actor }; }) },
    project: { findUnique: vi.fn(async () => { trace.push("access-read"); return state.project && structuredClone(state.project); }) },
    task: {
      findFirst: vi.fn(async () => {
        trace.push("rank-read"); options.lastRead++;
        if (options.exhaustSecondRead && options.lastRead > 1) return { rank: formatRank(RANK_MAX - 1n) };
        return state.rows.length ? { rank: state.rows.at(-1)!.rank } : null;
      }),
      findMany: vi.fn(async () => { trace.push("actual-set"); return options.actualRows ?? state.rows.map(({ id }) => ({ id })); }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { rank: string } }) => {
        trace.push(data.rank.startsWith("~") ? "TEMP" : "FINAL");
        state.rows.find(row => row.id === where.id)!.rank = data.rank;
      }),
    },
    taskRequest: { findMany: vi.fn(async () => { trace.push("marker"); return state.markers; }) },
  };
  const run = () => prepareLegacyTaskCreation(tx as never, ranks, { actorId, projectId, columnId });
  return { state, options, trace, tx, run, gateEntered, release };
}
beforeEach(() => { vi.clearAllMocks(); outside.project.mockImplementation(() => { throw new Error("Global access reader forbidden"); }); });

describe("prepareLegacyTaskCreation with real common access and append allocator", () => {
  it("denies an applicant's later column before exhausted-rank maintenance writes", async () => {
    const f = fixture(true); f.state.actor!.globalRole = "USER";
    f.state.project!.columns = [{ id: "canonical-initial" }];
    await expect(f.run()).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });
  it("checks ordinary append authority after parent locks without sibling locks or marker reads", async () => {
    const f = fixture(); const result = await f.run();
    expect(result).toEqual({ column: { id: columnId, workflowKey: "TODO" }, rank: ranks.between(formatRank(200n), null) });
    expect(f.trace).toEqual(["project-lock", "column-lock", "rank-read", "actor-lock", "actor-read", "access-read", "rank-read"]);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
    expect(outside.project).not.toHaveBeenCalled();
    const queries = f.tx.$queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][];
    expect(queries).toHaveLength(3);
    expect(queries[0][0].join("?")).toMatch(/FROM "Project"[\s\S]*FOR UPDATE/); expect(queries[0].slice(1)).toEqual([projectId]);
    expect(queries[1][0].join("?")).toMatch(/FROM "ProjectColumn"[\s\S]*FOR UPDATE/); expect(queries[1].slice(1)).toEqual([columnId, projectId]);
    expect(queries[2][0].join("?")).toMatch(/FROM "User"[\s\S]*FOR SHARE/); expect(queries[2].slice(1)).toEqual([actorId]);
  });

  it("locks sibling IDs before actor and checks actual write set/markers before real rebalance writes", async () => {
    const f = fixture(true), before = structuredClone(f.state.rows);
    const result = await f.run(); const expected = ranks.rebalance(before.map(row => row.id));
    expect(f.state.rows.map(row => row.rank)).toEqual(before.map(row => expected.get(row.id)));
    expect(result.rank).toBe(ranks.between(expected.get(before.at(-1)!.id)!, null));
    expect(f.trace).toEqual(["project-lock", "column-lock", "rank-read", "task-lock", "actor-lock", "actor-read", "access-read", "rank-read", "actual-set", "marker", "TEMP", "TEMP", "FINAL", "FINAL"]);
    expect(f.tx.task.update).toHaveBeenCalledTimes(4);
  });

  it.each(["project", "column", "task"])("uses revoked actor after waiting for %s lock and performs no writes", async lock => {
    const f = fixture(lock === "task"); f.options.gate = lock;
    const pending = f.run(); await f.gateEntered; f.state.actor = null; f.release();
    await expect(pending).rejects.toBeInstanceOf(NotFoundError);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });

  it.each(["owner", "MEMBER", "PROJECT_ADMIN", "ADMIN", "demoted-member"])("permits legacy submission independently of task mutation rights for %s", async kind => {
    const f = fixture();
    if (kind !== "owner") f.state.project!.ownerId = "someone-else";
    f.state.actor!.globalRole = kind === "ADMIN" ? "ADMIN" : "USER";
    if (["MEMBER", "PROJECT_ADMIN", "demoted-member"].includes(kind)) f.state.project!.members = [{ role: kind === "PROJECT_ADMIN" ? "PROJECT_ADMIN" : "MEMBER" }];
    await expect(f.run()).resolves.toHaveProperty("rank");
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });

  it("uses the saved applicant policy to permit an outsider's submission", async () => {
    const f = fixture(); f.state.actor!.globalRole = "USER"; f.state.project!.ownerId = "other";
    f.state.project!.applicantPolicyConfig = { policy: { allEmployees: true, userIds: [], departmentIds: [], groupIds: [] } };
    await expect(f.run()).resolves.toHaveProperty("rank");
    expect(f.tx.project.findUnique).toHaveBeenCalledTimes(3);
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });
  it("saved nobody denies even an ordinary owner before rank maintenance writes", async () => {
    const f = fixture(true); f.state.actor!.globalRole = "USER";
    f.state.project!.applicantPolicyConfig = { policy: { allEmployees: false, userIds: [], departmentIds: [], groupIds: [] } };
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundError);
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });

  it.each(["outsider", "VIEWER", "unknown", "demoted-admin"])("denies fresh %s membership even when initial lookup was allowed", async kind => {
    const f = fixture(true); f.state.project!.ownerId = "someone-else";
    f.state.actor!.globalRole = "USER";
    if (kind === "VIEWER" || kind === "unknown") f.state.project!.members = [{ role: kind }];
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundError);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });

  it("also checks authority for an empty destination", async () => {
    const f = fixture(); f.state.rows = []; f.state.project!.ownerId = "other";
    f.state.actor!.globalRole = "USER";
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundError);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.trace).not.toContain("task-lock");
  });

  it.each(["deleted", "moved"])("rejects the selected %s column without selecting another one", async kind => {
    const f = fixture();
    if (kind === "deleted") f.state.column = null; else f.state.column!.projectId = "other";
    await expect(f.run()).rejects.toBeInstanceOf(BadRequestError);
    expect(f.tx.user.findUnique).not.toHaveBeenCalled(); expect(f.tx.task.update).not.toHaveBeenCalled();
  });

  it("returns a copied fresh workflow key obtained after the column lock wait", async () => {
    const f = fixture(); f.options.gate = "column";
    const pending = f.run(); await f.gateEntered; f.state.column!.workflowKey = "DONE"; f.release();
    const result = await pending; expect(result.column).toEqual({ id: columnId, workflowKey: "DONE" });
    f.state.column!.workflowKey = "TODO"; expect(result.column.workflowKey).toBe("DONE");
  });

  it.each(["valid", "malformed"])("denies exhausted append with a %s marker before TEMP writes", async kind => {
    const f = fixture(true); f.state.markers = [{ taskId: "a", contractVersion: kind === "valid" ? 1 : 99, state: "DRAFT", authorId: "private-author", executorId: null }];
    await expect(f.run()).rejects.toBeInstanceOf(TaskRankMaintenanceError);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.trace.indexOf("actor-read")).toBeLessThan(f.trace.indexOf("marker"));
  });

  it.each(["unknown", "duplicate", "getter"])("rejects a %s actual maintenance set before marker or writes", async kind => {
    const f = fixture(true);
    f.options.actualRows = kind === "unknown" ? [{ id: "unheld" }] : kind === "duplicate" ? [{ id: "a" }, { id: "a" }] : [Object.defineProperty({}, "id", { get() { throw new Error("private-getter"); } })];
    await expect(f.run()).rejects.toBeInstanceOf(Error);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });

  it("refuses unexpected maintenance after actor lock instead of acquiring late sibling locks", async () => {
    const f = fixture(); f.options.exhaustSecondRead = true;
    await expect(f.run()).rejects.toBeInstanceOf(Error);
    expect(f.trace).not.toContain("task-lock"); expect(f.tx.task.update).not.toHaveBeenCalled();
  });

  it("does not inspect markers of an untouched sibling on ordinary append", async () => {
    const f = fixture(); f.state.markers = [{ taskId: "a", contractVersion: 99 }];
    await expect(f.run()).resolves.toHaveProperty("rank"); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });

  it.each(["project", "column", "actor"])("rejects duplicate raw %s lock rows before any write", async resource => {
    const f = fixture(true);
    const row = resource === "column" ? { id: columnId, projectId, workflowKey: "TODO" } : { id: resource === "actor" ? actorId : projectId };
    f.options.raw[resource] = [row, row];
    await expect(f.run()).rejects.toBeInstanceOf(Error);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });
  it.each(["project", "column", "actor"])("rejects malformed raw %s lock result before any write", async resource => {
    const f = fixture(true); f.options.raw[resource] = [{ id: "wrong", unexpected: "synthetic" }];
    await expect(f.run()).rejects.toBeInstanceOf(Error);
    expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });
  it.each(["identity", "role"])("denies fresh actor %s mismatch", async kind => {
    const f = fixture(true);
    f.tx.user.findUnique.mockResolvedValue(kind === "identity" ? { id: "different", globalRole: "ADMIN" } : { id: actorId, globalRole: "UNSUPPORTED" });
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundError);
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });
  it.each(["duplicate", "malformed"])("rejects %s sibling lock IDs before actor and writes", async kind => {
    const f = fixture(true); f.options.lockRows = kind === "duplicate" ? [{ id: "a" }, { id: "a" }] : [{ id: 12 }];
    await expect(f.run()).rejects.toBeInstanceOf(Error);
    expect(f.tx.user.findUnique).not.toHaveBeenCalled(); expect(f.tx.task.update).not.toHaveBeenCalled();
  });
  it("supports a maintenance set larger than 200 through the existing bounded marker chunks", async () => {
    const f = fixture(true);
    f.state.rows = Array.from({ length: 201 }, (_, n) => ({ id: `task-${String(n).padStart(3, "0")}`, rank: formatRank(BigInt(n + 1)) }));
    f.state.rows.at(-1)!.rank = formatRank(RANK_MAX - 1n);
    await expect(f.run()).resolves.toHaveProperty("rank");
    expect(f.tx.taskRequest.findMany).toHaveBeenCalledTimes(2);
    for (const [input] of f.tx.taskRequest.findMany.mock.calls as unknown as [{ where: { taskId: { in: string[] } } }][]) expect(input.where.taskId.in.length).toBeLessThanOrEqual(200);
    expect(f.tx.task.update).toHaveBeenCalledTimes(402);
  });
});


describe("active department submission locks with the real common creation policy", () => {
  function departmentFixture() {
    const f=fixture();f.state.actor={id:actorId,globalRole:"USER",isBlocked:false,blockedAt:null};
    Object.assign(f.state.project!,{ownerId:"someone-else",members:[],departmentId:"department",department:{id:"department",archivedAt:null},applicantPolicyConfig:{policy:{allEmployees:false,userIds:[],departmentIds:[],groupIds:[]}}});
    return f;
  }
  it("lets an unrelated active USER append to the initial column after locking the destination department",async()=>{
    const f=departmentFixture();await expect(f.run()).resolves.toHaveProperty("rank");
    expect(f.trace.indexOf("department-lock")).toBeGreaterThan(f.trace.indexOf("actor-lock"));
    expect(f.trace.indexOf("department-lock")).toBeLessThan(f.trace.lastIndexOf("rank-read"));
    const lock=f.tx.$queryRaw.mock.calls.find(([parts])=>parts.join("?").includes('FROM "Department"'))!;
    expect(lock[0].join("?")).toContain("FOR SHARE");
    expect(f.state.actor!.globalRole).toBe("USER");expect(f.tx.task.update).not.toHaveBeenCalled();
  });
  it.each(["archive","block"])("rechecks fresh %s after the department lock wait before any rank writes",async kind=>{
    const f=departmentFixture();f.options.gate="department";
    const running=f.run();await f.gateEntered;
    if(kind==="archive")f.state.project!.department!.archivedAt=new Date();else f.state.actor!.isBlocked=true;
    f.release();await expect(running).rejects.toBeInstanceOf(NotFoundError);expect(f.tx.task.update).not.toHaveBeenCalled();
  });
  it("still rejects a later column for an ordinary active employee",async()=>{
    const f=departmentFixture();f.state.project!.columns=[{id:"initial-other"}];
    await expect(f.run()).rejects.toMatchObject({name:"ForbiddenError"});expect(f.tx.task.update).not.toHaveBeenCalled();
  });
});
