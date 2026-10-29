import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  database: {} as Record<string, unknown>,
  auth: vi.fn(),
  config: { enabled: true, storage: "local", directory: "/tmp/unused" } as unknown,
  createStore: vi.fn(),
  load: vi.fn(),
  emit: vi.fn(),
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
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn() }, dbLogger: { error: vi.fn() } }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: vi.fn(async () => undefined),
  rateLimitErrorResponse: vi.fn(() => new Response(JSON.stringify({ error: "RateLimited" }), {
    status: 429, headers: { "Content-Type": "application/json" },
  })),
}));

import { POST } from "./route";
import { PUT } from "@/app/api/uploads/presign/route";
import { createUploadToken, UPLOAD_TOKEN_TTL_MS } from "@/lib/attachments/upload-token";
import { attachmentFileUrl } from "@/lib/attachments/task-port";
import { MAX_TASK_ATTACHMENTS } from "@/lib/attachments/append";
import { UnauthorizedError } from "@/lib/errors";

const secret = "synthetic-upload-secret-value-0123456789";
const pdf = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";
const fileId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";

function fixture(options: { access?: boolean; taskExists?: boolean; marker?: unknown } = {}) {
  const settings = {
    access: options.access ?? true,
    taskExists: options.taskExists ?? true,
    marker: options.marker ?? [],
    internalMember: false,
  };
  const state = { attachments: [] as unknown[], version: 7, activities: 0, writes: 0 };
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) return [{ id: "task", projectId: "project", priority: "MEDIUM", version: 1 }];
      return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => ({ id: "actor", globalRole: "USER", isBlocked: false, blockedAt: null })) },
    project: { findUnique: vi.fn(async () => ({ id: "project", ownerId: settings.access ? "actor" : "other", members: [], departmentId: null, department: null,
      responsibleGroupId: settings.internalMember ? "group" : null,
      responsibleGroup: settings.internalMember ? { id: "group", archivedAt: null, members: [{ userId: "actor" }] } : null,
    })) },
    taskRequest: { findUnique: vi.fn(async ({ select }: { select?: { audienceUserIds?: boolean } }) => { const row = Array.isArray(settings.marker) ? settings.marker[0] ?? null : settings.marker; if (select?.audienceUserIds) return row === null ? null : { authorId: "actor", audienceUserIds: [] }; return row && typeof row === "object" ? { ...row, deletedAt: null } : row; }), findMany: vi.fn(async () => settings.marker) },
    task: {
      findFirst: vi.fn(async () => settings.access ? { id: "task" } : null),
      findUnique: vi.fn(async () => ({ attachments: structuredClone(state.attachments), version: state.version })),
      updateMany: vi.fn(async ({ where, data }: { where: { version: number }; data: { attachments: unknown[] } }) => {
        if (where.version !== state.version) return { count: 0 };
        state.attachments = structuredClone(data.attachments); state.version++; state.writes++; return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: { attachments: unknown[] } }) => {
        state.writes += 1;
        state.attachments = structuredClone(data.attachments);
        return { id: "task" };
      }),
    },
    activity: { create: vi.fn(async () => { state.activities += 1; return { id: "activity" }; }) },
  };
  const database = {
    task: { findUnique: vi.fn(async () => settings.taskExists
      ? { projectId: "project", attachments: structuredClone(state.attachments) } : null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  runtime.database = database;
  return { settings, state, tx, database };
}

function token(overrides: Record<string, unknown> = {}) {
  return createUploadToken(secret, {
    v: 1,
    taskId: "task",
    actorId: "actor",
    fileId,
    name: "report.pdf",
    mime: "application/pdf",
    size: Buffer.byteLength(pdf),
    nonce: "b".repeat(48),
    expiresAt: Date.now() + UPLOAD_TOKEN_TTL_MS,
    ...overrides,
  } as Parameters<typeof createUploadToken>[1]);
}

function finalizeRequest(body: unknown) {
  return new Request("https://app.test/api/uploads/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response) {
  return JSON.parse(await response.text());
}

async function localStore() {
  const directory = await fs.mkdtemp(join(tmpdir(), "taskboard-finalize-test-"));
  const actual = await vi.importActual<typeof import("@/lib/attachments/runtime")>("@/lib/attachments/runtime");
  const config = actual.readAttachmentRuntimeConfig({ ATTACHMENT_LOCAL_DIR: join(directory, "private") });
  runtime.config = config;
  const store = actual.createAttachmentStore(config);
  runtime.createStore.mockReturnValue(store);
  return { directory, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.config = { enabled: true, storage: "local", directory: "/tmp/unused" };
  runtime.auth.mockResolvedValue({ id: "actor", globalRole: "USER", isBlocked: false, blockedAt: null });
  runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } });
  runtime.emit.mockResolvedValue(undefined);
  process.env.ATTACHMENT_UPLOAD_SECRET = secret;
});

