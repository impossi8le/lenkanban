import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  database: {} as Record<string, unknown>,
  auth: vi.fn(),
  load: vi.fn(),
  emit: vi.fn(),
  warn: vi.fn(),
  config: { enabled: true, bucket: "private-bucket", region: "eu-central-1", endpoint: null } as unknown,
  store: { put: vi.fn(), get: vi.fn(), deleteOwned: vi.fn() },
  createStore: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: runtime.auth,
  UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError,
}));
vi.mock("@/lib/attachments/runtime", () => ({
  readAttachmentRuntimeConfig: () => runtime.config,
  createAttachmentStore: runtime.createStore,
}));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: runtime.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: runtime.emit }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: runtime.warn }, dbLogger: { error: vi.fn() } }));

import { POST } from "./route";

const pdf = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";

function fixture(taskId = "task") {
  const calls: string[] = [];
  const state = { attachments: [] as unknown[], version: 7 };
  const options = {
    outerExists: true, projectExists: true, taskExists: true, access: true,
    marker: [] as unknown, updateFailure: false, currentMissing: false,
  };
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = query.join("?");
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); return options.projectExists ? [{ id: "project" }] : []; }
      if (sql.includes('FROM "Task"')) {
        calls.push("task-lock");
        return options.taskExists ? [{ id: taskId, projectId: "project", priority: "HIGH", version: 7 }] : [];
      }
      calls.push("actor-lock"); return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => { calls.push("fresh-actor"); return { id: "actor", globalRole: "USER", isBlocked: false, blockedAt: null }; }) },
    project: { findUnique: vi.fn(async () => {
      calls.push("fresh-access");
      return { id: "project", ownerId: options.access ? "actor" : "other", members: [] };
    }) },
    taskRequest: { findUnique: vi.fn(async ({ select }: { select?: { audienceUserIds?: boolean } }) => { const row = Array.isArray(options.marker) ? options.marker[0] ?? null : options.marker; if (select?.audienceUserIds) return row === null ? null : { authorId: "actor", audienceUserIds: [] }; return row && typeof row === "object" ? { ...row, deletedAt: null } : row; }), findMany: vi.fn(async () => { calls.push("marker"); return options.marker; }) },
    task: {
      findFirst: vi.fn(async () => options.access ? { id: "task" } : null),
      findUnique: vi.fn(async () => {
        calls.push("read-current");
        return options.currentMissing ? null : { attachments: structuredClone(state.attachments), version: state.version };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { version: number }; data: { attachments: unknown[] } }) => {
        if (where.version !== state.version) return { count: 0 };
        if (options.updateFailure) throw Error("synthetic-private-write");
        state.attachments = structuredClone(data.attachments); state.version++; return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: { attachments: unknown[] } }) => {
        calls.push("write");
        if (options.updateFailure) throw new Error("synthetic-private-write");
        state.attachments = structuredClone(data.attachments);
        return { id: taskId };
      }),
    },
    activity: { create: vi.fn(async () => { calls.push("activity"); return { id: "activity" }; }) },
  };
  const database = {
    task: { findUnique: vi.fn(async () => options.outerExists ? { projectId: "project" } : null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  runtime.database = database;
  const invoke = (form?: FormData) => POST(new Request("https://app.test/api/uploads/direct", {
    method: "POST",
    body: form ?? uploadForm(taskId),
  }));
  return { calls, state, options, tx, database, invoke };
}

function uploadForm(taskId: string, files = [{ name: "report.pdf", type: "application/pdf", data: pdf }]) {
  const form = new FormData();
  form.append("taskId", taskId);
  for (const file of files) form.append("files", new File([file.data], file.name, { type: file.type }));
  return form;
}

async function json(response: Response) {
  return JSON.parse(await response.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.config = { enabled: true, bucket: "private-bucket", region: "eu-central-1", endpoint: null };
  runtime.store = { put: vi.fn(async () => ({ fileId: "0a6e3b9e-3dcb-402e-891a-d1074b75d40f", size: 50 })),
    get: vi.fn(), deleteOwned: vi.fn(async () => undefined) };
  runtime.createStore.mockReturnValue(runtime.store);
  runtime.auth.mockResolvedValue({ id: "actor", globalRole: "USER", isBlocked: false, blockedAt: null });
  runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } });
  runtime.emit.mockResolvedValue(undefined);
  runtime.warn.mockImplementation(() => {});
});

