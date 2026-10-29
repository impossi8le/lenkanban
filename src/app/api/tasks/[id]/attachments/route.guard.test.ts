import { beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_REQUEST_STATES, type TaskRequestState } from "@/lib/task-request-policy";

// Use real project access for both permitted mutations and revoked-access denials.
const runtime = vi.hoisted(() => ({ database: {} as object, auth: vi.fn(), load: vi.fn(), emit: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: runtime.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError,
}));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: runtime.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: runtime.emit }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: runtime.warn }, dbLogger: { error: vi.fn() } }));
import { PATCH } from "./route";

const metadata = { url: "synthetic-private-url", name: "synthetic-private-name", size: 12, mime: "image/png", width: 320, height: 240 };
function fixture(taskId = "task") {
  const calls: string[] = [];
  const state = { attachments: [metadata], version: 7 };
  let working = structuredClone(state);
  const options = {
    outerExists: true, projectExists: true, taskExists: true, identityDrift: false,
    actorExists: true, actorRole: "USER", access: true, marker: [] as unknown,
    markerFailure: false, updateFailure: false,
  };
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join("?");
      if (sql.includes('FROM "Project"')) {
        calls.push("project-lock"); expect(sql).toMatch(/ORDER BY "id" FOR UPDATE/);
        return options.projectExists ? [{ id: "project" }] : [];
      }
      if (sql.includes('FROM "Task"')) {
        calls.push("task-lock"); expect(sql).toMatch(/ORDER BY "id" FOR UPDATE/);
        return options.taskExists ? [{ id: taskId, projectId: options.identityDrift ? "other" : "project", priority: "HIGH", version: 7 }] : [];
      }
      calls.push("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => {
      calls.push("fresh-actor"); return options.actorExists ? { id: "actor", globalRole: options.actorRole } : null;
    }) },
    project: { findUnique: vi.fn(async () => {
      calls.push("fresh-access"); return { id: "project", ownerId: options.access ? "actor" : "other", members: [] };
    }) },
    taskRequest: { findMany: vi.fn(async () => {
      calls.push("marker"); if (options.markerFailure) throw new Error("synthetic-private-storage"); return options.marker;
    }) },
    task: { findUnique: vi.fn(async () => ({ attachments: working.attachments })), update: vi.fn(async ({ data }: { data: { attachments: typeof metadata[] } }) => {
      calls.push("write"); if (options.updateFailure) throw new Error("synthetic-private-write");
      working.attachments = data.attachments;
      return { id: taskId, projectId: "project", title: "Committed", version: working.version, attachments: working.attachments,
        assignees: [], tags: [], checklistItems: [], project: { id: "project" } };
    }) },
  };
  const database = {
    task: { findFirst: vi.fn(async () => options.outerExists ? { id: taskId, projectId: "project" } : null), update: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state); const result = await callback(tx); Object.assign(state, working); calls.push("commit"); return result;
    }),
  };
  runtime.database = database;
  const invoke = (attachments: unknown = [metadata]) => PATCH(new Request("https://app.test/api/tasks/task/attachments", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachments }),
  }), { params: Promise.resolve({ id: taskId }) });
  return { calls, state, options, tx, database, invoke };
}
type Fixture = ReturnType<typeof fixture>;
function marker(state: TaskRequestState) {
  return { taskId: "task", contractVersion: 1, state, authorId: "private-author",
    executorId: ["IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED"].includes(state) ? "private-executor" : null };
}
function noWrites(f: Fixture) {
  expect(f.tx.task.update).not.toHaveBeenCalled(); expect(f.database.task.update).not.toHaveBeenCalled();
  expect(runtime.load).not.toHaveBeenCalled(); expect(runtime.emit).not.toHaveBeenCalled();
}
async function rejects(f: Fixture, status: number, code?: string, attachments?: unknown) {
  const response = await f.invoke(attachments); expect(response.status).toBe(status);
  const body = await response.text(); if (code) expect(JSON.parse(body).error.code).toBe(code);
  expect(body).not.toMatch(/synthetic-private|private-author|private-executor|contractVersion/); noWrites(f);
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
  runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } }); runtime.emit.mockResolvedValue(undefined); runtime.warn.mockImplementation(() => {});
});

