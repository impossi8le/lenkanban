import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskReadPredicate } from "@/lib/access-policy";

const fileId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
const runtime = vi.hoisted(() => ({
  database: {} as Record<string, unknown>,
  auth: vi.fn(),
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
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: runtime.warn }, dbLogger: { error: vi.fn() } }));

import { GET } from "./route";

const bytes = new Uint8Array([37, 80, 68, 70]);

function fixture(url = `/api/tasks/task/files/${fileId}`) {
  const options = {
    actor: { id: "actor", globalRole: "USER" } as { id: string; globalRole: string } | null,
    task: { id: "task", projectId: "project", createdById: "actor", attachments: [{ url, name: "отчёт.pdf", size: 4, mime: "application/pdf" }] } as
      { id: string; projectId: string; createdById: string; attachments: unknown[] } | null,
    ownerId: "actor", memberRole: null as string | null,
    marker: null as unknown,
  };
  runtime.database = {
    user: { findUnique: vi.fn(async () => options.actor) },
    task: {
      findUnique: vi.fn(async () => options.task),
      findFirst: vi.fn(async ({ where }: { where: unknown }) => {
        const filter = { id: options.task?.id ?? "task" };
        expect(where).toEqual(options.actor?.globalRole === "ADMIN" ? filter : {
          AND: [taskReadPredicate({ id: "actor", globalRole: "USER" }, ["project"], [], true), { projectId: { in: ["project"] } }, filter],
        });
        if (!options.task || !options.actor) return null;
        if (options.actor.globalRole !== "ADMIN" && options.task.createdById !== options.actor.id) return null;
        return { ...options.task, request: options.marker };
      }),
    },
    project: { findMany: vi.fn(async () => [{ id: "project" }]), findUnique: vi.fn(async () => options.ownerId === null && options.memberRole === null ? null : {
      id: "project", ownerId: options.ownerId,
      members: options.memberRole ? [{ role: options.memberRole }] : [],
    }) },
    taskRequest: { findUnique: vi.fn(async () => options.marker) },
  };
  const invoke = (id = "task", requested = fileId) => GET(
    new Request(`https://app.test/api/tasks/${id}/files/${requested}`),
    { params: Promise.resolve({ id, fileId: requested }) },
  );
  return { options, invoke };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.config = { enabled: true, bucket: "private-bucket", region: "eu-central-1", endpoint: null };
  runtime.store = { put: vi.fn(), get: vi.fn(async () => bytes), deleteOwned: vi.fn() };
  runtime.createStore.mockReturnValue(runtime.store);
  runtime.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  runtime.warn.mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/tasks/:id/files/:fileId", () => {
  it("downloads local bytes only after authorization and exact metadata membership", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "taskboard-download-test-"));
    try {
      const actual = await vi.importActual<typeof import("@/lib/attachments/runtime")>("@/lib/attachments/runtime");
      const config = actual.readAttachmentRuntimeConfig({ ATTACHMENT_LOCAL_DIR: join(directory, "private") });
      runtime.config = config;
      const store = actual.createAttachmentStore(config);
      const saved = await store.put("task", bytes);
      const get = vi.spyOn(store, "get");
      runtime.createStore.mockReturnValue(store);
      const f = fixture(`/api/tasks/task/files/${saved.fileId}`);
      const response = await f.invoke("task", saved.fileId);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Content-Disposition")).toContain("attachment;");
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      get.mockClear();
      f.options.ownerId = "other";
      f.options.task!.createdById = "other";
      expect((await f.invoke("task", saved.fileId)).status).toBe(404);
      expect(get).not.toHaveBeenCalled();
      f.options.ownerId = "actor";
      f.options.task!.createdById = "actor";
      expect((await f.invoke("task", fileId)).status).toBe(404);
      expect(get).not.toHaveBeenCalled();
      await store.deleteOwned("task", saved.fileId);
      expect((await f.invoke("task", saved.fileId)).status).toBe(404);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the OWN predicate before storage and allows an ordinary attachment without board membership", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "project");
    const f = fixture(); f.options.ownerId = "other";
    const findFirst = vi.fn(async () => ({ ...f.options.task, request: null }));
    runtime.database.task = { findFirst };
    runtime.database.scopedPrivilegeAssignment = { findMany: vi.fn(async () => []) };
    expect((await f.invoke()).status).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { AND: [taskReadPredicate({ id: "actor", globalRole: "USER" }, ["project"], [], true), { projectId: { in: ["project"] } }, { id: "task" }] },
      select: { id: true, projectId: true, attachments: true, request: { select: {
        taskId: true, contractVersion: true, state: true, authorId: true, executorId: true,
        needsInfoSince: true, pausedTotalMs: true, deletedAt: true,
      } } },
    });
    expect(runtime.store.get).toHaveBeenCalledExactlyOnceWith("task", fileId);
  });

  it("revoked OWN relationship returns the same 404 before reading storage", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "project");
    const f = fixture();
    runtime.database.task = { findFirst: vi.fn(async () => null) };
    runtime.database.scopedPrivilegeAssignment = { findMany: vi.fn(async () => []) };
    const response = await f.invoke();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/отчёт|actor|project/);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });
  it("returns 503 without authentication when storage is not configured", async () => {
    runtime.config = { enabled: false, reason: "misconfigured" };
    const response = await fixture().invoke();
    expect(response.status).toBe(503);
    expect(runtime.auth).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    runtime.auth.mockRejectedValue(new (await import("@/lib/errors")).UnauthorizedError());
    const response = await fixture().invoke();
    expect(response.status).toBe(401);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });

  it.each([
    ["../task", fileId],
    ["task", "../../etc/passwd"],
    ["task", fileId.toUpperCase()],
    ["task", "00000000-0000-0000-0000-000000000000"],
  ])("returns 404 for malformed %s / %s before any lookup", async (id, requested) => {
    const f = fixture();
    const response = await f.invoke(id, requested);
    expect(response.status).toBe(404);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });

  it("streams an exact member attachment with opaque safe headers", async () => {
    const f = fixture();
    const response = await f.invoke();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(runtime.store.get).toHaveBeenCalledWith("task", fileId);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment;");
    expect(disposition).toContain("filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf");
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  it.each([
    ["other-task-file", `/api/tasks/task/files/1a6e3b9e-3dcb-402e-891a-d1074b75d40f`],
    ["prefix", `/api/tasks/task/files/${fileId}/extra`],
    ["legacy external", "https://example.invalid/file.pdf"],
    ["missing membership", ""],
  ])("refuses %s without touching storage", async (_label, url) => {
    const f = fixture(url);
    const response = await f.invoke();
    expect(response.status).toBe(404);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });

  it.each([
    ["outsider", { actor: { id: "actor", globalRole: "USER" }, ownerId: "other", memberRole: null, task: true }],
    ["missing task", { actor: { id: "actor", globalRole: "USER" }, ownerId: "actor", memberRole: null, task: false }],
    ["revoked actor", { actor: null, ownerId: "actor", memberRole: null, task: true }],
  ])("denies %s with the same 404", async (_label, setup) => {
    const f = fixture();
    if (setup.actor === null) f.options.actor = null; else f.options.actor = setup.actor as { id: string; globalRole: string };
    f.options.ownerId = setup.ownerId;
    f.options.memberRole = setup.memberRole;
    if (setup.ownerId === "other") f.options.task!.createdById = "other";
    if (!setup.task) f.options.task = null;
    const response = await f.invoke();
    expect(response.status).toBe(404);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "IN_PROGRESS", "COMPLETED", "CLOSED"])("reads a valid marked %s task for ADMIN through the common read predicate", async state => {
    runtime.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
    const f = fixture();
    f.options.actor = { id: "actor", globalRole: "ADMIN" };
    f.options.marker = { taskId: "task", contractVersion: 1, state, authorId: "private-author",
      executorId: state === "DRAFT" ? null : "private-executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null };
    const response = await f.invoke();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([{ taskId: "foreign" }, { contractVersion: 999 }, { executorId: null }, { deletedAt: new Date() }])("denies an invalid/deleted marked file without storage reads %j", async patch => {
    const f = fixture();
    f.options.marker = { taskId: "task", contractVersion: 1, state: "CLOSED", authorId: "actor", executorId: "executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null, ...patch };
    expect((await f.invoke()).status).toBe(404);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });

  it("reads the CLOSED author's ordinary file but retains the internal audience restriction", async () => {
    const f = fixture();
    f.options.marker = { taskId: "task", contractVersion: 1, state: "CLOSED", authorId: "actor", executorId: "executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null };
    expect((await f.invoke()).status).toBe(200);
    runtime.store.get.mockClear();
    f.options.task!.attachments = [{ ...f.options.task!.attachments[0] as object, isInternal: true }];
    expect((await f.invoke()).status).toBe(404);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });

  it("allows project members to read their own file", async () => {
    const f = fixture();
    f.options.ownerId = "other";
    f.options.memberRole = "MEMBER";
    const response = await f.invoke();
    expect(response.status).toBe(200);
  });

  it("does not grant project members access to another creator's file", async () => {
    const f = fixture();
    f.options.memberRole = "MEMBER";
    f.options.task!.createdById = "other";
    expect((await f.invoke()).status).toBe(404);
    expect(runtime.store.get).not.toHaveBeenCalled();
  });

  it("returns 404 when the object is absent and 503 when storage fails", async () => {
    const missing = fixture();
    runtime.store.get.mockResolvedValueOnce(null);
    expect((await missing.invoke()).status).toBe(404);

    runtime.store.get.mockRejectedValueOnce(new (await import("@/lib/attachments/storage")).AttachmentStorageError("UNAVAILABLE"));
    const failed = await fixture().invoke();
    expect(failed.status).toBe(503);
    expect((await failed.text())).not.toContain("synthetic");
    expect(runtime.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "attachments.download.storage.failed" }));
  });
});