describe("POST /api/uploads/direct", () => {
  it("admits a submitted author through canonical attachment policy", async () => {
    const f = fixture();
    f.options.marker = [{ taskId: "task", contractVersion: 1, state: "SUBMITTED", authorId: "actor", executorId: null }];
    expect((await f.invoke()).status).toBe(201);
    expect(f.state.attachments).toHaveLength(1);
    expect(f.state.version).toBe(8);
    expect(f.tx.activity.create).toHaveBeenCalledOnce();
  });

  it("rechecks marked authority at commit and cleans only newly created objects on revocation", async () => {
    const f = fixture();
    f.options.marker = [{ taskId: "task", contractVersion: 1, state: "SUBMITTED", authorId: "actor", executorId: null }];
    runtime.store.put.mockImplementation(async () => {
      f.options.access = false;
      return { fileId: "0a6e3b9e-3dcb-402e-891a-d1074b75d40f", size: 50 };
    });
    expect((await f.invoke()).status).toBe(404);
    expect(runtime.store.deleteOwned).toHaveBeenCalledExactlyOnceWith("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f");
    expect(f.tx.task.updateMany).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled();
    expect(f.state.attachments).toEqual([]); expect(f.state.version).toBe(7);
  });

  it.each(["cancelled", "deleted", "malformed"])("refuses %s marked uploads before storage or metadata writes", async kind => {
    const f = fixture();
    const marker = { taskId: "task", contractVersion: 1, state: kind === "cancelled" ? "CANCELLED" : "SUBMITTED", authorId: "actor", executorId: null };
    f.options.marker = [marker];
    if (kind === "deleted") f.tx.taskRequest.findUnique.mockImplementation(async ({ select }) => select?.audienceUserIds ? { authorId: "actor", audienceUserIds: [] } : { ...marker, deletedAt: new Date() });
    if (kind === "malformed") f.tx.taskRequest.findUnique.mockImplementation(async ({ select }) => select?.audienceUserIds ? { authorId: "actor", audienceUserIds: [] } : { ...marker, contractVersion: 99, deletedAt: null });
    expect((await f.invoke()).status).toBe(kind === "deleted" ? 404 : 409);
    expect(runtime.store.put).not.toHaveBeenCalled(); expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.tx.activity.create).not.toHaveBeenCalled(); expect(f.state.version).toBe(7);
  });

  it("uploads through the real default local runtime without S3 credentials", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "taskboard-upload-test-"));
    try {
      const actual = await vi.importActual<typeof import("@/lib/attachments/runtime")>("@/lib/attachments/runtime");
      const config = actual.readAttachmentRuntimeConfig({ ATTACHMENT_LOCAL_DIR: join(directory, "private") });
      runtime.config = config;
      const store = actual.createAttachmentStore(config);
      runtime.createStore.mockReturnValue(store);
      const f = fixture();
      const response = await f.invoke();
      expect(response.status).toBe(201);
      const body = await json(response);
      expect(body.data.count).toBe(1);
      const uploaded = body.data.uploaded[0];
      expect(uploaded.url).toMatch(/^\/api\/tasks\/task\/files\/[0-9a-f-]{36}$/);
      expect(uploaded.name).toBe("report.pdf");
      expect(await store.get("task", uploaded.url.split("/").at(-1))).toEqual(Buffer.from(pdf));
      expect(f.state.attachments).toEqual(body.data.uploaded);
      expect(f.tx.activity.create).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a disabled runtime with 503 before auth or body reads", async () => {
    runtime.config = { enabled: false, reason: "disabled" };
    const request = new Request("https://app.test/api/uploads/direct", { method: "POST", body: uploadForm("task") });
    const response = await POST(request);
    expect(response.status).toBe(503);
    expect((await json(response)).error.code).toBe("ATTACHMENTS_UNAVAILABLE");
    expect(runtime.auth).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(runtime.createStore).not.toHaveBeenCalled();
  });

  it("requires authentication before reading the body", async () => {
    runtime.auth.mockRejectedValue(new (await import("@/lib/errors")).UnauthorizedError());
    const request = new Request("https://app.test/api/uploads/direct", { method: "POST", body: uploadForm("task") });
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(runtime.store.put).not.toHaveBeenCalled();
  });

  it("uploads a valid file through the shared guard, storage and atomic append", async () => {
    const f = fixture();
    const response = await f.invoke();
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.data.count).toBe(1);
    expect(body.data.uploaded).toEqual([{
      url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f",
      name: "report.pdf", size: 50, mime: "application/pdf",
    }]);
    expect(runtime.store.put).toHaveBeenCalledWith("task", expect.any(Uint8Array));
    expect(f.calls).toEqual([
      "project-lock", "task-lock", "actor-lock", "fresh-actor", "fresh-access", "marker",
      "project-lock", "task-lock", "actor-lock", "fresh-actor", "fresh-access", "marker",
      "read-current", "write", "activity",
      // Shared content-notification policy rechecks fresh facts inside the append transaction.
      "fresh-actor", "read-current", "fresh-access", "actor-lock",
    ]);
    expect(f.state.attachments).toHaveLength(1);
    expect(runtime.emit).toHaveBeenCalledWith("project", { id: "task", project: { id: "project" } });
  });

  it.each([
    { name: "report.exe", type: "application/pdf", data: pdf },
    { name: "report.pdf", type: "application/pdf", data: "not a pdf at all" },
    { name: "report.pdf", type: "image/png", data: pdf },
  ])("rejects invalid content %# with 422 before any storage or write", async file => {
    const f = fixture();
    const response = await f.invoke(uploadForm("task", [file]));
    expect(response.status).toBe(422);
    expect((await json(response)).error.code).toBe("VALIDATION_ERROR");
    expect(runtime.store.put).not.toHaveBeenCalled();
    expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });

  it("rejects more than five files and non-multipart bodies", async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({ name: `report${index}.pdf`, type: "application/pdf", data: pdf }));
    const tooMany = await fixture().invoke(uploadForm("task", files));
    expect(tooMany.status).toBe(400);

    const response = await POST(new Request("https://app.test/api/uploads/direct", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(runtime.store.put).not.toHaveBeenCalled();
  });

  it.each(["project", "task", "access", "outer"])("denies missing or foreign %s with 404 before storage", async missing => {
    const f = fixture();
    if (missing === "outer") f.options.outerExists = false;
    if (missing === "project") f.options.projectExists = false;
    if (missing === "task") f.options.taskExists = false;
    if (missing === "access") f.options.access = false;
    const response = await f.invoke();
    expect(response.status).toBe(404);
    expect(runtime.store.put).not.toHaveBeenCalled();
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });

  it("rejects a foreign draft author with 409 and no storage write", async () => {
    const f = fixture();
    f.options.marker = [{ taskId: "task", contractVersion: 1, state: "DRAFT", authorId: "private-author", executorId: null }];
    const response = await f.invoke();
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe("FORBIDDEN_ROLE");
    expect(runtime.store.put).not.toHaveBeenCalled();
  });

  it("returns 503 and removes only objects created by a failed storage attempt", async () => {
    const f = fixture();
    runtime.store.put = vi.fn()
      .mockResolvedValueOnce({ fileId: "0a6e3b9e-3dcb-402e-891a-d1074b75d40f", size: 50 })
      .mockRejectedValueOnce(new (await import("@/lib/attachments/storage")).AttachmentStorageError("UNAVAILABLE"));
    const files = [
      { name: "report.pdf", type: "application/pdf", data: pdf },
      { name: "second.pdf", type: "application/pdf", data: pdf },
    ];
    const response = await f.invoke(uploadForm("task", files));
    expect(response.status).toBe(503);
    expect(runtime.store.deleteOwned).toHaveBeenCalledTimes(1);
    expect(runtime.store.deleteOwned).toHaveBeenCalledWith("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f");
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });

  it("cleans up stored objects when the final guard refuses before the write", async () => {
    const f = fixture();
    const cancelled = { taskId: "task", contractVersion: 1, state: "CANCELLED", authorId: "private-author", executorId: "private-executor" };
    f.options.marker = [cancelled];
    f.tx.taskRequest.findUnique.mockImplementation(async ({ select }) => select?.audienceUserIds ? { authorId: "actor", audienceUserIds: [] } : { ...cancelled, deletedAt: null }).mockResolvedValueOnce(null);
    f.tx.taskRequest.findMany.mockResolvedValue([]);
    const response = await f.invoke();
    expect(response.status).toBe(409);
    expect(runtime.store.put).toHaveBeenCalledTimes(1);
    expect(runtime.store.deleteOwned).toHaveBeenCalledWith("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f");
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });

  it("keeps objects when the metadata write result is ambiguous", async () => {
    const f = fixture();
    f.options.updateFailure = true;
    const response = await f.invoke();
    expect(response.status).toBe(500);
    expect(runtime.store.put).toHaveBeenCalledTimes(1);
    expect(runtime.store.deleteOwned).not.toHaveBeenCalled();
  });

  it("preserves committed success when realtime delivery fails", async () => {
    runtime.load.mockRejectedValue(new Error("synthetic-private-delivery"));
    const f = fixture();
    const response = await f.invoke();
    expect(response.status).toBe(201);
    expect((await json(response)).data.count).toBe(1);
    expect(runtime.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "attachments.upload.realtime.failed", route: "/api/uploads/direct" }));
  });

  it("appends to the current array instead of replacing it", async () => {
    const f = fixture();
    const existing = { url: "/legacy/file", name: "old.txt", size: 3, mime: "text/plain" };
    f.state.attachments = [existing];
    const response = await f.invoke();
    expect(response.status).toBe(201);
    expect(f.state.attachments[0]).toEqual(existing);
    expect(f.state.attachments).toHaveLength(2);
  });
});