describe("attachment metadata PATCH shared transaction guard", () => {
  it("denies revoked project ownership before metadata reads or writes with real access", async () => {
    const f = fixture();
    f.options.access = false;
    await rejects(f, 404);
    expect(f.tx.task.findUnique).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
    expect(f.state.attachments).toEqual([metadata]);
  });
  const stored = { ...metadata, url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f" };
  it.each([
    { label: "clear", next: [] },
    { label: "replace URL", next: [{ ...stored, url: "https://example.invalid/replacement" }] },
    ...["size", "mime", "width", "height"].map(field => ({
      label: field, next: [{ ...stored, [field]: field === "mime" ? "application/pdf" : 1 }],
    })),
    { label: "omit dimensions", next: [{ url: stored.url, name: stored.name, mime: stored.mime, size: stored.size }] },
    { label: "duplicate URL", next: [stored, stored] },
  ])("rejects storage metadata mutation: $label", async ({ next }) => {
    const f = fixture(); f.state.attachments = [stored];
    await rejects(f, 422, "VALIDATION_ERROR", next);
    expect(f.state.attachments).toEqual([stored]);
  });
  it("allows a name edit and reorder while keeping stored service fields", async () => {
    const f = fixture(); f.state.attachments = [stored, metadata];
    const attachments = [metadata, { ...stored, name: "renamed.pdf" }];
    expect((await f.invoke(attachments)).status).toBe(200);
    expect(f.state.attachments).toEqual(attachments);
  });
  it("rejects injecting a new storage reference", async () => {
    const f = fixture(); await rejects(f, 422, "VALIDATION_ERROR", [stored]);
  });
  it("checks metadata committed by an upload while PATCH waits for the task lock", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const raw = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async query => {
      if (query.join("?").includes('FROM "Task"')) { entered(); await barrier; }
      return raw(query);
    });
    const pending = f.invoke([]);
    await waiting;
    expect(f.tx.task.findUnique).not.toHaveBeenCalled();
    f.tx.task.findUnique.mockResolvedValue({ attachments: [stored] });
    release();
    expect((await pending).status).toBe(422);
    noWrites(f);
  });
  it("fails closed when reading current metadata fails", async () => {
    const f = fixture();
    f.tx.task.findUnique.mockRejectedValue(new Error("synthetic-private"));
    await rejects(f, 500);
  });
  it.each(["key", "bucket", "fileId", "publicUrl"])("rejects supplied service field %s", async field => {
    const f = fixture(); await rejects(f, 422, "VALIDATION_ERROR", [{ ...metadata, [field]: "synthetic-private" }]);
  });
  it("uses actual helper locks/auth/marker before update and preserves fields/include/DTO", async () => {
    const f = fixture(); const response = await f.invoke(); expect(response.status).toBe(200);
    expect(f.calls).toEqual(["project-lock", "task-lock", "actor-lock", "fresh-actor", "fresh-access", "marker", "write", "commit"]);
    expect(f.database.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, projectId: true } }));
    expect(f.tx.task.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "task" }, data: { attachments: [metadata] },
      include: expect.objectContaining({ project: { select: { id: true } }, checklistItems: { orderBy: { position: "asc" } },
        assignees: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } } }) }));
    expect((await response.json()).data).toMatchObject({ attachments: [metadata], version: 7, title: "Committed" });
    expect(runtime.emit).toHaveBeenCalledWith("project", { id: "task", project: { id: "project" } });
  });
  it.each(TASK_REQUEST_STATES)("denies marked %s even for current ADMIN", async state => {
    const f = fixture(); f.options.actorRole = "ADMIN"; f.options.marker = [marker(state)];
    await rejects(f, 409, "REQUEST_LIFECYCLE_NOT_ENABLED"); expect(f.tx.project.findUnique).not.toHaveBeenCalled();
  });
  it.each([{ value: undefined }, { value: [{ ...marker("DRAFT"), extra: "synthetic-private" }] }])("rejects malformed storage result %#", async ({ value }) => {
    const f = fixture(); f.options.marker = value; await rejects(f, 409, "INVALID_REQUEST_MARKER");
  });
  it.each(["query", "delegate", "write"])("does not treat %s failure as absence or committed success", async failure => {
    const f = fixture(); if (failure === "query") f.options.markerFailure = true;
    if (failure === "delegate") Object.defineProperty(f.tx, "taskRequest", { value: undefined });
    if (failure === "write") {
      f.options.updateFailure = true; const response = await f.invoke([]); expect(response.status).toBe(500);
      expect(f.state.attachments).toEqual([metadata]); expect(runtime.load).not.toHaveBeenCalled(); expect(runtime.emit).not.toHaveBeenCalled(); return;
    }
    await rejects(f, 500);
  });
  it.each(["project", "task", "actor", "access"])("returns fresh missing/denied %s404 before marker", async missing => {
    const f = fixture(); if (missing === "project") f.options.projectExists = false; if (missing === "task") f.options.taskExists = false;
    if (missing === "actor") f.options.actorExists = false; if (missing === "access") f.options.access = false;
    await rejects(f, 404); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });
  it("rejects project identity drift before actor/marker", async () => {
    const f = fixture(); f.options.identityDrift = true; await rejects(f, 409, "IDENTITY_CHANGED");
    expect(f.tx.user.findUnique).not.toHaveBeenCalled(); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });
  it.each(["revoke", "missing-actor"])("reads current auth after a lock wait: %s", async scenario => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); const barrier = new Promise<void>(resolve => { release = resolve; });
    const raw = f.tx.$queryRaw.getMockImplementation()!;
    f.tx.$queryRaw.mockImplementation(async query => { if (query.join("?").includes('FROM "Project"')) { entered(); await barrier; } return raw(query); });
    const pending = f.invoke(); await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    if (scenario === "revoke") f.options.access = false; else f.options.actorExists = false;
    release(); const response = await pending; expect(response.status).toBe(404); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noWrites(f);
  });
  it.each([{ attachments: [] }, { attachments: [metadata] }])("guards clear/no-op arrays %# without new version semantics", async ({ attachments }) => {
    const f = fixture("старый:task/ id"); const response = await f.invoke(attachments); expect(response.status).toBe(200);
    expect(f.tx.taskRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: { in: ["старый:task/ id"] } } }));
    expect((await response.json()).data).toMatchObject({ attachments, version: 7 });
    expect(f.tx.task.update.mock.calls[0][0].data).toEqual({ attachments });
  });
  it.each(["load", "emit-sync", "emit-async", "logger"])("preserves committed DTO after %s failure", async failure => {
    const f = fixture(); const error = new Error("synthetic-private-delivery");
    if (failure === "load" || failure === "logger") runtime.load.mockRejectedValue(error);
    if (failure === "logger") runtime.warn.mockImplementation(() => { throw error; });
    if (failure === "emit-sync") runtime.emit.mockImplementation(() => { throw error; });
    if (failure === "emit-async") runtime.emit.mockRejectedValue(error);
    const response = await f.invoke([]); expect(response.status).toBe(200); expect(f.state.attachments).toEqual([]);
    expect((await response.json()).data).toMatchObject({ title: "Committed", attachments: [], version: 7 });
    expect(runtime.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "attachments.realtime.failed", route: "/api/tasks/:id/attachments" }));
  });
  it("drops a mismatched later project snapshot and never returns loader content", async () => {
    const f = fixture(); runtime.load.mockResolvedValue({ project: { id: "other" }, title: "Later", attachments: [] });
    const response = await f.invoke(); expect(response.status).toBe(200); expect(runtime.emit).not.toHaveBeenCalled();
    expect((await response.json()).data).toMatchObject({ title: "Committed", attachments: [metadata] });
  });
  it("authenticates before schema validation and retains the legacy outer authorization filter", async () => {
    const f = fixture(); expect((await f.invoke("not-array")).status).toBe(422); expect(runtime.auth).toHaveBeenCalledOnce();
    runtime.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); f.options.outerExists = false;
    expect((await f.invoke()).status).toBe(404); expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(f.database.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ project: expect.any(Object) }) }));
  });
});
