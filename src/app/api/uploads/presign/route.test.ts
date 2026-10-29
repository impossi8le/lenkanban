import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  database: {} as Record<string, unknown>,
  auth: vi.fn(),
  config: { enabled: true, storage: "local", directory: "/tmp/unused" } as unknown,
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
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn() }, dbLogger: { error: vi.fn() } }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: vi.fn(async () => undefined),
  rateLimitErrorResponse: vi.fn(() => new Response(JSON.stringify({ error: "RateLimited" }), {
    status: 429, headers: { "Content-Type": "application/json" },
  })),
}));

import { POST, PUT } from "./route";
import { UnauthorizedError } from "@/lib/errors";

const pdf = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n";

function fixture(options: { access?: boolean; taskExists?: boolean; actor?: boolean; marker?: unknown } = {}) {
  const settings = {
    access: options.access ?? true,
    taskExists: options.taskExists ?? true,
    actor: options.actor ?? true,
    marker: options.marker ?? [],
  };
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) return [{ id: "task", projectId: "project", priority: "MEDIUM", version: 1 }];
      return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => settings.actor ? { id: "actor", globalRole: "USER", isBlocked: false, blockedAt: null } : null) },
    project: { findUnique: vi.fn(async () => ({ id: "project", ownerId: settings.access ? "actor" : "other", members: [] })) },
    task: { findFirst: vi.fn(async () => settings.access ? { id: "task" } : null) },
    taskRequest: { findUnique: vi.fn(async ({ select }: { select?: { audienceUserIds?: boolean } }) => { const row = Array.isArray(settings.marker) ? settings.marker[0] ?? null : settings.marker; if (select?.audienceUserIds) return row === null ? null : { authorId: "actor", audienceUserIds: [] }; return row && typeof row === "object" ? { ...row, deletedAt: null } : row; }), findMany: vi.fn(async () => settings.marker) },
  };
  const database = {
    task: { findUnique: vi.fn(async () => settings.taskExists ? { projectId: "project" } : null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  runtime.database = database;
  return { settings, tx, database };
}

function presignRequest(body: unknown) {
  return new Request("https://app.test/api/uploads/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putRequest(token: string | null, body: Uint8Array) {
  // Copy into a plain Uint8Array<ArrayBuffer> view: Buffer is Uint8Array<ArrayBufferLike>,
  // which is not assignable to BodyInit, while the bytes stay identical.
  const bytes = new Uint8Array(body);
  return new Request("https://app.test/api/uploads/presign", {
    method: "PUT",
    headers: {
      "content-type": "application/pdf",
      ...(token ? { "x-attachment-upload-token": token } : {}),
    },
    body: bytes,
  });
}

async function json(response: Response) {
  return JSON.parse(await response.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.config = { enabled: true, storage: "local", directory: "/tmp/unused" };
  runtime.auth.mockResolvedValue({ id: "actor", globalRole: "USER", isBlocked: false, blockedAt: null });
  process.env.ATTACHMENT_UPLOAD_SECRET = "synthetic-upload-secret-value-0123456789";
});

describe("POST /api/uploads/presign", () => {
  it("issues a server-keyed capability without accepting a client key", async () => {
    fixture();
    const response = await POST(presignRequest({ taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 50 }));
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.data.uploadUrl).toBe("/api/uploads/presign");
    expect(body.data.method).toBe("PUT");
    expect(body.data.token).toEqual(expect.any(String));
    expect(body.data.headers["X-Attachment-Upload-Token"]).toBe(body.data.token);
    expect(JSON.stringify(body)).not.toMatch(/bucket|storageKey|"key"/);
  });

  it("rejects a client-supplied key or public URL instead of ignoring it", async () => {
    fixture();
    const response = await POST(presignRequest({
      taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 50, key: "attachments/v1/evil",
    }));
    expect(response.status).toBe(422);
    expect(runtime.database).toBeDefined();
  });

  it("requires authentication before touching the task", async () => {
    const f = fixture();
    runtime.auth.mockRejectedValue(new UnauthorizedError());
    const response = await POST(presignRequest({ taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 50 }));
    expect(response.status).toBe(401);
    expect(f.database.task.findUnique).not.toHaveBeenCalled();
  });

  it("denies a task the actor cannot write", async () => {
    const f = fixture({ access: false });
    const response = await POST(presignRequest({ taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 50 }));
    expect(response.status).toBe(404);
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  });

  it("denies a marker that blocks attachment mutation", async () => {
    const f = fixture({ marker: [{ taskId: "task", contractVersion: 1, state: "DRAFT", authorId: "author", executorId: null }] });
    const response = await POST(presignRequest({ taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 50 }));
    expect(response.status).toBe(409);
    expect(f.tx.taskRequest.findUnique).toHaveBeenCalled();
  });

  it("rejects an unsupported format or an oversized declared size", async () => {
    const f = fixture();
    expect((await POST(presignRequest({ taskId: "task", filename: "evil.exe", mime: "application/octet-stream", size: 10 }))).status)
      .toBe(422);
    expect(f.database.task.findUnique).not.toHaveBeenCalled();
    expect((await POST(presignRequest({ taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 26 * 1024 * 1024 }))).status)
      .toBe(422);
    expect(f.database.task.findUnique).not.toHaveBeenCalled();
  });

  it("authenticates before reading an invalid JSON body", async () => {
    const f = fixture();
    runtime.auth.mockRejectedValue(new UnauthorizedError());
    const response = await POST(new Request("https://app.test/api/uploads/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));
    expect(response.status).toBe(401);
    expect(f.database.task.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a JSON control body above the small limit before parsing it", async () => {
    fixture();
    const response = await POST(presignRequest({
      taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 50, padding: "x".repeat(20_000),
    }));
    expect(response.status).toBe(413);
    expect((await json(response)).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 503 when the upload secret is not configured", async () => {
    fixture();
    delete process.env.ATTACHMENT_UPLOAD_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    const response = await POST(presignRequest({ taskId: "task", filename: "report.pdf", mime: "application/pdf", size: 50 }));
    expect(response.status).toBe(503);
    expect(runtime.auth).not.toHaveBeenCalled();
  });
});

describe("PUT /api/uploads/presign", () => {
  it("presigns and stages marked files while rechecking revocation before body/storage", async () => {
    const { directory, store } = await localStore();
    try {
      const f = fixture({ marker: [{ taskId: "task", contractVersion: 1, state: "SUBMITTED", authorId: "actor", executorId: null }] });
      const issued = await POST(presignRequest({ taskId: "task", filename: "report.pdf", mime: "application/pdf", size: Buffer.byteLength(pdf) }));
      expect(issued.status).toBe(201);
      const issuedToken = (await json(issued)).data.token;
      expect((await PUT(putRequest(issuedToken, Buffer.from(pdf)))).status).toBe(201);
      const payload = JSON.parse(Buffer.from(issuedToken.split(".")[0], "base64url").toString("utf8"));
      expect(await store.get("task", payload.fileId)).toEqual(Buffer.from(pdf));
      f.settings.access = false;
      expect((await PUT(putRequest(issuedToken, Buffer.from(pdf)))).status).toBe(404);
      expect(await store.get("task", payload.fileId)).toEqual(Buffer.from(pdf));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  async function localStore() {
    const directory = await fs.mkdtemp(join(tmpdir(), "taskboard-presign-test-"));
    const actual = await vi.importActual<typeof import("@/lib/attachments/runtime")>("@/lib/attachments/runtime");
    const config = actual.readAttachmentRuntimeConfig({ ATTACHMENT_LOCAL_DIR: join(directory, "private") });
    runtime.config = config;
    const store = actual.createAttachmentStore(config);
    runtime.createStore.mockReturnValue(store);
    return { directory, store };
  }

  async function issue(overrides: Record<string, unknown> = {}) {
    fixture();
    const response = await POST(presignRequest({
      taskId: "task", filename: "report.pdf", mime: "application/pdf", size: Buffer.byteLength(pdf), ...overrides,
    }));
    expect(response.status).toBe(201);
    return (await json(response)).data as { token: string };
  }

  it("stages the bytes under the server key and keeps them out of Task.attachments", async () => {
    const { directory, store } = await localStore();
    try {
      const { token } = await issue();
      const response = await PUT(putRequest(token, Buffer.from(pdf)));
      expect(response.status).toBe(201);
      expect(runtime.database.task).toBeDefined();
      const [encoded] = token.split(".");
      const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
      expect(await store.get("task", payload.fileId)).toEqual(Buffer.from(pdf));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a missing, expired or foreign-actor token before writing", async () => {
    const { directory, store } = await localStore();
    try {
      const { token } = await issue();
      expect((await PUT(putRequest(null, Buffer.from(pdf)))).status).toBe(422);
      runtime.auth.mockResolvedValue({ id: "other-actor", globalRole: "USER", isBlocked: false, blockedAt: null });
      expect((await PUT(putRequest(token, Buffer.from(pdf)))).status).toBe(422);
      const [encoded, signature] = token.split(".");
      const forged = Buffer.from(JSON.stringify({
        ...JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")), actorId: "other-actor",
      }), "utf8").toString("base64url");
      expect((await PUT(putRequest(`${forged}.${signature}`, Buffer.from(pdf)))).status).toBe(422);
      const [, payloadPart] = token.split(".");
      expect(payloadPart).toBeDefined();
      expect(await store.list("task")).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects bytes that do not match the declared size or signature", async () => {
    const { directory, store } = await localStore();
    try {
      const { token } = await issue();
      expect((await PUT(putRequest(token, Buffer.from("short")))).status).toBe(422);
      const corrupt = Buffer.from(pdf.replace("%PDF-1.7", "NOTPDF1"));
      expect((await PUT(putRequest(token, corrupt))).status).toBe(422);
      expect(await store.list("task")).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a body above the 25 MiB per-file limit with 413", async () => {
    const { directory } = await localStore();
    try {
      const { token } = await issue({ size: 25 * 1024 * 1024 });
      const response = await PUT(putRequest(token, Buffer.alloc(25 * 1024 * 1024 + 1)));
      expect(response.status).toBe(413);
      expect((await json(response)).error.code).toBe("PAYLOAD_TOO_LARGE");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a second PUT so validated bytes cannot be replaced", async () => {
    const { directory, store } = await localStore();
    try {
      const { token } = await issue();
      expect((await PUT(putRequest(token, Buffer.from(pdf)))).status).toBe(201);
      const second = await PUT(putRequest(token, Buffer.from(pdf)));
      expect(second.status).toBe(409);
      expect((await json(second)).error.code).toBe("UPLOAD_ALREADY_COMPLETED");
      expect(await store.list("task")).toHaveLength(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("denies staging when access was revoked after presign", async () => {
    const { directory, store } = await localStore();
    try {
      const { token } = await issue();
      const f = fixture({ access: false });
      const response = await PUT(putRequest(token, Buffer.from(pdf)));
      expect(response.status).toBe(404);
      expect(f.database.task.findUnique).toHaveBeenCalled();
      expect(await store.list("task")).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
