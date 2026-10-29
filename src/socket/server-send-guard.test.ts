import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentFileUrl } from "@/lib/attachments/task-port";

const runtime = vi.hoisted(() => ({ database: {} as object, policies: null as import("./visibility-delivery").VisibilityDeliveryDependencies | null, io: { use: vi.fn(), on: vi.fn(), to: vi.fn() }, delivery: { task: vi.fn(), revalidate: vi.fn(), dispatch: vi.fn() }, notify: vi.fn(),contentPersist:vi.fn(), mentionDeliver: vi.fn(), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@prisma/client", async importOriginal => ({ ...await importOriginal<typeof import("@prisma/client")>(), PrismaClient: class { constructor() { return new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }); } } }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("socket.io", () => ({ Server: class { constructor() { return runtime.io; } } }));
vi.mock("@/lib/notifications", async original => ({ ...await original<typeof import("@/lib/notifications")>(), deliverNotifications: (rows:{id:string}[])=>rows[0]?.id==="ordinary-notification"?runtime.notify(rows):runtime.mentionDeliver(rows) }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-notifications",()=>({persistTaskContentNotifications:runtime.contentPersist}));
vi.mock("@/lib/logger", () => ({ socketLogger: runtime.logger, dbLogger: { error: vi.fn() } }));
vi.mock("./visibility-delivery", () => ({ createVisibilityDelivery: (policies: import("./visibility-delivery").VisibilityDeliveryDependencies) => { runtime.policies = policies; return runtime.delivery; } }));

const input = { taskId: "task", clientId: "client", contentText: "Message", attachments: [] };
const author = { id: "actor", email: "actor@example.test", name: "Current author", avatarUrl: null, passwordHash: "synthetic-private-password", globalRole: "ADMIN" };
const canonical = () => ({ id: "message", taskId: "task", clientId: "client", authorId: "actor", contentText: "Canonical edited", attachments: [] as unknown[], mentions: [] as string[], reactions: {}, readBy: {}, author });
type Message = ReturnType<typeof canonical>;
type Projection = { author: boolean | { select: Record<string, boolean> } };
type Handler = (payload: unknown, ack?: (result: { ok: boolean; error?: string; retryAfter?: number }) => void) => Promise<void>;
function publicMessage(message: Message, include: Projection) {
  const projection = include.author;
  return { ...message, author: projection === true ? message.author : typeof projection === "object"
    ? Object.fromEntries(Object.entries(message.author).filter(([key]) => projection.select[key])) : undefined };
}
function fixture() {
  const options = { outerTask: true, outerAccess: true, outerUser: true, role: "USER", relation: "owner", actor: true,
    project: true, task: true, drift: false, reader: true, blocked: false, deleted: false, contentRole: "none", marker: [] as unknown, storageFailure: false, quotaFailure: false,
    mentionRecipients: ["mentioned", "second"] as string[], mentionNotificationFailure: false,
    existing: null as Message | null, race: false, insertFailure: false, taskAttachments: [] as unknown[],
    onTaskLock: undefined as undefined | (() => Promise<void>), onUnwind: undefined as undefined | (() => void), onCommit: undefined as undefined | (() => void) };
  const readable = () => options.reader && (options.role === "ADMIN" || options.relation !== "outsider" || options.contentRole !== "none");
  const state = { messages: [] as Message[], notifications: [] as Record<string, unknown>[] };
  let active = false, aborted = false, number = 0;
  let working = state;
  const trace: string[] = [];
  const check = (name: string) => { if (!active || aborted) throw new Error("QUERY_IN_ABORTED_OR_CLOSED_TX"); trace.push(`tx${number}:${name}`); };
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { check("project-lock"); return options.project ? [{ id: "project" }] : []; }
      if (sql.includes('"isInternal"')) return [];
      if (sql.includes('FROM "ResponsibleGroupMember"')) { check("group-member-lock"); return options.contentRole === "group" ? [{ userId: "actor" }] : []; }
      if (sql.includes('FROM "ResponsibleGroup"')) { check("group-lock"); return [{ id: "group", archivedAt: null, leaderId: null }]; }
      if (sql.includes('FROM "TaskWatcher"')) { check("watcher-lock"); return options.contentRole === "watcher" ? [{ userId: "actor" }] : []; }
      if (sql.includes('FROM "TaskRequest"')) { check("request-lock"); return [{ taskId: "task" }]; }
      if (sql.includes('FROM "Task"')) { check("task-lock"); await options.onTaskLock?.(); return options.task ? [{ id: "task", projectId: options.drift ? "changed-project" : "project", priority: "MEDIUM", version: 4 }] : []; }
      check("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }];
    }),
    project: { findUnique: vi.fn(async () => { check("access"); return { responsibleGroupId: options.contentRole === "group" ? "group" : null, department: null, ownerId: options.relation === "owner" ? "actor" : "other", members: options.relation === "member" ? [{ userId: "actor", role: "MEMBER" }] : [] }; }), findMany: vi.fn(async () => [{ id: "project" }]) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { check("fresh-actor"); return options.actor ? { id: where.id, globalRole: where.id === "actor" ? options.role : "USER", name: "Current author", isBlocked: options.blocked, blockedAt: null } : null; }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => { check("mention-recipients"); return where.id.in.filter(id => options.mentionRecipients.includes(id) || id === "actor").map(id => ({ id, globalRole: "USER", isBlocked: false, blockedAt: null })); }),
      findFirst: vi.fn(async () => { check("mention"); return { id: "mentioned" }; }),
    },
    taskRequest: { findUnique: vi.fn(async ({ select }: { select: Record<string, boolean> }) => {
      check("request-read"); if (options.storageFailure) throw new Error("synthetic-private-storage");
      if (Array.isArray(options.marker) && options.marker.length === 0) return null;
      if (select.audienceUserIds) return { authorId: "author", audienceUserIds: [] };
      if (Object.keys(select).length === 1) return { taskId: "task" };
      const row = Array.isArray(options.marker) ? options.marker[0] : options.marker;
      return { ...row, deletedAt: options.deleted ? new Date("2026-01-01") : null };
    }), findMany: vi.fn(async () => { check("marker"); if (options.storageFailure) throw new Error("synthetic-private-storage"); return options.marker; }) },
    task: { findUnique: vi.fn(async () => { check("current-task"); return { id: "task", projectId: "project", title: "Current locked title", attachments: options.taskAttachments }; }), findFirst: vi.fn(async () => readable() ? { id: "task", projectId: "project" } : null) },
    notification: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { check("mention-notification"); if (options.mentionNotificationFailure) throw new Error("notification-failed"); working.notifications.push(data); return { ...data, id: "notification", createdAt: new Date(), read: false, readAt: null }; }) },
    chatMessage: {
      findUnique: vi.fn(async ({ include }: { include: Projection }) => { check("existing"); return options.existing ? publicMessage(options.existing, include) : null; }),
      create: vi.fn(async ({ data, include }: { data: Omit<Message, "id" | "author">; include: Projection }) => {
        check("insert"); if (options.race) { aborted = true; throw { code: "P2002", meta: { target: ["clientId"] } }; }
        if (options.insertFailure) throw new Error("synthetic-private-insert");
        const message = { ...data, id: "new-message", author }; working.messages.push(message); return publicMessage(message, include);
      }),
    },
  };
  const quota = new Map<string, number>();
  const database = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      if (!parts.join("?").includes('INSERT INTO "RateLimit"')) return [];
      if (options.quotaFailure) throw new Error("synthetic-private-quota-storage");
      const key = String(values[0]); const count = quota.get(key) ?? 0;
      const limit = Number(values.at(-1));
      if (count >= limit) return [];
      quota.set(key, count + 1); return [{ count: count + 1 }];
    }),
    task: { findUnique: vi.fn(async () => options.outerTask ? { id: "task", projectId: "project", title: "Stale outer title", attachments: options.taskAttachments } : null), findFirst: vi.fn(async () => options.outerAccess && readable() ? { id: "task", projectId: "project" } : null) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    project: { findMany: vi.fn(async () => [{ id: "project" }]), findUnique: vi.fn(async () => options.outerAccess ? {
      id: "project",
      ownerId: options.relation === "owner" ? "actor" : "other",
      members: options.relation === "member" ? [{ userId: "actor", role: "MEMBER" }] : [],
    } : null) },
    user: { findUnique: vi.fn(async () => options.outerUser ? { id: "actor", globalRole: options.role, isBlocked: options.blocked, blockedAt: null } : null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      if (active) throw new Error("OVERLAPPING_TX"); active = true; aborted = false; number++; trace.push(`tx${number}:start`); working = structuredClone(state);
      try { const result = await callback(tx); Object.assign(state, working); trace.push(`tx${number}:commit`); options.onCommit?.(); return result; }
      catch (error) { trace.push(`tx${number}:unwind`); options.onUnwind?.(); throw error; }
      finally { active = false; }
    }),
  };
  return { options, state, trace, tx, database, quota };
}
let send: Handler;
let disconnects: Array<() => Promise<void> | undefined>;
let direct: ReturnType<typeof vi.fn>, broadcast: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let f: ReturnType<typeof fixture>;
beforeEach(async () => {
  vi.useFakeTimers();
  disconnects = [];
  vi.resetModules(); vi.resetAllMocks(); f = fixture(); runtime.database = f.database; runtime.notify.mockResolvedValue(undefined);runtime.contentPersist.mockResolvedValue([{id:"ordinary-notification"}]); runtime.delivery.revalidate.mockResolvedValue(true);
  await import("./server");
  direct = vi.fn(); broadcast = vi.fn(); runtime.io.to.mockReturnValue({ emit: broadcast });
  runtime.delivery.task.mockImplementation(async (_taskId, event, data) => { broadcast(event, data); });
  const handlers = new Map<string, Handler>(); const connection = runtime.io.on.mock.calls.find(([event]) => event === "connection")![1];
  connection({ id: "socket", data: { userId: "actor", userName: "Cached author", globalRole: "ADMIN" }, on: (event: string, handler: Handler) => handlers.set(event, handler), emit: direct, to: vi.fn() });
  disconnects.push(() => handlers.get("disconnect")?.(undefined));
  send = handlers.get("message:send")!;
});
const marker = (state = "DRAFT") => ({ taskId: "task", contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" });
function noEffects() { expect(f.tx.chatMessage.create).not.toHaveBeenCalled(); expect(direct).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(runtime.delivery.task).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled(); }

describe("actual socket SEND shared guard", () => {
  it.each([false, true])("limits 61 actual PUBLIC sends to 60 commits (marked=%s)", async marked => {
    if (marked) { f.options.contentRole = "author"; f.options.marker = [{ ...marker("SUBMITTED"), authorId: "actor" }]; }
    for (let i = 0; i < 60; i++) {
      const ack = vi.fn(); await send({ ...input, clientId: `quota-${i}` }, ack);
      expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
    }
    const ack = vi.fn(); await send({ ...input, clientId: "quota-61" }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "RateLimited", retryAfter: 60 });
    expect(f.state.messages).toHaveLength(60); expect(f.database.$transaction).toHaveBeenCalledTimes(60);
    expect(runtime.notify).toHaveBeenCalledTimes(60); expect(broadcast).toHaveBeenCalledTimes(60);
    expect(f.quota.get("messages:send:actor")).toBe(60);
  });
  it("shares actor quota across socket connections while keeping actors separate", async () => {
    f.quota.set("messages:send:actor", 60);
    const connection = runtime.io.on.mock.calls.find(([event]) => event === "connection")![1];
    function secondConnection(userId: string) {
      const handlers = new Map<string, Handler>();
      connection({ id: `second-${userId}`, data: { userId, userName: "Reader", globalRole: "USER" },
        on: (event: string, handler: Handler) => handlers.set(event, handler), emit: direct, to: vi.fn() });
      disconnects.push(() => handlers.get("disconnect")?.(undefined));
      return handlers.get("message:send")!;
    }
    const limited = vi.fn(); await secondConnection("actor")(input, limited);
    expect(limited).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "RateLimited", retryAfter: 60 });
    expect(f.database.task.findUnique).not.toHaveBeenCalled();
    f.options.outerTask = false;
    const other = vi.fn(); await secondConnection("other-actor")(input, other);
    expect(other).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" });
    expect(f.quota.get("messages:send:other-actor")).toBe(1); expect(f.quota.get("messages:send:actor")).toBe(60); noEffects();
  });
  it.each([false, true])("keeps blocked admission fail-closed and charged consistently with HTTP (marked=%s)", async marked => {
    if (marked) f.options.marker = [{ ...marker("SUBMITTED"), authorId: "actor" }]; f.options.blocked = true; const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" });
    expect(f.quota.get("messages:send:actor")).toBe(1); noEffects();
  });
  it.each([false, true])("denies a legacy actor blocked during task-lock wait, including replay=%s", async replay => {
    if (replay) f.options.existing = canonical();
    f.options.onTaskLock = async () => { f.options.blocked = true; };
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" });
    expect(f.tx.chatMessage.findUnique).not.toHaveBeenCalled(); noEffects();
  });
  it("fails closed on quota storage failure before task lookup or effects", async () => {
    f.options.quotaFailure = true; const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InternalError" });
    expect(f.database.task.findUnique).not.toHaveBeenCalled(); expect(f.database.$transaction).not.toHaveBeenCalled(); noEffects();
  });
  it("rejects malformed and INTERNAL requests without charging quota", async () => {
    await send({ ...input, clientId: "" }, vi.fn()); await send({ ...input, visibility: "INTERNAL" }, vi.fn());
    expect(f.database.$queryRaw).not.toHaveBeenCalled(); noEffects();
  });
  it("charges canonical replay admission without duplicate effects", async () => {
    f.options.existing = canonical(); const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.quota.get("messages:send:actor")).toBe(1);
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
    expect(direct).toHaveBeenCalledOnce();
  });
  it("guards resource/fresh policy before lookup/create and captures current notification facts", async () => {
    const ack = vi.fn(); await send(input, ack);
    expect(f.trace).toEqual(["tx1:start", "tx1:request-read", "tx1:project-lock", "tx1:task-lock", "tx1:actor-lock", "tx1:fresh-actor", "tx1:access", "tx1:marker", "tx1:fresh-actor", "tx1:existing", "tx1:current-task", "tx1:insert", "tx1:commit"]);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(broadcast).toHaveBeenCalledOnce(); expect(direct).not.toHaveBeenCalled();
    expect(runtime.delivery.task).toHaveBeenCalledExactlyOnceWith("task", "message:new", expect.objectContaining({ taskId: "task", id: "new-message" }), "project");
    expect(runtime.io.to).not.toHaveBeenCalled();
    expect(runtime.contentPersist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({taskId:"task",actorId:"actor",actorName:"Current author",event:"comment",visibility:"PUBLIC"}));
    expect(Object.keys((broadcast.mock.calls[0][1] as { author: Record<string, unknown> }).author).sort()).toEqual(["avatarUrl", "email", "id", "name"]);
    expect(f.state.messages).toHaveLength(1);
  });
  it("admits SUBMITTED author PUBLIC send with the committed attachment DTO through canonical content policy", async () => {
    f.options.contentRole = "author"; f.options.relation = "outsider";
    f.options.marker = [{ ...marker("SUBMITTED"), authorId: "actor" }];
    const attachment = { url: attachmentFileUrl("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f"), name: "proof.pdf", size: 42, mime: "application/pdf" };
    f.options.taskAttachments = [attachment];
    const ack = vi.fn(); await send({ ...input, attachments: [{ ...attachment, name: "forged", size: 1 }] }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(f.state.messages).toHaveLength(1);
    expect(f.tx.chatMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ attachments: [attachment] }) }));
  });
  it.each(["author", "executor", "watcher", "group"])("uses common content policy for a marked %s without legacy board-write rights", async contentRole => {
    f.options.contentRole = contentRole; f.options.relation = "outsider";
    f.options.marker = [{ ...marker("IN_PROGRESS"), authorId: contentRole === "author" ? "actor" : "author", executorId: contentRole === "executor" ? "actor" : "executor" }];
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.state.messages).toHaveLength(1);
  });
  it.each(["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED"])("retains canonical ADMIN reader comment policy in %s", async state => {
    f.options.role = "ADMIN"; f.options.marker = [marker(state)]; const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it.each(["DRAFT", "CANCELLED"])("denies %s before canonical replay even for nonauthor ADMIN", async state => {
    f.options.role = "ADMIN"; f.options.existing = canonical(); f.options.marker = [marker(state)]; const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "MutationRejected" }); expect(f.tx.chatMessage.findUnique).not.toHaveBeenCalled(); noEffects();
  });
  it.each(["deleted", "blocked", "reader"] as const)("denies marked replay after current %s admission changes", async field => {
    f.options.contentRole = "watcher"; f.options.relation = "outsider"; f.options.marker = [marker("CLOSED")]; f.options.existing = canonical();
    if (field === "reader") f.options.reader = false; else f.options[field] = true;
    const ack = vi.fn(); await send(input, ack);
    expect(ack.mock.calls[0][0].ok).toBe(false); expect(f.tx.chatMessage.findUnique).not.toHaveBeenCalled(); noEffects();
  });
  it("rechecks a task-only watcher revoked while waiting for the task lock", async () => {
    f.options.contentRole = "watcher"; f.options.relation = "outsider"; f.options.marker = [marker("NEEDS_INFO")];
    f.options.onTaskLock = async () => { f.options.contentRole = "none"; };
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" }); noEffects();
  });
  it("rechecks canonical watcher authority after P2002 before reading a replay", async () => {
    f.options.contentRole = "watcher"; f.options.relation = "outsider"; f.options.marker = [marker("SUBMITTED")]; f.options.race = true;
    f.options.onUnwind = () => { f.options.existing = canonical(); f.options.contentRole = "none"; };
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" });
    expect(f.tx.chatMessage.findUnique).toHaveBeenCalledOnce(); expect(f.state.messages).toEqual([]);
    expect(direct).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled();
  });
  it("does not deliver a canonical replay after common task read is revoked at commit", async () => {
    f.options.contentRole = "watcher"; f.options.relation = "outsider"; f.options.marker = [marker("CLOSED")]; f.options.existing = canonical();
    f.options.onCommit = () => { f.options.reader = false; };
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "AccessDenied" }); noEffects();
  });
  it("replays a marked comment without duplicate insert, broadcast or notification", async () => {
    f.options.contentRole = "author"; f.options.relation = "outsider";
    f.options.marker = [{ ...marker("NEEDS_INFO"), authorId: "actor" }]; f.options.existing = canonical();
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(direct).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ id: "message" }));
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled();
  });
  it.each([false, true])("refuses PUBLIC disclosure of a current internal attachment on replay=%s", async replay => {
    const attachment = { url: attachmentFileUrl("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f"), name: "private.pdf", size: 42, mime: "application/pdf", isInternal: true };
    f.options.role = "ADMIN"; f.options.marker = [marker("CLOSED")]; f.options.taskAttachments = [attachment];
    if (replay) f.options.existing = { ...canonical(), attachments: [{ ...attachment, isInternal: false }] };
    const ack = vi.fn(); await send({ ...input, attachments: [{ ...attachment, isInternal: undefined }] }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "ATTACHMENT_NOT_OWNED" }); noEffects();
  });
  it("does not reveal replay file metadata restricted after commit", async () => {
    const attachment = { url: attachmentFileUrl("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f"), name: "private.pdf", size: 42, mime: "application/pdf" };
    f.options.role = "ADMIN"; f.options.marker = [marker("CLOSED")]; f.options.taskAttachments = [attachment];
    f.options.existing = { ...canonical(), attachments: [attachment] };
    f.options.onCommit = () => { f.options.taskAttachments = [{ ...attachment, isInternal: true }]; };
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "AccessDenied" }); noEffects();
  });
  it("admits only the canonical draft author without granting arbitrary legacy write", async () => {
    f.options.contentRole = "author"; f.options.relation = "outsider";
    f.options.marker = [{ ...marker("DRAFT"), authorId: "actor" }];
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.state.messages).toHaveLength(1);
  });
  it("refuses marked task identity drift before replay or attachment resolution", async () => {
    f.options.contentRole = "author"; f.options.relation = "outsider";
    f.options.marker = [{ ...marker("SUBMITTED"), authorId: "actor" }]; f.options.drift = true;
    const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "MutationRejected" }); noEffects();
  });
  it.each([undefined, {}, [null], [{ ...marker(), state: "unknown" }]].map(value => ({ value })))("rejects malformed marker result %# before lookup", async ({ value }) => {
    f.options.marker = value; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "MutationRejected" }); expect(f.tx.chatMessage.findUnique).not.toHaveBeenCalled(); noEffects();
  });
  it.each(["query", "delegate"])("rejects %s storage failure without disclosure", async mode => {
    if (mode === "query") f.options.storageFailure = true; else Reflect.deleteProperty(f.tx, "taskRequest"); const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InternalError" }); expect(JSON.stringify(ack.mock.calls)).not.toMatch(/synthetic-private|authorId|executorId/); noEffects();
  });
  it.each(["owner", "member"])("retains actual ADMIN %s access", async relation => {
    f.options.role = "ADMIN"; f.options.relation = relation; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it("denies a fresh USER outsider despite cached socket ADMIN", async () => {
    f.options.role = "USER"; f.options.relation = "outsider"; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "AccessDenied" }); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noEffects();
  });
  it("admits a fresh ADMIN outsider through the same read policy as HTTP", async () => {
    f.options.role = "ADMIN"; f.options.relation = "outsider"; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.state.messages).toHaveLength(1);
  });
  it.each(["actor", "project", "task", "drift"] as const)("maps fresh %s denial without content", async field => {
    if (field === "drift") f.options.drift = true; else f.options[field] = false; const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: field === "drift" ? "MutationRejected" : "TaskNotFound" }); noEffects();
  });
  it("rechecks membership after waiting for Task lock before canonical content", async () => {
    f.options.existing = canonical(); f.options.role = "USER"; let entered!: () => void; let release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.options.onTaskLock = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const ack = vi.fn(); const pending = send(input, ack); await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled(); f.options.relation = "outsider"; release(); await pending;
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" }); expect(f.tx.chatMessage.findUnique).not.toHaveBeenCalled(); noEffects();
  });
  it("replays only canonical public DTO to requester before ACK without repeat effects", async () => {
    f.options.existing = canonical(); const ack = vi.fn(); await send({ ...input, contentText: "not-an-edit" }, ack);
    expect(direct).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ contentText: "Canonical edited", author: { id: "actor", email: "actor@example.test", name: "Current author", avatarUrl: null } }));
    expect(direct.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(broadcast).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled(); expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
  });
  it.each([{ taskId: "foreign-task" }, { authorId: "foreign-author" }, { clientId: "foreign-client" }])("rejects canonical identity conflict %j", async identity => {
    f.options.existing = { ...canonical(), ...identity }; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "ClientIdConflict" }); noEffects();
  });
  it("unwinds P2002 then rechecks guard in a second transaction before canonical lookup", async () => {
    f.options.race = true; f.options.onUnwind = () => { f.options.existing = canonical(); }; const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.database.$transaction).toHaveBeenCalledTimes(2);
    expect(f.trace.indexOf("tx1:unwind")).toBeLessThan(f.trace.indexOf("tx2:start")); expect(f.trace.indexOf("tx2:marker")).toBeLessThan(f.trace.indexOf("tx2:existing"));
    expect(f.state.messages).toEqual([]); expect(direct).toHaveBeenCalledOnce(); expect(broadcast).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled();
  });
  it.each(["marker", "access"])("denies %s changed between P2002 and replay", async reason => {
    f.options.race = true; f.options.onUnwind = () => { f.options.existing = canonical(); if (reason === "marker") f.options.marker = [marker()]; else f.options.relation = "outsider"; }; const ack = vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: reason === "marker" ? "MutationRejected" : "TaskNotFound" }); expect(f.tx.chatMessage.findUnique).toHaveBeenCalledOnce(); expect(direct).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled();
  });
  it("does not invent successful recovery when P2002 has no canonical row", async () => {
    f.options.race = true; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InternalError" }); expect(direct).not.toHaveBeenCalled();
  });
  it("does not retry unrelated storage failure", async () => {
    f.options.insertFailure = true; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InternalError" }); expect(f.database.$transaction).toHaveBeenCalledOnce();
  });
  it("acknowledges a hostile thrown proxy as fixed InternalError without inspecting its content", async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("synthetic-private-prototype"); } });
    f.tx.taskRequest.findMany.mockImplementation(async () => { throw hostile; });
    const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InternalError" }); noEffects();
  });
  it.each(["task-room", "notify-sync", "notify-async", "logger", "ack"])("retains committed success and independent effects on %s failure", async failure => {
    const error = new Error("synthetic-private-delivery");
    if (failure === "task-room") broadcast.mockImplementation(() => { throw error; });
    if (failure === "notify-sync") runtime.notify.mockImplementation(() => { throw error; }); if (failure === "notify-async") runtime.notify.mockRejectedValue(error);
    if (failure === "logger") { runtime.logger.info.mockImplementation(() => { throw error; }); runtime.logger.error.mockImplementation(() => { throw error; }); }
    const ack = failure === "ack" ? vi.fn(() => { throw error; }) : vi.fn(); await send(input, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.state.messages).toHaveLength(1);
    expect(runtime.delivery.task).toHaveBeenCalledExactlyOnceWith("task", "message:new", expect.objectContaining({ taskId: "task", id: "new-message" }), "project");
    expect(runtime.io.to).not.toHaveBeenCalled(); expect(runtime.notify).toHaveBeenCalledOnce();
  });
  it("keeps replay ACK successful when direct delivery throws", async () => {
    f.options.existing = canonical(); direct.mockImplementation(() => { throw new Error("delivery"); }); const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(runtime.notify).not.toHaveBeenCalled();
  });
  it("preserves text and attachments but does not infer recipients from plaintext @tokens", async () => {
    const attachment = {
      url: attachmentFileUrl("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f"),
      name: "a.png", size: 0.5, mime: "image/png", width: 10, height: 20,
    };
    f.options.taskAttachments = [attachment];
    const ack = vi.fn();
    await send({ ...input, contentText: "  Hi @one @two @one  ", attachments: [attachment] }, ack);
    expect(f.tx.user.findFirst).not.toHaveBeenCalled();
    const data = f.tx.chatMessage.create.mock.calls[0][0].data; expect(data).toMatchObject({ contentText: "  Hi @one @two @one  ", attachments: [attachment], mentions: [], reactions: {}, readBy: { actor: expect.any(String) } }); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });

  it("rejects a forged attachment URL before storing it", async () => {
    const ack = vi.fn();
    await send({ ...input, attachments: [{ url: "/a", name: "a", size: 0.5, mime: "image/png", width: 10, height: 20 }] }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "ATTACHMENT_NOT_OWNED" });
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
  });
  it.each(["outerTask", "outerAccess", "outerUser"] as const)("preserves early %s ACK", async field => {
    f.options[field] = false; const ack = vi.fn(); await send(input, ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: field === "outerTask" ? "TaskNotFound" : field === "outerAccess" ? "AccessDenied" : "UserNotFound" }); expect(f.database.$transaction).not.toHaveBeenCalled(); noEffects();
  });
});

