import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/socket/board-events", () => ({ emitTaskMessageCreated: vi.fn() }));

const runtime = vi.hoisted(() => ({ database: {} as object, auth: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: runtime.auth, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: runtime.rate, rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));

import { POST } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

type Attachment = { url: string; name: string; size: number; mime: string };
type Data = { taskId: string; authorId: string; clientId?: string; contentText: string; attachments: Attachment[] };
function fixture(taskId = "task") {
  const state = { messages: [] as Data[], version: 12 };
  let working = state;
  const options = { outer: true, actor: true, role: "USER", isBlocked: false, blockedAt: null as Date | null, access: true, project: true, task: true, drift: false,
    marker: [] as unknown, markerRow: null as null | { taskId: string; contractVersion: number; state: string; authorId: string; executorId: string | null },
    storageFailure: false, insertFailure: false, onTaskLock: undefined as undefined | (() => Promise<void>),
    storedAttachments: [] as unknown[] };
  const calls: string[] = [];
  const author = { id: "actor", email: "actor@example.test", name: "Actor", avatarUrl: null, passwordHash: "synthetic-private-password", resetToken: "synthetic-private-token", globalRole: "ADMIN" };
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { calls.push("project-lock"); expect(sql).toContain("FOR UPDATE"); return options.project ? [{ id: "project" }] : []; }
      if (sql.includes('FROM "TaskWatcher"')) { calls.push("watcher"); return []; }
      if (sql.includes('FROM "TaskRequest"')) { calls.push("marker-lock"); return options.markerRow ? [{ taskId }] : []; }
      if (sql.includes('FROM "Task"')) { calls.push("task-lock"); await options.onTaskLock?.(); return options.task ? [{ id: taskId, projectId: options.drift ? "different" : "project", columnId: "column", version: 12, description: null, createdById: "author" }] : []; }
      calls.push("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => { calls.push("fresh-actor"); return options.actor ? { id: "actor", globalRole: options.role, name: null, isBlocked: options.isBlocked, blockedAt: options.blockedAt } : null; }) },
    project: { findUnique: vi.fn(async () => { calls.push("access"); return { id: "project", ownerId: options.access ? "actor" : "outsider", members: options.access ? [{ role: "MEMBER" }] : [], responsibleGroup: null }; }) },
    taskRequest: {
      findUnique: vi.fn(async (input?: { select?: { audienceUserIds?: boolean } }) => { calls.push(input?.select?.audienceUserIds ? "audience" : "marker"); if (options.storageFailure) throw new Error("synthetic-private-storage"); if (input?.select?.audienceUserIds) return options.markerRow === null ? null : { authorId: "author", audienceUserIds: [] }; return options.markerRow === null ? null : { needsInfoSince: null, pausedTotalMs: 0, deletedAt: null, ...options.markerRow }; }),
      findMany: vi.fn(async () => { calls.push("marker-batch"); return options.marker; }),
    },
    task: {
      findFirst: vi.fn(async () => { calls.push("common-task-read"); return options.access ? { id: taskId } : null; }),
      findUnique: vi.fn(async () => { calls.push("read-attachments"); return { attachments: structuredClone(options.storedAttachments) }; }) },
    chatMessage: { create: vi.fn(async ({ data, include }: { data: Data; include: { author: boolean | { select: Record<string, boolean> } } }) => {
      calls.push("insert"); if (options.insertFailure) throw new Error("synthetic-private-insert");
      if (data.clientId && working.messages.some(message => message.clientId === data.clientId)) throw new Error("synthetic-private-unique-clientId");
      working.messages.push(structuredClone(data));
      const projection = include.author;
      return { id: `message-${working.messages.length}`, ...data, author: projection === true ? author : typeof projection === "object"
        ? Object.fromEntries(Object.entries(author).filter(([key]) => projection.select[key])) : undefined };
    }) },
  };
  const database = {
    project: { findMany: vi.fn(async () => [{ id: "project" }]) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    task: {
      findFirst: vi.fn(async () => { calls.push("outer-task"); return options.outer ? { id: taskId, projectId: "project" } : null; }),
      findUnique: vi.fn(async () => { calls.push("outer-group-task"); return null; }),
    },
    chatMessage: { create: vi.fn(() => { throw new Error("MUST_USE_TX_INSERT"); }) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => { working = structuredClone(state); const result = await callback(tx); Object.assign(state, working); calls.push("commit"); return result; },
  };
  const raw = (body: string) => { runtime.database = database; return POST(new Request("http://localhost/api/tasks/task/messages", { method: "POST", headers: { Origin: "http://localhost" }, body }), { params: Promise.resolve({ id: taskId }) }); };
  return { state, options, calls, tx, database, invoke: (body: unknown = { contentText: "Message" }) => raw(JSON.stringify(body)), raw };
}
type Fixture = ReturnType<typeof fixture>;
const marker = (taskId: string, state = "DRAFT") => ({ taskId, contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" });
function noInsert(f: Fixture) { expect(f.tx.chatMessage.create).not.toHaveBeenCalled(); expect(f.database.chatMessage.create).not.toHaveBeenCalled(); expect(f.state.messages).toEqual([]); }
beforeEach(() => { vi.clearAllMocks(); runtime.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" }); runtime.rate.mockResolvedValue(undefined); });

describe("actual HTTP message POST guarded transaction", () => {
  it("rejects cross-origin cookie mutation before any content write", async () => {
    const f = fixture(); runtime.database = f.database;
    const response = await POST(new Request("http://localhost/api/tasks/task/messages", {
      method: "POST", headers: { Origin: "https://foreign.example.test" }, body: JSON.stringify({contentText:"Message"}),
    }), {params: Promise.resolve({id:"task"})});
    expect(response.status).toBe(403); noInsert(f);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(["isBlocked", "blockedAt"] as const)("denies a freshly blocked actor via %s before marker or insert", async field => {
    const f = fixture();
    if (field === "isBlocked") f.options.isBlocked = true;
    else f.options.blockedAt = new Date("2026-10-23T00:00:00Z");
    expect((await f.invoke()).status).toBe(404);
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled();
    noInsert(f);
  });
  it("locks/resources/fresh auth/marker before tx insert, returns public author and201 without accepting caller author", async () => {
    const f = fixture(); const response = await f.invoke({ contentText: " Message ", authorId: "injected", author: { globalRole: "ADMIN" }, clientId: " client-1 " });
    expect(response.status).toBe(201);
    expect(f.calls.slice(0, 9)).toEqual(["outer-task", "project-lock", "task-lock", "access", "watcher", "actor-lock", "fresh-actor", "audience", "access"]);
    expect(f.calls.indexOf("insert")).toBeGreaterThan(-1);
    expect(f.calls.indexOf("insert")).toBeLessThan(f.calls.indexOf("commit"));
    const body = await response.json(); expect(body.data).toMatchObject({ authorId: "actor", clientId: "client-1", contentText: "Message", attachments: [] });
    expect(body.data.author).toEqual({ id: "actor", email: "actor@example.test", name: "Actor", avatarUrl: null });
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private|passwordHash|resetToken|globalRole|injected/);
    expect(f.tx.chatMessage.create).toHaveBeenCalledWith({ data: { taskId: "task", authorId: "actor", clientId: "client-1", contentText: "Message", attachments: [] }, include: { author: { select: { id: true, email: true, name: true, avatarUrl: true } } } });
    expect(f.state.version).toBe(12); expect(f.database.chatMessage.create).not.toHaveBeenCalled();
  });
  it.each(["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED"])("allows a discussion comment by the author on a marked %s request without moving the marker", async state => {
    const f = fixture(); f.options.role = "ADMIN"; f.options.markerRow = { ...marker("task", state), authorId: "actor" };
    const response = await f.invoke(); expect(response.status).toBe(201);
    expect(f.tx.taskRequest.findUnique).toHaveBeenCalledTimes(2);
    expect(f.tx.taskRequest.findUnique).toHaveBeenCalledWith({ where: { taskId: "task" }, select: { authorId: true, audienceUserIds: true } });
    expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
    expect(f.tx.chatMessage.create).toHaveBeenCalledOnce();
  });
  it("denies a new comment on a cancelled request before insert", async () => {
    const f = fixture(); f.options.markerRow = marker("task", "CANCELLED");
    const response = await f.invoke(); expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/authorId|executorId|synthetic-private/); noInsert(f);
  });
  it("keeps a marked draft private to its author", async () => {
    const own = fixture(); own.options.markerRow = { ...marker("task", "DRAFT"), authorId: "actor" };
    expect((await own.invoke()).status).toBe(201);
    const foreign = fixture(); foreign.options.markerRow = marker("task", "DRAFT");
    expect((await foreign.invoke()).status).toBe(409); noInsert(foreign);
  });
  it.each([
    { ...marker("task"), contractVersion: 2 },
    { ...marker("task"), taskId: "different" },
    { ...marker("task"), state: "UNKNOWN" },
    { ...marker("task"), privateSecret: "raw-marker-secret" },
  ])("denies malformed marker row %#", async value => {
    const f = fixture(); f.options.markerRow = value as typeof f.options.markerRow;
    expect((await f.invoke()).status).toBe(409); noInsert(f);
  });
  it.each(["query", "delegate"])("fails closed500 for storage %s", async mode => {
    const f = fixture(); if (mode === "query") f.options.storageFailure = true; else Reflect.deleteProperty(f.tx, "taskRequest");
    const response = await f.invoke(); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); noInsert(f);
  });
  it.each(["actor", "access", "project", "task", "drift"] as const)("denies fresh %s before marker/insert", async field => {
    const f = fixture(); if (field === "drift") f.options.drift = true; else f.options[field] = false;
    expect((await f.invoke()).status).toBe(field === "drift" ? 409 : 404); expect(f.tx.taskRequest.findUnique).toHaveBeenCalledTimes(field === "access" ? 2 : 0); noInsert(f);
  });
  it("rechecks current role/access after waiting for resource lock", async () => {
    const f = fixture(); f.options.role = "ADMIN"; let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); f.options.onTaskLock = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const pending = f.invoke(); await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled(); f.options.role = "USER"; f.options.access = false; release();
    expect((await pending).status).toBe(404); expect(f.tx.taskRequest.findUnique).toHaveBeenCalledTimes(2); noInsert(f);
  });
  it("preserves a custom historical Task ID with absent marker", async () => {
    const f = fixture("задача / legacy"); expect((await f.invoke()).status).toBe(201); expect(f.state.messages[0].taskId).toBe("задача / legacy");
  });
  it.each([{}, { contentText: "   " }, { contentText: "", attachments: [] }])("keeps existing empty-content combinations %#", async body => {
    const f = fixture(); expect((await f.invoke(body)).status).toBe(201); expect(f.state.messages[0]).toMatchObject({ contentText: "", attachments: [] });
  });
  it("accepts only a canonical URL that is already present in Task.attachments", async () => {
    const f = fixture();
    const url = "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
    f.options.storedAttachments = [{ url, name: "a.pdf", size: 4, mime: "application/pdf" }];
    // Client-supplied name/size/mime are ignored; the stored DTO is persisted.
    const response = await f.invoke({ attachments: [{ url: ` ${url} `, name: "evil.html", size: 1, mime: "text/html" }] });
    expect(response.status).toBe(201);
    expect(f.state.messages[0]).toMatchObject({
      contentText: "", attachments: [{ url, name: "a.pdf", size: 4, mime: "application/pdf" }],
    });
    expect((await f.invoke({ contentText: " text ", attachments: [{ url, name: "a.pdf", size: 4, mime: "application/pdf" }] })).status).toBe(201);
    expect(f.state.messages[1]?.contentText).toBe("text");
  });

  it.each([
    "https://public.example/a.pdf",
    "/files/a",
    "/api/tasks/other-task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f",
    "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f?signature=old",
    "/api/tasks/task/files/11111111-1111-4111-8111-111111111111",
  ])("rejects a foreign, external or non-canonical attachment URL %s with 422", async url => {
    const f = fixture();
    f.options.storedAttachments = [{ url: "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "a.pdf", size: 4, mime: "application/pdf" }];
    const response = await f.invoke({ attachments: [{ url, name: "a.pdf", size: 4, mime: "application/pdf" }] });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toMatch(/synthetic-private|public\.example/);
    noInsert(f);
  });

  it("refuses internal attachments for an actor without internal discussion access", async () => {
    const f = fixture();
    runtime.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
    const url = "/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
    f.options.storedAttachments = [{ url, name: "a.pdf", size: 4, mime: "application/pdf" }];
    const response = await f.invoke({ contentText: "x", visibility: "INTERNAL", attachments: [{ url, name: "a.pdf", size: 4, mime: "application/pdf" }] });
    expect(response.status).toBe(403);
    noInsert(f);
  });
  it("passes optional clientId through and leaves duplicate rejection to existing storage semantics", async () => {
    const f = fixture(); expect((await f.invoke({ clientId: "same", contentText: "1" })).status).toBe(201);
    const duplicate = await f.invoke({ clientId: "same", contentText: "2" }); expect(duplicate.status).toBe(500);
    expect(JSON.stringify(await duplicate.json())).not.toContain("synthetic-private");
    expect(f.state.messages).toHaveLength(1); expect(f.tx.chatMessage.create).toHaveBeenCalledTimes(2);
  });
  it.each([{ contentText: "x".repeat(20_001) }, { clientId: "x".repeat(201) }, { clientId: " " }, { attachments: [{ url: "a", name: "b", size: -1, mime: "text/plain" }] }])("retains invalid body422 before auth/rate %#", async body => {
    const f = fixture(); expect((await f.invoke(body)).status).toBe(422); expect(runtime.auth).not.toHaveBeenCalled(); expect(runtime.rate).not.toHaveBeenCalled(); noInsert(f);
  });
  it("retains exact accepted text/clientId limits", async () => {
    const f = fixture(); expect((await f.invoke({ contentText: "x".repeat(20_000), clientId: "c".repeat(200) })).status).toBe(201); expect(f.state.messages[0].contentText).toHaveLength(20_000);
  });
  it("retains malformedJSON400 before auth", async () => {
    const f = fixture(); expect((await f.raw("{")).status).toBe(400); expect(runtime.auth).not.toHaveBeenCalled(); noInsert(f);
  });
  it("retains unauthenticated401/rate429/missing404 boundaries", async () => {
    const f = fixture(); runtime.auth.mockRejectedValueOnce(new UnauthorizedError()); expect((await f.invoke()).status).toBe(401); expect(runtime.rate).not.toHaveBeenCalled();
    runtime.rate.mockRejectedValueOnce(new Error("limit")); expect((await f.invoke()).status).toBe(429); expect(f.database.task.findFirst).not.toHaveBeenCalled();
    f.options.outer = false; expect((await f.invoke()).status).toBe(404); expect(f.tx.$queryRaw).not.toHaveBeenCalled(); noInsert(f);
  });
  it("returns safe500 for an insert failure and does not apply fake tx state", async () => {
    const f = fixture(); f.options.insertFailure = true; const response = await f.invoke(); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); expect(f.state.messages).toEqual([]); expect(f.calls).not.toContain("commit");
  });
});
