import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBase36RankService, formatRank, RANK_MAX } from "@/features/kanban/rank/rank-service";
const api = vi.hoisted(() => ({ transaction: vi.fn(), auth: vi.fn(), project: vi.fn(), column: vi.fn(), template: vi.fn(), complete: vi.fn(), candidates: vi.fn(), checklist: vi.fn(), tagFind: vi.fn(), tagCreate: vi.fn(), tagLink: vi.fn(), emit: vi.fn(), automation: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: api.transaction, project: { findFirst: api.project, findUnique: async () => ({ownerId: "actor", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{id: columnId}]}) }, projectColumn: { findFirst: api.column }, taskTemplate: { findUnique: api.template }, task: { findUnique: api.complete }, recurringTask: { findMany: api.candidates }, taskChecklistItem: { createMany: api.checklist }, tag: { findFirst: api.tagFind, create: api.tagCreate }, taskTag: { create: api.tagLink } } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: api.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: api.info, warn: api.warn, error: api.error } }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: api.emit }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: api.automation }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response("{}", { status: 429 }) }));
import { POST as createTask } from "./route";
import { POST as templatePOST } from "../templates/[id]/use/route";
import { POST as cron } from "../recurring-tasks/process/route";
import { processRecurringOccurrence } from "@/lib/recurring-processor";

