import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Item = { id: string; taskId: string; text: string; completed: boolean; position: number };
const runtime = vi.hoisted(() => ({ database: {} as object, authenticated: true,
  load: vi.fn(), emit: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError, requireApiUser: async () => {
    if (!runtime.authenticated) throw new UnauthorizedError();
    // Deliberately cached ADMIN: the service must read current database rights.
    return { id: "actor", globalRole: "ADMIN" };
  } };
});
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: runtime.load }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: runtime.emit }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: runtime.warn, error: runtime.error }, dbLogger: { error: runtime.error } }));
vi.mock("@/lib/telemetry/store", () => ({ projectChecklistTelemetry: vi.fn() }));

import { createChecklistItem, deleteChecklistItem } from "./checklist-toggle";
import { POST } from "@/app/api/tasks/[id]/checklist/route";
import { DELETE } from "@/app/api/tasks/[id]/checklist/[itemId]/route";

function fixture(taskId = "task") {
  const state = { items: [{ id: "item", taskId, text: "synthetic-private-item", completed: true, position: 7 }] as Item[],
    activities: [] as unknown[], version: 23 };
  const options = { role: "USER", actor: true, access: true, identity: true, project: true,
    task: true, drift: false, marker: null as unknown, markerFailure: false, auditFailure: false,
    afterTaskLock: undefined as undefined | (() => Promise<void>) };
  const calls: string[] = [];
  let working = state;
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); expect(values).toContain("project"); return options.project ? [{ id: "project" }] : []; }
      if (sql.includes('FROM "Task"')) {
        calls.push("task-lock"); expect(values).toEqual([taskId]); expect(sql).toContain('SELECT "id", "projectId"');
        await options.afterTaskLock?.();
        return options.task ? [{ id: taskId, projectId: options.drift ? "other-project" : "project" }] : [];
      }
      if (sql.includes('FROM "User"')) { calls.push("actor-lock"); expect(sql).toContain("FOR SHARE"); return options.actor ? [{ id: "actor" }] : []; }
      throw new Error("Unexpected lock");
    }),
    task: { findUnique: vi.fn(async () => { calls.push("identity"); return options.identity ? { projectId: "project" } : null; }) },
    user: { findUnique: vi.fn(async () => { calls.push("fresh-actor"); return options.actor ? { id: "actor", globalRole: options.role } : null; }) },
    project: { findUnique: vi.fn(async () => { calls.push("access"); return { id: "project", ownerId: options.access ? "actor" : "outsider", members: [] }; }) },
    taskRequest: { findUnique: vi.fn(async () => { calls.push("marker"); if (options.markerFailure) throw new Error("synthetic-private-storage"); return options.marker; }) },
    taskChecklistItem: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: { taskId: string; id?: string }; orderBy?: object }) => {
        calls.push("child-read"); const candidates = working.items.filter(i => i.taskId === where.taskId && (!where.id || i.id === where.id));
        return structuredClone((orderBy ? candidates.sort((a, b) => b.position - a.position) : candidates)[0] ?? null);
      }),
      create: vi.fn(async ({ data }: { data: Omit<Item, "id" | "completed"> }) => { calls.push("create"); const item = { ...data, id: "created", completed: false }; working.items.push(item); return structuredClone(item); }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => { calls.push("delete"); working.items = working.items.filter(i => i.id !== where.id); }),
    },
    activity: { create: vi.fn(async ({ data }: { data: unknown }) => { calls.push("audit"); if (options.auditFailure) throw new Error("synthetic-private-audit"); working.activities.push(data); return data; }) },
  };
  const database = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
    working = structuredClone(state);
    const result = await callback(tx);
    Object.assign(state, working);
    return result;
  } };
  const input = { database: database as unknown as Pick<PrismaClient, "$transaction">, actorId: "actor", taskId };
  return { state, options, tx, calls, database, run: (kind: "create" | "delete") => kind === "create"
    ? createChecklistItem({ ...input, text: "synthetic-private-new" })
    : deleteChecklistItem({ ...input, itemId: "item" }) };
}
type Fixture = ReturnType<typeof fixture>;
const kinds = ["create", "delete"] as const;
const states = ["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"];
function marker(state: string) { return { taskId: "task", contractVersion: 1, state, authorId: "author", executorId: state === "DRAFT" || state === "SUBMITTED" ? null : "executor" }; }
function noChildren(f: Fixture) {
  expect(f.tx.taskChecklistItem.findFirst).not.toHaveBeenCalled();
  expect(f.tx.taskChecklistItem.create).not.toHaveBeenCalled();
  expect(f.tx.taskChecklistItem.delete).not.toHaveBeenCalled();
  expect(f.tx.activity.create).not.toHaveBeenCalled();
  expect(runtime.load).not.toHaveBeenCalled(); expect(runtime.emit).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.authenticated = true;
  runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } });
  runtime.emit.mockResolvedValue(undefined); runtime.warn.mockImplementation(() => {}); runtime.error.mockImplementation(() => {});
});