describe("created-send current recipient file audience", () => {
  const file = { url: attachmentFileUrl("task", "0a6e3b9e-3dcb-402e-891a-d1074b75d40f"), name: "current.pdf", size: 42, mime: "application/pdf" };
  function readers() {
    const state = { group: true, admin: true, blocked: false, readable: true };
    const oldUser = f.database.user.findUnique.getMockImplementation()!;
    f.database.user.findUnique.mockImplementation(async (query?: unknown) => {
      const id = (query as { where: { id: string } }).where.id;
      return id === "actor" ? oldUser() : { id, globalRole: id === "admin" && state.admin ? "ADMIN" : "USER", isBlocked: state.blocked, blockedAt: null };
    });
    const oldRead = f.database.task.findFirst.getMockImplementation()!;
    f.database.task.findFirst.mockImplementation(async (query?: unknown) => JSON.stringify(query).includes('"actor"') ? oldRead() : state.readable ? { id: "task", projectId: "project" } : null);
    f.database.project.findUnique.mockImplementation(async () => ({ id: "project", ownerId: "actor", members: [], departmentId: null, department: null,
      responsibleGroupId: "group", responsibleGroup: { id: "group", archivedAt: null, members: state.group ? [{ userId: "group-reader" }] : [] } }));
    Object.assign(f.database.user, { findMany: vi.fn(async () => []) });
    return state;
  }
  const recipient = (id: string) => ({ id: `socket-${id}`, data: { userId: id, globalRole: "USER" }, rooms: new Set([`socket-${id}`, "task:task"]), emit: vi.fn(), leave: vi.fn() });
  it("rechecks after commit: ordinary watcher receives no restricted URL/name while current group and ADMIN readers receive the message", async () => {
    f.options.contentRole = "author"; f.options.relation = "outsider"; f.options.marker = [{ ...marker("SUBMITTED"), authorId: "actor" }];
    readers(); f.options.taskAttachments = [file];
    const watcher = recipient("watcher"), group = recipient("group-reader"), admin = recipient("admin");
    const actual = await vi.importActual<typeof import("./visibility-delivery")>("./visibility-delivery");
    const delivery = actual.createVisibilityDelivery({ ...runtime.policies!, sockets: () => [watcher, group, admin], isAccountAllowed: async () => true });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let delivered: Promise<void> | undefined;
    runtime.delivery.task.mockImplementation((...args: Parameters<typeof delivery.task>) => {
      delivered = gate.then(() => delivery.task(...args)); return delivered;
    });
    const ack = vi.fn(); await send({ ...input, attachments: [file] }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.state.messages).toHaveLength(1);
    f.options.taskAttachments = [{ ...file, isInternal: true }]; release(); await delivered;
    expect(watcher.emit).not.toHaveBeenCalled();
    expect(group.emit).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ attachments: [file] }));
    expect(admin.emit).toHaveBeenCalledExactlyOnceWith("message:new", expect.objectContaining({ attachments: [file] }));
    expect(runtime.notify).toHaveBeenCalledOnce();
  });
  it.each(["group", "admin", "blocked", "read"] as const)("honors %s revocation while current attachment metadata is awaiting", async change => {
    const state = readers(); f.options.taskAttachments = [{ ...file, isInternal: true }];
    const id = change === "admin" ? "admin" : "group-reader";
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const requested = new Promise<void>(resolve => { started = resolve; });
    f.database.task.findUnique.mockImplementation(async () => { started(); await gate; return { id: "task", projectId: "project", title: "Task", attachments: f.options.taskAttachments }; });
    const pending = runtime.policies!.canReadMessage!(id, "task", { id: "public-message", attachments: [file] });
    // A failed metadata lookup test must not hang if the old callback skips it.
    await Promise.race([requested, pending]);
    if (change === "group") state.group = false;
    if (change === "admin") state.admin = false;
    if (change === "blocked") state.blocked = true;
    if (change === "read") state.readable = false;
    release(); expect(await pending).toBe(false);
  });
  it.each(["missing", "malformed", "foreign"])("fails closed on %s current file metadata", async kind => {
    readers(); f.options.taskAttachments = kind === "missing" ? [] : kind === "malformed" ? [{ url: file.url, isInternal: false }] : [{ ...file, url: file.url.replace("/task/", "/foreign/") }];
    expect(await runtime.policies!.canReadMessage!("admin", "task", { id: "message", attachments: [file] })).toBe(false);
  });
  it("does not launder duplicate public metadata for a currently internal file", async () => {
    readers(); f.options.taskAttachments = [file, { ...file, isInternal: true }];
    expect(await runtime.policies!.canReadMessage!("watcher", "task", { id: "message", attachments: [file] })).toBe(false);
    expect(await runtime.policies!.canReadMessage!("admin", "task", { id: "message", attachments: [file] })).toBe(true);
  });
  it("fails closed on malformed file payload while retaining missing-file deletion events", async () => {
    expect(await runtime.policies!.canReadMessage!("watcher", "task", { id: "message", attachments: null })).toBe(false);
  });
  it("preserves attachment-free public deletion payload handling", async () => {
    expect(await runtime.policies!.canReadMessage!("watcher", "task", { messageId: "message", taskId: "task" })).toBe(true);
  });
});