const projectId = "cm0000000000000000000001", columnId = "cm0000000000000000000002";
const now = new Date("2027-01-10T11:00:00Z"), scheduledAt = new Date("2027-01-10T10:00:00Z");
const ranks = createBase36RankService();
function harness(project = projectId, recurrence = "recurring") {
  const localColumnId = project === projectId ? columnId : `column-${project}`;
  const rows = [{ id: `sibling-a-${project}`, rank: formatRank(100n), position: 1024 }, { id: `sibling-b-${project}`, rank: formatRank(RANK_MAX - 1n), position: 2048 }];
  const markers = new Map<string, unknown>(), trace: string[] = [];
  let created: Record<string, unknown> = { id: `created-${project}`, projectId: project };
  const stored = { id: recurrence, name: "Synthetic recurrence", description: null, projectId: project, taskTitle: "Synthetic created title", taskDescription: "Synthetic description", priority: "HIGH", tags: ["Synthetic tag"], checklistItems: [{ text: "Synthetic check", completed: false }], assigneeIds: ["actor"], frequency: "daily", interval: 1, daysOfWeek: [], dayOfMonth: null, startDate: scheduledAt, endDate: null as Date | null, nextRunAt: scheduledAt, active: true, lastRunAt: null, createdById: "actor", createdAt: scheduledAt, updatedAt: scheduledAt };
  const tx = {
    activity: { create: vi.fn() },
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      const text = sql.join("?"); trace.push(text.includes('FROM "Task"') ? "task-lock" : text.includes('FROM "ProjectColumn"') ? "column-lock" : text.includes('FROM "User"') ? "actor-lock" : text.includes('FROM "RecurringTask"') ? "schedule-lock" : "project-lock");
      if (text.includes('FROM "Task"')) return [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id }));
      if (text.includes('FROM "User"')) return [{ id: "actor" }];
      if (text.includes('FROM "ProjectColumn"')) return [{ id: localColumnId, projectId: project, workflowKey: "TODO" }];
      if (text.includes('FROM "Project"')) return [{ id: project }];
      return [{ id: localColumnId, projectId: project }];
    }),
    task: {
      findFirst: vi.fn(async ({ orderBy }: { orderBy: { position?: string } }) => orderBy.position ? { position: Math.max(...rows.map(row => row.position)) } : { rank: [...rows].sort((a, b) => b.rank.localeCompare(a.rank))[0].rank }),
      findMany: vi.fn(async () => [...rows].sort((a, b) => a.rank.localeCompare(b.rank)).map(row => ({ id: row.id }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { rank: string } }) => { trace.push(data.rank.startsWith("~") ? "TEMP" : "FINAL"); const row = rows.find(row => row.id === where.id)!; row.rank = data.rank; return row; }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { trace.push("create-task"); created = { ...created, ...data }; return created; }),
      findUnique: vi.fn(async () => ({ ...created, assignees: [], tags: [], checklistItems: [] })),
      findUniqueOrThrow: vi.fn(async () => ({ ...created, assignees: [], tags: [], checklistItems: [] })),
    },
    taskRequest: { findMany: vi.fn(async ({ where }: { where: { taskId: { in: string[] } } }) => { trace.push("marker-batch"); return where.taskId.in.filter(id => markers.has(id)).map(id => markers.get(id)); }) },
    user: { findUnique: vi.fn(async () => ({ id: "actor", globalRole: "USER" })) },
    project: { findUnique: vi.fn(async () => ({ id: project, ownerId: "actor", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{id: localColumnId}] })) },
    recurringTask: { findUnique: vi.fn(async () => stored), update: vi.fn(async () => ({})) },
    recurringTaskOccurrence: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    projectColumn: { findFirst: vi.fn().mockResolvedValue({ id: localColumnId, workflowKey: "TODO" }) },
    taskChecklistItem: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    taskAssignee: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    tag: { upsert: vi.fn().mockResolvedValue({ id: "tag" }), findFirst: vi.fn().mockResolvedValue({ id: "tag" }), create: vi.fn().mockResolvedValue({ id: "tag" }) }, taskTag: { create: vi.fn().mockResolvedValue({}) },
  };
  function denyWrites() {
    for (const method of [tx.task.update, tx.task.create, tx.taskChecklistItem.createMany, tx.taskAssignee.createMany, tx.tag.upsert, tx.tag.create, tx.taskTag.create, tx.recurringTaskOccurrence.create, tx.recurringTask.update, api.checklist, api.tagCreate, api.tagLink, api.emit, api.automation]) expect(method).not.toHaveBeenCalled();
  }
  function mark(shape: "valid" | "malformed") { const taskId = rows[1].id; markers.set(taskId, { taskId, contractVersion: shape === "valid" ? 1 : 99, state: "DRAFT", authorId: "synthetic-private-author", executorId: null }); }
  const direct = () => processRecurringOccurrence({ database: { $transaction: api.transaction } as never, candidate: { id: recurrence, projectId: project, scheduledAt }, now });
  return { tx, rows, markers, trace, stored, mark, denyWrites, direct, created: () => created };
}
type Harness = ReturnType<typeof harness>;
let active: Harness;
function request(body: unknown) { return new Request("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function invoke(kind: "task" | "template" | "recurring") {
  if (kind === "task") return createTask(request({ projectId, columnId, title: "Synthetic created title" }));
  if (kind === "template") return templatePOST(request({}), { params: Promise.resolve({ id: "template" }) });
  return active.direct();
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); vi.stubEnv("CRON_SECRET", "synthetic-append-cron"); vi.stubEnv("TELEMETRY_ENABLED", "false");
  active = harness(); api.transaction.mockImplementation(async callback => callback(active.tx));
  api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); api.project.mockResolvedValue({ id: projectId }); api.column.mockResolvedValue({ id: columnId, workflowKey: "TODO" });
  api.template.mockResolvedValue({ id: "template", projectId, templateTitle: "Synthetic created title", templateDescription: "Synthetic description", priority: "HIGH", checklistItems: [{ text: "Synthetic check", completed: false }], tags: ["Synthetic tag"], project: { ownerId: "actor", members: [] } });
  api.complete.mockImplementation(async () => active.created()); api.automation.mockResolvedValue(undefined); api.tagFind.mockResolvedValue({ id: "tag" }); api.candidates.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each(["task", "template", "recurring"] as const)("real %s append consumer with unmocked allocator and guard", kind => {
  it.each(["valid", "malformed"] as const)("refuses exhausted append beside %s marker before any write or effect", async shape => {
    active.mark(shape); const before = structuredClone(active.rows); const code = shape === "valid" ? "REQUEST_LIFECYCLE_NOT_ENABLED" : "INVALID_REQUEST_MARKER";
    if (kind === "recurring") await expect(invoke(kind)).rejects.toMatchObject({ code });
    else { const response = await invoke(kind) as Response; expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code } }); }
    active.denyWrites(); expect(active.rows).toEqual(before); expect(api.transaction).toHaveBeenCalledOnce(); expect(active.tx.taskRequest.findMany).toHaveBeenCalledOnce();
    expect(active.trace.indexOf("task-lock")).toBeLessThan(active.trace.indexOf("marker-batch"));
  });
  it.each(["database", "delegate", "held-set"])("fails safely on exhausted append %s failure", async failure => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    if (failure === "database") active.tx.taskRequest.findMany.mockRejectedValue(Error("synthetic-private-storage"));
    else if (failure === "delegate") Reflect.deleteProperty(active.tx, "taskRequest");
    else {
      const original = active.tx.$queryRaw.getMockImplementation()!;
      active.tx.$queryRaw.mockImplementation(async sql => sql.join("?").includes('FROM "Task"') ? [] : original(sql));
    }
    if (kind === "recurring") await expect(invoke(kind)).rejects.toBeInstanceOf(Error);
    else { const response = await invoke(kind) as Response; expect(response.status).toBe(500); expect(await response.text()).not.toMatch(/synthetic-private|authorId|executorId/); }
    active.denyWrites(); if (kind === "template") expect(consoleError).not.toHaveBeenCalled();
  });
  it("allows ordinary append without looking up or locking untouched marked siblings", async () => {
    active.rows[1].rank = formatRank(200n); active.mark("valid"); const result = await invoke(kind);
    if (kind !== "recurring") expect((result as Response).status).toBe(201); else expect(result).toMatchObject({ status: "created" });
    expect(active.tx.taskRequest.findMany).not.toHaveBeenCalled(); expect(active.tx.task.update).not.toHaveBeenCalled(); expect(active.trace).not.toContain("task-lock");
    expect(active.created()).toMatchObject({ rank: ranks.between(formatRank(200n), null), position: kind === "task" ? 3072 : 2049 });
  });
  it("preserves actual legacy rebalance rank math and creation after whole-set permission", async () => {
    const result = await invoke(kind); if (kind !== "recurring") expect((result as Response).status).toBe(201); else expect(result).toMatchObject({ status: "created" });
    const expected = ranks.rebalance(active.rows.map(row => row.id)); expect(active.rows.map(row => row.rank)).toEqual(active.rows.map(row => expected.get(row.id)));
    expect(active.created().rank).toBe(ranks.between(expected.get(active.rows[1].id)!, null)); expect(active.tx.task.update).toHaveBeenCalledTimes(4);
    expect(active.trace.indexOf("marker-batch")).toBeLessThan(active.trace.indexOf("TEMP")); expect(active.tx.task.create).toHaveBeenCalledOnce();
  });
});

