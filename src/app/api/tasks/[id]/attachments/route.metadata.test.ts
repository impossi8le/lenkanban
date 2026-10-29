import { beforeEach, describe, expect, it, vi } from "vitest";

// Use real project access for both permitted mutations and revoked-access denials.
const runtime = vi.hoisted(() => ({
  database: {} as object,
  auth: vi.fn(), load: vi.fn(), emit: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }),
}));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: runtime.auth,
  UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError,
}));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: runtime.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: runtime.emit }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn() }, dbLogger: { error: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { PATCH } from "./route";

const limit = 25 * 1024 * 1024;
const metadata = { url: "synthetic-file-reference", name: "synthetic-file", mime: "image/png", size: 16 };

function fixture(marked = false) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      const query = sql.join("?");
      if (query.includes('FROM "Project"')) {
        calls.push("project-lock"); return [{ id: "project" }];
      }
      if (query.includes('FROM "Task"')) {
        calls.push("task-lock"); return [{ id: "task", projectId: "project", version: 1, priority: "MEDIUM" }];
      }
      calls.push("actor-lock"); return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => {
      calls.push("fresh-actor"); return { id: "actor", globalRole: "USER" };
    }) },
    project: { findUnique: vi.fn(async () => {
      calls.push("fresh-access"); return { id: "project", ownerId: "actor", members: [] };
    }) },
    taskRequest: { findMany: vi.fn(async () => {
      calls.push("marker"); return marked ? [{
        taskId: "task", contractVersion: 1, state: "DRAFT", authorId: "actor", executorId: null,
      }] : [];
    }) },
    task: { findUnique: vi.fn(async () => ({ attachments: [] })), update: vi.fn(async ({ data }: { data: { attachments: unknown[] } }) => {
      calls.push("write"); return { id: "task", projectId: "project", version: 1, attachments: data.attachments };
    }) },
  };
  const database = {
    task: { findFirst: vi.fn(async () => ({ id: "task", projectId: "project" })), update: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx); calls.push("commit"); return result;
    }),
  };
  runtime.database = database;
  const invoke = (attachments: unknown[]) => PATCH(new Request("https://app.test/api/tasks/task/attachments", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachments }),
  }), { params: Promise.resolve({ id: "task" }) });
  return { tx, database, calls, invoke };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
  runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } });
  runtime.emit.mockResolvedValue(undefined);
});

describe("attachment numeric metadata validation", () => {
  it("denies an unrelated user before metadata mutation with real access", async () => {
    const f = fixture();
    f.tx.project.findUnique.mockResolvedValueOnce({ id: "project", ownerId: "other", members: [] });
    expect((await f.invoke([])).status).toBe(404);
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
    expect(f.tx.task.findUnique).not.toHaveBeenCalled();
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(runtime.emit).not.toHaveBeenCalled();
  });
  const invalidSizes = [
    { label: "negative", size: -1 },
    { label: "fractional", size: 0.5 },
    { label: "over 25 MiB", size: limit + 1 },
    { label: "unsafe integer", size: Number.MAX_SAFE_INTEGER + 1 },
  ];
  const invalidDimensions = ["width", "height"].flatMap(field => [
    { label: `${field} zero`, value: { [field]: 0 } },
    { label: `${field} negative`, value: { [field]: -1 } },
    { label: `${field} fractional`, value: { [field]: 1.5 } },
    { label: `${field} unsafe integer`, value: { [field]: Number.MAX_SAFE_INTEGER + 1 } },
  ]);

  it.each([
    ...invalidSizes.map(({ label, size }) => ({ label: `size ${label}`, attachment: { ...metadata, size } })),
    ...invalidDimensions.map(({ label, value }) => ({ label, attachment: { ...metadata, ...value } })),
  ])("rejects authenticated $label before task lookup, transaction, write or realtime", async ({ attachment }) => {
    const f = fixture();
    const response = await f.invoke([{ ...metadata, name: "synthetic-valid-first" }, attachment]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(runtime.auth).toHaveBeenCalledOnce();
    expect(f.database.task.findFirst).not.toHaveBeenCalled();
    expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.database.task.update).not.toHaveBeenCalled();
    expect(runtime.load).not.toHaveBeenCalled();
    expect(runtime.emit).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  const validArrays = [
    { label: "zero bytes and omitted dimensions", attachments: [{ ...metadata, size: 0 }] },
    { label: "exactly 25 MiB", attachments: [{ ...metadata, size: limit }] },
    { label: "positive safe integer dimensions", attachments: [{ ...metadata, width: 1, height: Number.MAX_SAFE_INTEGER }] },
    { label: "empty attachment list", attachments: [] },
  ];

  it.each(validArrays)("accepts $label through the existing shared guard", async ({ attachments }) => {
    const f = fixture();
    const response = await f.invoke(attachments);
    expect(response.status).toBe(200);
    expect(f.calls).toEqual(["project-lock", "task-lock", "actor-lock", "fresh-actor", "fresh-access", "marker", "write", "commit"]);
    expect(f.tx.task.update).toHaveBeenCalledWith(expect.objectContaining({ data: { attachments } }));
    expect((await response.json()).data).toMatchObject({ attachments, version: 1 });
    expect(runtime.emit).toHaveBeenCalledWith("project", { id: "task", project: { id: "project" } });
  });

  it.each(validArrays)("keeps the lifecycle guard for $label", async ({ attachments }) => {
    const f = fixture(true);
    const response = await f.invoke(attachments);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_LIFECYCLE_NOT_ENABLED" } });
    expect(f.tx.taskRequest.findMany).toHaveBeenCalledOnce();
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.database.task.update).not.toHaveBeenCalled();
    expect(runtime.load).not.toHaveBeenCalled();
    expect(runtime.emit).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("commit");
  });
});