afterEach(async () => {
  try {
    runtime.logger.info.mockReset();
    for (const disconnect of disconnects ?? []) await disconnect();
    expect(vi.getTimerCount(), "Fixture disconnect must clear every access sweep").toBe(0);
  } finally { vi.useRealTimers(); }
});

it("keeps the fixture access sweep asynchronous across repeated ticks", async () => {
  await vi.advanceTimersByTimeAsync(5000);
  expect(runtime.delivery.revalidate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(runtime.delivery.revalidate).toHaveBeenCalledTimes(2);
});


describe("explicit socket mention intent", () => {
  it("stores selected IDs and task_mentioned notification in the same transaction before post-commit delivery", async () => {
    const ack = vi.fn(); await send({ ...input, mentionUserIds: ["mentioned"] }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true }); expect(f.state.messages[0].mentions).toEqual(["mentioned"]);
    expect(f.state.notifications).toEqual([expect.objectContaining({ userId: "mentioned", type: "task_mentioned" })]);
    expect(f.trace.indexOf("tx1:mention-notification")).toBeLessThan(f.trace.indexOf("tx1:commit"));
    expect(runtime.mentionDeliver).toHaveBeenCalledOnce(); expect(runtime.contentPersist).toHaveBeenCalledWith(expect.objectContaining({ excludedRecipientIds: ["mentioned"] }));
    expect(f.tx.user.findFirst).not.toHaveBeenCalled();
  });
  it("rejects an inaccessible selected user atomically and reports no hidden identity", async () => {
    f.options.mentionRecipients = []; const ack = vi.fn(); await send({ ...input, mentionUserIds: ["hidden"] }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "MENTION_RECIPIENT_UNAVAILABLE" }); expect(f.state.messages).toEqual([]); expect(f.state.notifications).toEqual([]); noEffects();
  });
  it("rolls back a message if mention notification storage fails", async () => {
    f.options.mentionNotificationFailure = true; const ack = vi.fn(); await send({ ...input, mentionUserIds: ["mentioned"] }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InternalError" }); expect(f.state.messages).toEqual([]); expect(f.state.notifications).toEqual([]);
    expect(runtime.mentionDeliver).not.toHaveBeenCalled(); expect(runtime.notify).not.toHaveBeenCalled();
  });
  it("does not repeat mention effects on replay and rejects changing the selected ID set", async () => {
    const first = vi.fn(); await send({ ...input, mentionUserIds: ["mentioned"] }, first); f.options.existing = f.state.messages[0];
    const replay = vi.fn(); await send({ ...input, mentionUserIds: ["mentioned"] }, replay); expect(replay).toHaveBeenCalledWith({ ok: true });
    const conflict = vi.fn(); await send({ ...input, mentionUserIds: ["second"] }, conflict); expect(conflict).toHaveBeenCalledWith({ ok: false, error: "ClientIdConflict" });
    expect(f.state.messages).toHaveLength(1); expect(f.state.notifications).toHaveLength(1); expect(runtime.mentionDeliver).toHaveBeenCalledOnce();
  });
});