describe("real cron keeps candidate isolation and closed maintenance failures", () => {
  it.each(["valid", "malformed"] as const)("continues a good occurrence after a %s denied one with no inner retry", async shape => {
    const bad = harness(projectId, "bad"), good = harness("cm0000000000000000000003", "good"); bad.mark(shape); good.rows[1].rank = formatRank(200n);
    api.candidates.mockResolvedValue([bad, good].map(h => ({ id: h.stored.id, projectId: h.stored.projectId, nextRunAt: scheduledAt })));
    api.transaction.mockImplementationOnce(async callback => callback(bad.tx)).mockImplementationOnce(async callback => callback(good.tx));
    const response = await cron(new Request("http://localhost/api/recurring-tasks/process", { method: "POST", headers: { authorization: "Bearer synthetic-append-cron" } }));
    expect(response.status).toBe(200); const payload = await response.json(); expect(payload).toEqual({ success: true, data: { processed: 2, results: [{ recurringTaskId: "bad", success: false, error: "Recurring occurrence failed" }, { recurringTaskId: "good", taskId: `created-${good.stored.projectId}`, success: true }] } });
    for (const method of [bad.tx.task.update, bad.tx.task.create, bad.tx.taskChecklistItem.createMany, bad.tx.taskAssignee.createMany, bad.tx.tag.upsert, bad.tx.taskTag.create, bad.tx.recurringTaskOccurrence.create, bad.tx.recurringTask.update]) expect(method).not.toHaveBeenCalled();
    expect(api.transaction).toHaveBeenCalledTimes(2); expect(bad.tx.recurringTask.findUnique).toHaveBeenCalledOnce(); expect(good.tx.task.create).toHaveBeenCalledOnce(); expect(good.tx.recurringTaskOccurrence.create).toHaveBeenCalledOnce(); expect(good.tx.recurringTask.update).toHaveBeenCalledOnce();
    expect(api.emit).toHaveBeenCalledExactlyOnceWith(good.stored.projectId, expect.objectContaining({ id: `created-${good.stored.projectId}` }));
    const failed = api.error.mock.calls.map(([record]) => record).filter(record => record.event === "job.failed"); expect(failed).toHaveLength(1); expect(failed[0]).toMatchObject({ recurringTaskId: "bad", errorCode: shape === "valid" ? "REQUEST_LIFECYCLE_NOT_ENABLED" : "INVALID_REQUEST_MARKER" });
    expect(JSON.stringify(payload)).not.toMatch(/synthetic-private|authorId|executorId|contractVersion/); expect(failed[0]).not.toHaveProperty("authorId"); expect(failed[0]).not.toHaveProperty("executorId");
  });
  it.each(["replay", "expired", "inactive", "not_due", "missing"])("keeps %s shortcut free of marker reads or rank writes", async shortcut => {
    active.mark("valid");
    if (shortcut === "replay") active.tx.recurringTaskOccurrence.findUnique.mockResolvedValue({ taskId: "historical" });
    if (shortcut === "expired") { active.stored.startDate = new Date("2027-01-09T10:00:00Z"); active.stored.endDate = new Date("2027-01-10T09:00:00Z"); }
    if (shortcut === "inactive") active.stored.active = false;
    if (shortcut === "not_due") vi.setSystemTime(new Date("2027-01-10T09:00:00Z"));
    if (shortcut === "missing") active.tx.recurringTask.findUnique.mockResolvedValue(null as never);
    const result = shortcut === "not_due" ? await processRecurringOccurrence({ database: { $transaction: api.transaction } as never, candidate: { id: "recurring", projectId, scheduledAt }, now: new Date("2027-01-10T09:00:00Z") }) : await active.direct();
    expect(result.status).toBe(shortcut === "replay" ? "already_processed" : shortcut === "expired" ? "expired" : "skipped");
    expect(active.tx.taskRequest.findMany).not.toHaveBeenCalled(); expect(active.tx.task.findMany).not.toHaveBeenCalled(); expect(active.tx.task.update).not.toHaveBeenCalled(); expect(active.tx.task.create).not.toHaveBeenCalled(); expect(api.emit).not.toHaveBeenCalled();
  });
});