describe.each(kinds)("checklist %s authoritative transaction", kind => {
  it("uses resource locks before fresh actor, policy and marker; no version mutation", async () => {
    const f = fixture(); await f.run(kind);
    expect(f.calls.slice(0, 7)).toEqual(["identity", "project-lock", "task-lock", "actor-lock", "fresh-actor", "access", "marker"]);
    expect(f.state.version).toBe(23); expect(f.state.activities).toHaveLength(1);
    expect(f.tx.taskRequest.findUnique).toHaveBeenCalledWith({ where: { taskId: "task" }, select: { taskId: true, contractVersion: true, state: true, authorId: true, executorId: true } });
  });
  it.each(states)("rejects marked state %s even for ADMIN", async state => {
    const f = fixture(); f.options.role = "ADMIN"; f.options.marker = marker(state);
    await expect(f.run(kind)).rejects.toThrow("REQUEST_LIFECYCLE_NOT_ENABLED"); noChildren(f);
  });
  it.each([undefined, {}, { ...marker("DRAFT"), taskId: "different" }, { ...marker("DRAFT"), contractVersion: 2 }, { ...marker("DRAFT"), state: "UNKNOWN" }])("rejects malformed marker %#", async value => {
    const f = fixture(); f.options.marker = value;
    await expect(f.run(kind)).rejects.toThrow("INVALID_REQUEST_MARKER"); noChildren(f);
  });
  it.each(["query", "delegate"])("fails closed on %s failure", async failure => {
    const f = fixture(); if (failure === "query") f.options.markerFailure = true;
    else Reflect.deleteProperty(f.tx, "taskRequest");
    if (failure === "query") await expect(f.run(kind)).rejects.toThrow("synthetic-private-storage");
    else await expect(f.run(kind)).rejects.toBeInstanceOf(TypeError);
    expect(f.calls).toContain("fresh-actor"); noChildren(f);
  });
  it.each(["identity", "project", "task", "actor", "access"] as const)("denies absent/unauthorized %s before marker", async field => {
    const f = fixture(); f.options[field] = false;
    await expect(f.run(kind)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled(); noChildren(f);
  });
  it("rejects identity drift before actor/marker", async () => {
    const f = fixture(); f.options.drift = true;
    await expect(f.run(kind)).rejects.toMatchObject({ name: "ConflictError" });
    expect(f.tx.user.findUnique).not.toHaveBeenCalled(); noChildren(f);
  });
  it("reads revoked access after a deferred resource lock", async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    f.options.afterTaskLock = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const result = f.run(kind).then(() => ({ name: "unexpected-success" }), (error: unknown) => error);
    await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled();
    f.options.access = false; release(); expect(await result).toMatchObject({ name: "NotFoundError" });
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled(); noChildren(f);
  });
  it("preserves legacy custom task IDs when marker is null", async () => {
    const f = fixture("задача / legacy"); await expect(f.run(kind)).resolves.toMatchObject({ projectId: "project" });
    expect(f.state.activities).toHaveLength(1);
  });
  it("propagates mandatory audit failure and discards the fake transaction working state", async () => {
    const f = fixture(); const before = structuredClone(f.state); f.options.auditFailure = true;
    await expect(f.run(kind)).rejects.toThrow("synthetic-private-audit"); expect(f.state).toEqual(before);
  });
});

