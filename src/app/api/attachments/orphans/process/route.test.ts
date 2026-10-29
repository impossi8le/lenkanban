import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type TaskRow = { id: string; attachments: unknown };
type TaskDatabase = { task: { findMany: Mock<() => Promise<TaskRow[]>> } };

const runtime = vi.hoisted(() => ({
  database: {} as TaskDatabase,
  config: { enabled: true, storage: "local", directory: "/tmp/unused" } as unknown,
  createStore: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/attachments/runtime", () => ({
  readAttachmentRuntimeConfig: () => runtime.config,
  createAttachmentStore: runtime.createStore,
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: runtime.error, warn: vi.fn() }, dbLogger: { error: vi.fn() } }));

import { POST } from "./route";
import { attachmentFileUrl } from "@/lib/attachments/task-port";
import { ORPHAN_GRACE_MS } from "@/lib/attachments/orphans";

const cronSecret = "synthetic-cron-secret-value";
const liveId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
const orphanId = "11111111-1111-4111-8111-111111111111";

function request(authorization?: string) {
  return new Request("https://app.test/api/attachments/orphans/process", {
    method: "POST",
    ...(authorization ? { headers: { authorization } } : {}),
  });
}

async function json(response: Response) {
  return JSON.parse(await response.text());
}

async function localStore() {
  const directory = await fs.mkdtemp(join(tmpdir(), "taskboard-orphans-test-"));
  const actual = await vi.importActual<typeof import("@/lib/attachments/runtime")>("@/lib/attachments/runtime");
  const config = actual.readAttachmentRuntimeConfig({ ATTACHMENT_LOCAL_DIR: join(directory, "private") });
  runtime.config = config;
  const store = actual.createAttachmentStore(config);
  runtime.createStore.mockReturnValue(store);
  return { directory, store };
}

function tasks(rows: Array<{ id: string; attachments: unknown }>) {
  runtime.database = { task: { findMany: vi.fn(async () => rows) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.config = { enabled: true, storage: "local", directory: "/tmp/unused" };
  process.env.CRON_SECRET = cronSecret;
});

describe("POST /api/attachments/orphans/process", () => {
  it("fails closed when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    tasks([]);
    const response = await POST(request(`Bearer ${cronSecret}`));
    expect(response.status).toBe(503);
    expect(runtime.database.task.findMany).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong bearer", async () => {
    tasks([]);
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("Bearer wrong"))).status).toBe(401);
    expect(runtime.database.task.findMany).not.toHaveBeenCalled();
  });

  it("deletes only unreferenced objects older than the grace period", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task-1", liveId, Buffer.from("live"));
      await store.putWithId!("task-1", orphanId, Buffer.from("orphan"));
      const old = new Date(Date.now() - ORPHAN_GRACE_MS - 60_000);
      await fs.utimes(
        join(directory, "private", "attachments", "v1",
          (await import("node:crypto")).createHash("sha256").update("task-1", "utf8").digest("hex"), orphanId),
        old, old,
      );
      tasks([{ id: "task-1", attachments: [{ url: attachmentFileUrl("task-1", liveId), name: "a.pdf", size: 4, mime: "application/pdf" }] }]);

      const response = await POST(request(`Bearer ${cronSecret}`));
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.data).toMatchObject({ scanned: 1, deleted: 1 });
      const remaining = (await store.list("task-1")).map(object => object.fileId);
      expect(remaining).toEqual([liveId]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a fresh unreferenced object because an upload may still be finalizing", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task-1", orphanId, Buffer.from("orphan"));
      tasks([{ id: "task-1", attachments: [] }]);
      const response = await POST(request(`Bearer ${cronSecret}`));
      expect(response.status).toBe(200);
      expect((await json(response)).data.deleted).toBe(0);
      expect((await store.list("task-1")).map(object => object.fileId)).toEqual([orphanId]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("continues past one failing task and reports the failure", async () => {
    const { directory, store } = await localStore();
    try {
      await store.putWithId!("task-2", liveId, Buffer.from("live"));
      tasks([
        { id: "../escape", attachments: [] },
        { id: "task-2", attachments: [{ url: attachmentFileUrl("task-2", liveId), name: "a.pdf", size: 4, mime: "application/pdf" }] },
      ]);
      const response = await POST(request(`Bearer ${cronSecret}`));
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.data.scanned).toBe(2);
      expect(body.data.failed).toBe(1);
      expect(body.data.results[0]).toEqual({ taskId: "../escape", success: false });
      expect(runtime.error).toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("returns 503 when storage is not configured", async () => {
    runtime.config = { enabled: false, reason: "disabled" };
    tasks([{ id: "task-1", attachments: [] }]);
    expect((await POST(request(`Bearer ${cronSecret}`))).status).toBe(503);
  });
});
