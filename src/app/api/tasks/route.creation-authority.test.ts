import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";

const api = vi.hoisted(() => ({
  transaction: vi.fn(), project: vi.fn(), column: vi.fn(), auth: vi.fn(),
  emit: vi.fn(), automation: vi.fn(), rate: vi.fn(), diagnostic: vi.fn(),
  taskRead: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: api.transaction, project: { findFirst: api.project, findUnique: async () => ({ownerId: "actor", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{id: columnId}]}) }, projectColumn: { findFirst: api.column },
  task: { findUnique: api.taskRead, findMany: api.taskRead, findFirst: api.taskRead },
} }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: api.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: api.emit }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: api.automation }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: api.rate, rateLimitErrorResponse: () => new Response("{}", { status: 429 }) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: api.diagnostic } }));

import { POST } from "./route";

const projectId = "cm0000000000000000000001", columnId = "cm0000000000000000000002";
function fixture() {
  const state = {
    actor: { id: "actor", globalRole: "USER" } as { id: string; globalRole: string } | null,
    project: { id: projectId, ownerId: "actor", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{ id: columnId }] } as { id: string; ownerId: string; responsibleGroup: null | { archivedAt: Date | null; members: { userId: string }[] }; columns: { id: string }[]; members: { role: string }[]; applicantPolicyConfig: null } | null,
    column: { id: columnId, projectId, workflowKey: "TODO" } as { id: string; projectId: string; workflowKey: string } | null,
  };
  const options = { waitProject: false, waitColumn: false, commitFailure: false };
  let entered!: () => void, release!: () => void, committed = false;
  const enteredProject = new Promise<void>(resolve => { entered = resolve; });
  const releasedProject = new Promise<void>(resolve => { release = resolve; });
  const tx = {
    activity: { create: vi.fn() },
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "ProjectColumn"')) {
        if (options.waitColumn) { entered(); await releasedProject; }
        return state.column ? [{ ...state.column }] : [];
      }
      if (sql.includes('FROM "Project"')) {
        if (options.waitProject) { entered(); await releasedProject; }
        return state.project ? [{ id: projectId }] : [];
      }
      if (sql.includes('FROM "User"')) return state.actor ? [{ id: state.actor.id }] : [];
      throw new Error("Unexpected resource lock in empty column");
    }),
    user: { findUnique: vi.fn(async () => state.actor && { ...state.actor }) },
    project: { findUnique: vi.fn(async () => state.project && structuredClone(state.project)) },
    task: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "created", ...data, assignees: [], tags: [], _count: { messages: 0 } })),
      update: vi.fn(), findMany: vi.fn(),
    },
    taskRequest: { findMany: vi.fn() },
  };
  api.transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => {
    const result = await callback(tx);
    if (options.commitFailure) throw new Error("synthetic-private-commit");
    committed = true; return result;
  });
  api.emit.mockImplementation(() => { expect(committed).toBe(true); });
  api.automation.mockImplementation(async () => { expect(committed).toBe(true); });
  const run = (body: object = { projectId, columnId, title: "Synthetic task" }) => POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(body) }));
  const noEffectsOrWrites = () => {
    expect(tx.task.create).not.toHaveBeenCalled(); expect(tx.task.update).not.toHaveBeenCalled();
    expect(api.emit).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled();
  };
  return { state, options, tx, run, enteredProject, release, noEffectsOrWrites };
}
beforeEach(() => {
  vi.resetAllMocks(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  api.project.mockResolvedValue({ id: projectId }); api.column.mockResolvedValue({ id: columnId, workflowKey: "TODO" });
  api.taskRead.mockImplementation(() => { throw new Error("Forbidden global task reread"); });
});

describe("actual POST creation with real authority helper, common policy and rank allocator", () => {
  it("rejects an applicant forging a later column before task, activity or effects", async () => {
    const f = fixture(); f.state.column!.workflowKey = "DONE"; f.state.project!.columns = [{ id: "canonical-initial" }];
    const response = await f.run();
    expect(response.status).toBe(403);
    f.noEffectsOrWrites(); expect(f.tx.activity.create).not.toHaveBeenCalled();
  });
  it("fails closed for an applicant when the board has no initial TODO column", async () => {
    const f = fixture(); f.state.project!.columns = [];
    expect((await f.run()).status).toBe(403);
    f.noEffectsOrWrites(); expect(f.tx.activity.create).not.toHaveBeenCalled();
  });
  it("refreshes support membership after waiting before permitting a later column", async () => {
    const f = fixture(); f.options.waitProject = true;
    f.state.project!.columns = [{ id: "canonical-initial" }];
    f.state.project!.responsibleGroup = { archivedAt: null, members: [{ userId: "actor" }] };
    const pending = f.run(); await f.enteredProject;
    f.state.project!.responsibleGroup.members = []; f.release();
    expect((await pending).status).toBe(403); f.noEffectsOrWrites();
  });
  it("creates from the fresh workflow and server actor with compatible scalar fields", async () => {
    const f = fixture(); f.state.column!.workflowKey = "DONE"; f.state.project!.responsibleGroup = { archivedAt: null, members: [{userId: "actor"}] };
    const response = await f.run({ projectId, columnId, title: "  Synthetic task  ", description: "  Synthetic description  ", priority: "HIGH", status: "IN_PROGRESS", deadline: "2026-10-30T10:00:00Z" });
    expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ title: "Synthetic task", description: "Synthetic description", priority: "HIGH", status: "DONE", createdById: "actor", position: 1024, columnId, projectId });
    expect(f.tx.task.create).toHaveBeenCalledOnce(); expect(api.emit).toHaveBeenCalledOnce(); expect(api.automation).toHaveBeenCalledOnce();
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(api.taskRead).not.toHaveBeenCalled();
  });
  it.each(["createdById", "authorId", "executorId", "assigneeId", "assignees", "request", "attachments", "watchers", "createdAt", "amount", "period", "channel"])("rejects unsupported creation field %s before any write", async field => {
    const f = fixture();
    const response = await f.run({ projectId, title: "Synthetic task", [field]: "synthetic-private-value" });
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("synthetic-private-value");
    expect(api.transaction).not.toHaveBeenCalled();
    f.noEffectsOrWrites();
  });
  it.each(["actor", "membership", "owner", "admin"])("denies revoked %s authority after waiting for the project lock", async kind => {
    const f = fixture(); f.options.waitProject = true;
    if (kind === "membership") { f.state.project!.ownerId = "other"; f.state.project!.members = [{ role: "MEMBER" }]; }
    if (kind === "admin") { api.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" }); f.state.actor!.globalRole = "ADMIN"; f.state.project!.ownerId = "other"; }
    const pending = f.run(); await f.enteredProject;
    if (kind === "actor") f.state.actor = null;
    if (kind === "membership") f.state.project!.members = [];
    if (kind === "owner") f.state.project!.ownerId = "other";
    if (kind === "admin") f.state.actor!.globalRole = "USER";
    f.release(); const response = await pending;
    expect(response.status).toBe(404); expect(await response.text()).not.toMatch(/synthetic-private|membership|actor/);
    f.noEffectsOrWrites();
  });
  it.each(["MEMBER", "PROJECT_ADMIN", "ADMIN", "owner"])("preserves common-policy creation for fresh %s", async kind => {
    const f = fixture(); f.state.project!.ownerId = kind === "owner" ? "actor" : "other";
    if (kind === "ADMIN") f.state.actor!.globalRole = "ADMIN";
    else if (kind !== "owner") f.state.project!.members = [{ role: kind }];
    expect((await f.run()).status).toBe(201);
  });
  it.each(["membership", "admin"])("denies revoked %s authority while waiting for the selected Column lock", async kind => {
    const f = fixture(); f.options.waitColumn = true; f.state.project!.ownerId = "other";
    if (kind === "membership") f.state.project!.members = [{ role: "MEMBER" }];
    else { api.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" }); f.state.actor!.globalRole = "ADMIN"; }
    const pending = f.run(); await f.enteredProject;
    if (kind === "membership") f.state.project!.members = []; else f.state.actor!.globalRole = "USER";
    f.release(); expect((await pending).status).toBe(404); f.noEffectsOrWrites();
  });
  it.each(["project", "column"])("denies a deleted %s after waiting with a successful preflight", async resource => {
    const f = fixture(); f.options.waitProject = true;
    const pending = f.run(); await f.enteredProject;
    if (resource === "project") f.state.project = null; else f.state.column = null;
    f.release(); expect((await pending).status).toBe(resource === "project" ? 404 : 400);
    f.noEffectsOrWrites(); expect(api.column).toHaveBeenCalledOnce();
  });
  it.each(["VIEWER", "UNSUPPORTED"])("denies synthetic unsupported %s membership despite successful preflight", async role => {
    const f = fixture(); f.state.project!.ownerId = "other"; f.state.project!.members = [{ role }];
    expect((await f.run()).status).toBe(404); f.noEffectsOrWrites();
  });
  it.each(["deleted", "moved"])("returns safe column 400 for %s selected target without fallback", async kind => {
    const f = fixture(); if (kind === "deleted") f.state.column = null; else f.state.column!.projectId = "other";
    const response = await f.run(); expect(response.status).toBe(400);
    expect(api.column).toHaveBeenCalledOnce(); f.noEffectsOrWrites();
  });
  it("retains the selected default column and fresh workflow when ordering changes during a wait", async () => {
    const f = fixture(); f.options.waitProject = true; f.state.project!.responsibleGroup = { archivedAt: null, members: [{userId: "actor"}] };
    const pending = f.run({ projectId, title: "Synthetic task" }); await f.enteredProject;
    api.column.mockResolvedValue({ id: "different-new-first", workflowKey: "TODO" }); f.state.column!.workflowKey = "DONE";
    f.release(); const response = await pending; expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ columnId, status: "DONE", priority: "MEDIUM", description: null });
    expect(api.column).toHaveBeenCalledExactlyOnceWith({ where: { id: columnId, projectId }, select: { id: true, workflowKey: true } });
  });
  it("sends no effects when transaction commit fails after create", async () => {
    const f = fixture(); f.options.commitFailure = true;
    const response = await f.run(); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-private"); expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(api.emit).not.toHaveBeenCalled(); expect(api.automation).not.toHaveBeenCalled();
  });
  it.each(["project", "explicit-column", "default-column"])("preserves preflight %s failure without beginning transaction", async kind => {
    const f = fixture(); if (kind === "project") api.project.mockResolvedValue(null); else api.column.mockResolvedValue(null);
    const response = await f.run(kind === "default-column" ? { projectId, title: "Synthetic task" } : undefined);
    expect(response.status).toBe(kind === "project" ? 404 : 400); expect(api.transaction).not.toHaveBeenCalled(); f.noEffectsOrWrites();
  });
  it.each(["json", "validation", "auth", "rate"])("preserves %s failure without mutation", async kind => {
    const f = fixture();
    if (kind === "auth") api.auth.mockRejectedValue(new UnauthorizedError());
    if (kind === "rate") api.rate.mockRejectedValue(new Error("synthetic-private-rate"));
    const response = kind === "json" ? await POST(new Request("http://localhost/api/tasks", { method: "POST", body: "{" })) : await f.run(kind === "validation" ? { projectId, title: "" } : undefined);
    expect(response.status).toBe({ json: 400, validation: 422, auth: 401, rate: 429 }[kind]);
    expect(api.transaction).not.toHaveBeenCalled(); f.noEffectsOrWrites();
  });
});