describe("POST /api/uploads/finalize", () => {
  it("does not disclose completed internal metadata after audience revocation while task read remains", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture({ marker: [{ taskId: "task", contractVersion: 1, state: "SUBMITTED", authorId: "actor", executorId: null }] });
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(201);
      const stale = structuredClone(f.state.attachments);
      f.state.attachments = f.state.attachments.map(value => ({ ...(value as object), isInternal: true, name: "synthetic-private-internal-name.pdf" }));
      f.database.task.findUnique.mockResolvedValue({ projectId: "project", attachments: stale });
      f.settings.internalMember = true;
      const visible = await POST(finalizeRequest({ taskId: "task", token: token() }));
      expect(visible.status).toBe(200);
      expect((await json(visible)).data.attachment.name).toBe("synthetic-private-internal-name.pdf");
      f.settings.internalMember = false; // author still has task read, loses internal audience
      const before = structuredClone(f.state);
      // A stale authenticated ADMIN claim must not override the fresh database role.
      runtime.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
      const response = await POST(finalizeRequest({ taskId: "task", token: token() }));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("synthetic-private-internal-name");
      expect(f.settings.access).toBe(true); expect(f.state).toEqual(before);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("does not return a public DTO when another finalize committed an internal match after preflight", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture({ marker: [{ taskId: "task", contractVersion: 1, state: "SUBMITTED", authorId: "actor", executorId: null }] });
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (taskId, id) => {
        const bytes = await get(taskId, id);
        // Simulate a different transaction winning after our locked preflight.
        f.state.attachments = [{ url: attachmentFileUrl("task", fileId), name: "synthetic-private-race.pdf", size: Buffer.byteLength(pdf), mime: "application/pdf", isInternal: true }];
        f.state.version = 8;
        return bytes;
      });
      const response = await POST(finalizeRequest({ taskId: "task", token: token() }));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("synthetic-private-race");
      expect(f.state.version).toBe(8); expect(f.state.writes).toBe(0); expect(f.state.activities).toBe(0);
      expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("finalizes marked clarification files once and rechecks authority on replay", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const marker = { taskId: "task", contractVersion: 1, state: "NEEDS_INFO", authorId: "actor", executorId: "executor" };
      const f = fixture({ marker: [marker] });
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(201);
      expect(f.state.version).toBe(8); expect(f.state.activities).toBe(1);
      expect(f.settings.marker).toEqual([marker]);
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(200);
      expect(f.state.version).toBe(8); expect(f.state.writes).toBe(1); expect(f.state.activities).toBe(1);
      f.settings.access = false;
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(404);
      expect(f.state.version).toBe(8); expect(f.state.activities).toBe(1);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("rejects marked metadata CAS conflict with no Activity", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture({ marker: [{ taskId: "task", contractVersion: 1, state: "SUBMITTED", authorId: "actor", executorId: null }] });
      f.tx.task.updateMany.mockResolvedValue({ count: 0 });
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(409);
      expect(f.state.attachments).toEqual([]); expect(f.state.version).toBe(7); expect(f.state.activities).toBe(0);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("appends the staged object once through the shared atomic writer", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture();
      const response = await POST(finalizeRequest({ taskId: "task", token: token() }));
      expect(response.status).toBe(201);
      const body = await json(response);
      expect(body.data.created).toBe(true);
      expect(body.data.attachment).toEqual({
        url: attachmentFileUrl("task", fileId), name: "report.pdf", size: Buffer.byteLength(pdf), mime: "application/pdf",
      });
      expect(f.state.attachments).toEqual([{...body.data.attachment,pendingMessageAuthorId:"actor"}]);
      expect(body.data.attachment).not.toHaveProperty("pendingMessageAuthorId");
      expect(f.state.writes).toBe(1);
      expect(f.state.activities).toBe(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("is idempotent: a repeated finalize adds no second row or Activity", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture();
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(201);
      const again = await POST(finalizeRequest({ taskId: "task", token: token() }));
      expect(again.status).toBe(200);
      expect((await json(again)).data.created).toBe(false);
      expect(f.state.attachments).toHaveLength(1);
      expect(f.state.writes).toBe(1);
      expect(f.state.activities).toBe(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("spends the capability: a PUT after finalize cannot replace the object", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      fixture();
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(201);
      const response = await PUT(new Request("https://app.test/api/uploads/presign", {
        method: "PUT",
        headers: { "content-type": "application/pdf", "x-attachment-upload-token": token() },
        body: Buffer.from(pdf),
      }));
      expect(response.status).toBe(409);
      expect((await json(response)).error.code).toBe("UPLOAD_ALREADY_COMPLETED");
      expect(await store.get("task", fileId)).toEqual(Buffer.from(pdf));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps two different uploads as two attachments", async () => {
    const { directory, store } = await localStore();
    try {
      const secondId = randomUUID();
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      await store.putWithId!("task", secondId, Buffer.from(pdf));
      const f = fixture();
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(201);
      expect((await POST(finalizeRequest({ taskId: "task", token: token({ fileId: secondId }) }))).status).toBe(201);
      expect(f.state.attachments).toHaveLength(2);
      expect(f.state.activities).toBe(2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("denies finalize when access was revoked after presign, with no append or Activity", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture({ access: false });
      const response = await POST(finalizeRequest({ taskId: "task", token: token() }));
      expect(response.status).toBe(404);
      expect(f.state.attachments).toEqual([]);
      expect(f.state.writes).toBe(0);
      expect(f.state.activities).toBe(0);
      expect(runtime.emit).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("denies finalize when the marker blocks the mutation", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture({ marker: [{ taskId: "task", contractVersion: 1, state: "DRAFT", authorId: "author", executorId: null }] });
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(409);
      expect(f.state.writes).toBe(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a token bound to another actor, task or file", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      fixture();
      expect((await POST(finalizeRequest({ taskId: "task", token: token({ actorId: "other" }) }))).status).toBe(422);
      expect((await POST(finalizeRequest({ taskId: "other-task", token: token() }))).status).toBe(422);
      const otherFile = token({ fileId: randomUUID() });
      expect((await POST(finalizeRequest({ taskId: "task", token: otherFile }))).status).toBe(422);
      expect(runtime.database.task).toBeDefined();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an expired token and a token whose object was never staged", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      fixture();
      const expired = token({ expiresAt: Date.now() - 1000 });
      const expiredResponse = await POST(finalizeRequest({ taskId: "task", token: expired }));
      expect(expiredResponse.status).toBe(422);
      expect((await json(expiredResponse)).error.code).toBe("UPLOAD_TOKEN_EXPIRED");
      expect((await POST(finalizeRequest({ taskId: "task", token: token({ fileId: randomUUID() }) }))).status).toBe(422);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("authenticates before reading an invalid JSON body", async () => {
    const f = fixture();
    runtime.auth.mockRejectedValue(new UnauthorizedError());
    const response = await POST(new Request("https://app.test/api/uploads/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));
    expect(response.status).toBe(401);
    expect(f.database.task.findUnique).not.toHaveBeenCalled();
  });

  it("answers a repeated finalize from committed metadata without reading the object again", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      fixture();
      const get = vi.spyOn(store, "get");
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(201);
      const reads = get.mock.calls.length;
      expect((await POST(finalizeRequest({ taskId: "task", token: token() }))).status).toBe(200);
      expect(get.mock.calls.length).toBe(reads);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a new attachment when the task quota is already reached", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task", fileId, Buffer.from(pdf));
      const f = fixture();
      f.state.attachments = Array.from({ length: MAX_TASK_ATTACHMENTS }, () => ({
        url: attachmentFileUrl("task", randomUUID()), name: "report.pdf", size: 1, mime: "application/pdf",
      }));
      const response = await POST(finalizeRequest({ taskId: "task", token: token() }));
      expect(response.status).toBe(409);
      expect((await json(response)).error.code).toBe("ATTACHMENT_QUOTA_EXCEEDED");
      expect(f.state.writes).toBe(0);
      expect(f.state.activities).toBe(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects corrupt staged bytes instead of trusting the declared MIME", async () => {
    const { directory, store } = await localStore();
    try {
      const corrupt = "this is not a pdf at all, no signature";
      await store.putWithId!("task", fileId, Buffer.from(corrupt));
      fixture();
      const response = await POST(finalizeRequest({ taskId: "task", token: token({ size: Buffer.byteLength(corrupt) }) }));
      expect(response.status).toBe(422);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