it.each([0, 18])("create keeps legacy next position %i", async expected => {
  const f = fixture(); f.state.items = expected === 0 ? [] : [f.state.items[0], { ...f.state.items[0], id: "later", position: 17 }];
  const result = await f.run("create"); expect(result).toMatchObject({ item: { position: expected, text: "synthetic-private-new" } });
  expect(f.state.activities).toEqual([expect.objectContaining({ action: "checklist_item_added", userId: "actor", newValue: { itemId: "created", text: "synthetic-private-new", completed: false } })]);
});
it.each(["missing", "other-task"])("delete isolates %s item", async mode => {
  const f = fixture(); if (mode === "missing") f.state.items = []; else f.state.items[0].taskId = "other-task";
  const before = structuredClone(f.state); await expect(f.run("delete")).rejects.toMatchObject({ name: "NotFoundError" });
  expect(f.state).toEqual(before); expect(f.tx.taskChecklistItem.delete).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled();
});

function route(kind: "create" | "delete", f: Fixture) {
  runtime.database = f.database;
  const request = new Request("http://localhost/api/tasks/task/checklist/item", { method: kind === "create" ? "POST" : "DELETE",
    ...(kind === "create" ? { body: JSON.stringify({ text: "synthetic-private-new" }) } : {}) });
  const context = { params: Promise.resolve({ id: "task", itemId: "item" }) };
  return kind === "create" ? POST(request, context) : DELETE(request, context);
}
describe.each(kinds)("actual checklist %s route", kind => {
  it("does not emit a postcommit snapshot from a different project", async () => {
    const f = fixture(); runtime.load.mockResolvedValue({ id: "task", project: { id: "other-project" } });
    const response = await route(kind, f); expect(response.status).toBe(kind === "create" ? 201 : 200);
    expect(f.state.activities).toHaveLength(1); expect(runtime.emit).not.toHaveBeenCalled();
  });
  it("preserves successful envelope and emits after committed audit", async () => {
    const f = fixture(); runtime.emit.mockImplementation(() => { expect(f.state.activities).toHaveLength(1); });
    const response = await route(kind, f); expect(response.status).toBe(kind === "create" ? 201 : 200);
    expect(await response.json()).toMatchObject({ data: kind === "create" ? { id: "created", position: 8 } : { success: true } });
    expect(runtime.emit).toHaveBeenCalledOnce();
  });
  it.each(["load", "emit", "logger"])("keeps committed success despite postcommit %s failure", async failure => {
    const f = fixture(); const secret = new Error("synthetic-private-delivery");
    if (failure === "load") runtime.load.mockRejectedValue(secret); else runtime.emit.mockRejectedValue(secret);
    if (failure === "logger") { runtime.warn.mockImplementation(() => { throw secret; }); runtime.error.mockImplementation(() => { throw secret; }); }
    const response = await route(kind, f); expect(response.status).toBe(kind === "create" ? 201 : 200);
    expect(JSON.stringify(await response.json())).not.toContain(secret.message); expect(f.state.activities).toHaveLength(1);
  });
  it.each(["marker", "malformed", "storage", "outsider", "unauthenticated"])("returns safe failure for %s with zero effects", async failure => {
    const f = fixture(); let status = 409;
    if (failure === "marker") f.options.marker = marker("DRAFT");
    if (failure === "malformed") f.options.marker = undefined;
    if (failure === "storage") { f.options.markerFailure = true; status = 500; }
    if (failure === "outsider") { f.options.access = false; status = 404; }
    if (failure === "unauthenticated") { runtime.authenticated = false; status = 401; }
    const response = await route(kind, f); expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toMatch(/synthetic-private|authorId|executorId/); noChildren(f);
  });
});
