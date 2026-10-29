import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentFileUrl } from "@/lib/attachments/task-port";

const dependencies = vi.hoisted(() => ({
  prisma: {
    chatMessage: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    project: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(async () => [{ id: "private-project" }]) },
    task: { findUnique: vi.fn(), findFirst: vi.fn(async () => ({ id: "private-task", projectId: "private-project" })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    taskRequest: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  io: { use: vi.fn(), on: vi.fn(), to: vi.fn() },
  notify: vi.fn(),
  taskDispatch: vi.fn(),
  revalidate: vi.fn(),
  messageRead: null as null | ((userId: string, taskId: string, data: unknown) => Promise<boolean>),
}));

// Exercise the registered production handler while keeping DB/network external.
vi.mock("@prisma/client", async importOriginal => ({
  ...await importOriginal<typeof import("@prisma/client")>(),
  PrismaClient: class { constructor() { return dependencies.prisma; } },
}));
vi.mock("socket.io", () => ({
  Server: class { constructor() { return dependencies.io; } },
}));
vi.mock("@/app/api/tasks/[id]/messages/discussion-notifications",()=>({persistTaskContentNotifications:async()=>[{id:"ordinary-notification"}]}));
vi.mock("@/lib/notifications",async original=>({...await original<typeof import("@/lib/notifications")>(),deliverNotifications:dependencies.notify}));
vi.mock("./visibility-delivery", () => ({ createVisibilityDelivery: (options: { canReadMessage: typeof dependencies.messageRead }) => {
  dependencies.messageRead = options.canReadMessage;
  return { task: dependencies.taskDispatch, revalidate: dependencies.revalidate, dispatch: vi.fn() };
} }));
vi.mock("@/lib/logger", () => ({
  socketLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Payload = {
  taskId: string; messageId: string; emoji?: string; action?: "add" | "remove";
  contentText?: string; attachments?: unknown[];
};
type Handler = (payload: unknown, ack?: (result: unknown) => void) => Promise<void>;
let react: Handler;
let handlers: Map<string, Handler>;
let emit: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let socketTo: ReturnType<typeof vi.fn>;
let direct: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.resetAllMocks();
  dependencies.revalidate.mockResolvedValue(true);
  await import("./server");
  const connection = dependencies.io.on.mock.calls.find(([event]) => event === "connection")?.[1];
  handlers = new Map<string, Handler>();
  emit = vi.fn();
  dependencies.taskDispatch.mockImplementation(async (_taskId: string, event: string, data: unknown) => { emit(event, data); });
  socketTo = vi.fn(() => ({ emit }));
  direct = vi.fn();
  connection({
    id: "socket-1",
    data: { userId: "user-1", userName: "User", globalRole: "USER" },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    to: socketTo,
    emit: direct,
  });
  react = handlers.get("message:react")!;
  dependencies.io.to.mockReturnValue({ emit });
  dependencies.prisma.chatMessage.findUnique.mockResolvedValue({
    authorId: "user-1", taskId: "private-task", reactions: {}, task: { projectId: "private-project" },
  });
  dependencies.prisma.project.findFirst.mockResolvedValue(null);
  dependencies.prisma.task.findUnique.mockResolvedValue({ id: "private-task", projectId: "private-project" });
  dependencies.prisma.chatMessage.update.mockResolvedValue({
    id: "message-1", taskId: "private-task", contentText: "Private text",
    reactions: { "👍": ["user-1"] },
  });
  dependencies.prisma.$queryRaw.mockImplementation(async (parts: TemplateStringsArray) => {
    const sql = parts.join("?");
    if (sql.includes('FROM "Project"')) return [{ id: "private-project" }];
    if (sql.includes('"isInternal"')) return [];
    if (sql.includes('FROM "Task"')) return [{ id: "private-task", projectId: "private-project", priority: "MEDIUM", version: 0 }];
    return [{ id: "message-1" }];
  });
  dependencies.prisma.project.findUnique.mockResolvedValue({ id: "private-project", department: null, ownerId: "user-1", members: [] });
  dependencies.prisma.user.findUnique.mockResolvedValue({ id: "user-1", globalRole: "USER", isBlocked: false, blockedAt: null });
  dependencies.prisma.taskRequest.findMany.mockResolvedValue([]);
  dependencies.prisma.taskRequest.findUnique.mockResolvedValue(null);
    // message:send/edit use the shared task lock; supply the rows it locks.
    dependencies.prisma.$queryRaw.mockImplementation(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('"Project"')) return [{ id: "private-project" }];
      if (sql.includes('"Task"')) return [{ id: "private-task", projectId: "private-project", priority: "MEDIUM", version: 1 }];
      return [{ id: "user-1" }];
    });
    dependencies.prisma.$transaction.mockImplementation(async (operation: (tx: typeof dependencies.prisma) => Promise<unknown>) => operation(dependencies.prisma));
  dependencies.prisma.$transaction.mockImplementation(async (operation: (tx: typeof dependencies.prisma) => Promise<unknown>) => operation(dependencies.prisma));
});

describe("message:send idempotency", () => {
  const input = { taskId: "private-task", clientId: "client-1", contentText: "Hello", attachments: [] };
  const canonical = {
    id: "message-1", taskId: "private-task", clientId: "client-1", authorId: "user-1", contentText: "Edited text",
    attachments: [], mentions: [], reactions: {}, readBy: {}, createdAt: new Date("2026-01-01"),
    author: { id: "user-1", email: "user@example.invalid", name: "User", avatarUrl: null },
  };
  beforeEach(() => {
    dependencies.prisma.chatMessage.findUnique.mockResolvedValue(null);
    dependencies.prisma.project.findFirst.mockResolvedValue({ id: "private-project" });
    dependencies.prisma.task.findUnique.mockResolvedValue({ id: "private-task", projectId: "private-project", title: "Task" });
    dependencies.prisma.user.findUnique.mockResolvedValue({ ...canonical.author, globalRole: "USER", isBlocked: false, blockedAt: null });
    dependencies.prisma.user.findFirst.mockResolvedValue(null);
    dependencies.prisma.chatMessage.create.mockResolvedValue(canonical);
    dependencies.notify.mockResolvedValue(undefined);
  });

  it("creates, broadcasts and notifies once for a new operation", async () => {
    const ack = vi.fn();
    await handlers.get("message:send")!(input, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(dependencies.prisma.chatMessage.create).toHaveBeenCalledOnce();
    expect(dependencies.notify).toHaveBeenCalledOnce();
    expect(dependencies.taskDispatch).toHaveBeenCalledExactlyOnceWith('private-task', 'message:new', canonical, 'private-project');
    expect(dependencies.io.to).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledExactlyOnceWith('message:new', canonical);
  });

  it("replays the current canonical message directly before acknowledgement without rewriting or notifying", async () => {
    dependencies.prisma.chatMessage.findUnique.mockResolvedValue(canonical);
    const ack = vi.fn();
    await handlers.get("message:send")!(input, ack);
    expect(direct).toHaveBeenCalledExactlyOnceWith("message:new", canonical);
    expect(direct.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(dependencies.prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(dependencies.notify).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("recovers a concurrent clientId unique conflict using the canonical message", async () => {
    dependencies.prisma.chatMessage.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(canonical);
    dependencies.prisma.chatMessage.create.mockRejectedValue({ code: "P2002", meta: { target: ["clientId"] } });
    const ack = vi.fn();
    await handlers.get("message:send")!(input, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(direct).toHaveBeenCalledExactlyOnceWith("message:new", canonical);
    expect(dependencies.notify).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([{ authorId: "other-author" }, { taskId: "other-task" }])("rejects a foreign operation %j without disclosing its message", async identity => {
    dependencies.prisma.chatMessage.findUnique.mockResolvedValue({ ...canonical, ...identity });
    const ack = vi.fn();
    await handlers.get("message:send")!(input, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "ClientIdConflict" });
    expect(direct).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(dependencies.notify).not.toHaveBeenCalled();
  });

  it("does not turn unrelated create failures into successful replays", async () => {
    dependencies.prisma.chatMessage.create.mockRejectedValue(new Error("Database unavailable"));
    const ack = vi.fn();
    await handlers.get("message:send")!(input, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InternalError" });
    expect(direct).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, [], { ...input, clientId: "" }, { ...input, clientId: " " },
    { ...input, clientId: "x".repeat(201) }, { ...input, taskId: 7 },
    { ...input, contentText: 3 }, { ...input, contentText: "x".repeat(20001) },
    { ...input, contentText: " " }, { ...input, attachments: "bad" },
    { ...input, attachments: [{}] },
  ])("rejects malformed send payload %# before DB work", async value => {
    const ack = vi.fn();
    await handlers.get("message:send")!(value, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InvalidMessagePayload" });
    expect(dependencies.prisma.task.findUnique).not.toHaveBeenCalled();
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });
});

describe("message:send visibility and attachment boundary", () => {
  const fileId = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
  const stored = { url: attachmentFileUrl("private-task", fileId), name: "report.pdf", size: 42, mime: "application/pdf" };
  const input = { taskId: "private-task", clientId: "client-1", contentText: "Hello", attachments: [] as unknown[] };

  beforeEach(() => {
    dependencies.prisma.chatMessage.findUnique.mockResolvedValue(null);
    dependencies.prisma.project.findFirst.mockResolvedValue({ id: "private-project" });
    dependencies.prisma.task.findUnique.mockResolvedValue({
      id: "private-task", projectId: "private-project", title: "Task", attachments: [stored],
    });
    dependencies.prisma.user.findUnique.mockResolvedValue({ id: "user-1", globalRole: "USER", isBlocked: false, blockedAt: null });
    dependencies.prisma.user.findFirst.mockResolvedValue(null);
    dependencies.prisma.chatMessage.create.mockResolvedValue({
      id: "message-1", taskId: "private-task", clientId: "client-1", authorId: "user-1",
      contentText: "Hello", attachments: [], mentions: [], reactions: {}, createdAt: new Date("2026-01-01"),
      author: { id: "user-1", email: "user@example.invalid", name: "User", avatarUrl: null },
    });
    dependencies.notify.mockResolvedValue(undefined);
  });

  it("refuses an INTERNAL send on the socket instead of storing it as public", async () => {
    const ack = vi.fn();
    await handlers.get("message:send")!({ ...input, visibility: "INTERNAL" }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InternalRequiresHttp" });
    expect(dependencies.prisma.task.findUnique).not.toHaveBeenCalled();
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses an INTERNAL send that also carries attachments", async () => {
    const ack = vi.fn();
    await handlers.get("message:send")!({ ...input, visibility: "INTERNAL", attachments: [stored] }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InternalRequiresHttp" });
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("rejects an attachment URL that is not present in the task metadata", async () => {
    const ack = vi.fn();
    await handlers.get("message:send")!({
      ...input,
      attachments: [{ ...stored, url: attachmentFileUrl("other-task", fileId) }],
    }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "ATTACHMENT_NOT_OWNED" });
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(dependencies.notify).not.toHaveBeenCalled();
  });

  it("rejects an external URL and client-supplied metadata", async () => {
    const ack = vi.fn();
    await handlers.get("message:send")!({
      ...input,
      attachments: [{ url: "https://public.example/report.pdf", name: "evil.html", size: 1, mime: "text/html" }],
    }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "ATTACHMENT_NOT_OWNED" });
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it("stores the committed DTO rather than the client name, size or mime", async () => {
    const ack = vi.fn();
    await handlers.get("message:send")!({
      ...input,
      attachments: [{ url: stored.url, name: "evil.html", size: 1, mime: "text/html" }],
    }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(dependencies.prisma.chatMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attachments: [stored] }),
    }));
  });

  it("caps a message at the shared five-file limit before DB work", async () => {
    const ack = vi.fn();
    await handlers.get("message:send")!({
      ...input, attachments: Array.from({ length: 6 }, () => stored),
    }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InvalidMessagePayload" });
    expect(dependencies.prisma.chatMessage.create).not.toHaveBeenCalled();
  });
});

describe("message correction explicit command boundary", () => {
  it.each([[], [{ url: "/foreign", name: "File", size: 1, mime: "text/plain" }], [{ custom: "forged" }]].map(attachments => ({ attachments })))("rejects attachment edits even with a valid command: %j", async ({ attachments }) => {
    const ack = vi.fn(); await handlers.get("message:edit")!({ taskId: "private-task", messageId: "message-1", operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 0, contentText: "After", attachments }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InvalidMessageCommand" }); expect(dependencies.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("typing authorization", () => {
  beforeEach(() => {
    dependencies.prisma.project.findUnique.mockResolvedValue({ id: "private-project", department: null, ownerId: "other", members: [] });
  });
  it("does not let an older slow typing event overwrite a newer stop event", async () => {
    dependencies.prisma.project.findUnique.mockResolvedValue({ id: "private-project", department: null, ownerId: "user-1", members: [] });
    let finishFirst!: (task: { id: string; projectId: string }) => void;
    dependencies.prisma.task.findUnique.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    const first = handlers.get("typing")!({ taskId: "private-task", isTyping: true });
    await handlers.get("typing")!({ taskId: "private-task", isTyping: false });
    finishFirst({ id: "private-task", projectId: "private-project" });
    await first;
    expect(emit).toHaveBeenCalledExactlyOnceWith("typing", {
      taskId: "private-task", userId: "user-1", userName: "User", isTyping: false,
    });
  });

  it.each([true, false])("delivers isTyping=%s only after current project authorization using authenticated identity", async (isTyping) => {
    dependencies.prisma.project.findUnique.mockResolvedValue({ id: "private-project", department: null, ownerId: "user-1", members: [] });
    await handlers.get("typing")!({ taskId: "private-task", isTyping, userId: "forged-user", userName: "Forged" });
    expect(dependencies.prisma.task.findUnique).toHaveBeenCalledWith({
      where: { id: "private-task" }, select: { id: true, projectId: true },
    });
    expect(dependencies.prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: "private-project" },
      select: { id: true, ownerId: true, department: { select: { id: true, archivedAt: true } }, members: { where: { userId: "user-1" }, select: { role: true }, take: 1 },
        responsibleGroup: { select: { archivedAt: true, members: { where: { userId: "user-1" }, select: { userId: true }, take: 1 } } } },
    });
    expect(dependencies.taskDispatch).toHaveBeenCalledExactlyOnceWith('private-task', 'typing', {
      taskId: 'private-task', userId: 'user-1', userName: 'User', isTyping,
    }, undefined, 'socket-1');
    expect(emit).toHaveBeenCalledExactlyOnceWith("typing", {
      taskId: "private-task", userId: "user-1", userName: "User", isTyping,
    });
    expect(dependencies.io.to).not.toHaveBeenCalled();
  });

  it("does not broadcast into a task the user cannot access", async () => {
    await handlers.get("typing")!({ taskId: "private-task", isTyping: true });
    expect(socketTo).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("checks access again after membership is revoked", async () => {
    dependencies.prisma.project.findUnique.mockResolvedValueOnce({ id: "private-project", department: null, ownerId: "user-1", members: [] });
    await handlers.get("typing")!({ taskId: "private-task", isTyping: true });
    emit.mockClear();
    socketTo.mockClear();
    await handlers.get("typing")!({ taskId: "private-task", isTyping: false });
    expect(socketTo).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not broadcast for a missing task", async () => {
    dependencies.prisma.task.findUnique.mockResolvedValue(null);
    await handlers.get("typing")!({ taskId: "private-task", isTyping: true });
    expect(dependencies.prisma.project.findUnique).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "string", value: "private-task" },
    { label: "array", value: [] },
    { label: "missing task", value: { isTyping: true } },
    { label: "non-string task", value: { taskId: 42, isTyping: true } },
    { label: "empty task", value: { taskId: "", isTyping: true } },
    { label: "whitespace task", value: { taskId: "  ", isTyping: true } },
    { label: "missing typing state", value: { taskId: "private-task" } },
    { label: "string typing state", value: { taskId: "private-task", isTyping: "false" } },
    { label: "number typing state", value: { taskId: "private-task", isTyping: 1 } },
  ])("drops malformed $label payloads before DB or broadcast", async ({ value }) => {
    await handlers.get("typing")!(value);
    expect(dependencies.prisma.task.findUnique).not.toHaveBeenCalled();
    expect(dependencies.prisma.project.findUnique).not.toHaveBeenCalled();
    expect(socketTo).not.toHaveBeenCalled();
  });

  it.each(["task", "project"] as const)("contains %s lookup errors without a rejected handler or broadcast", async (lookup) => {
    const method = lookup === "task" ? dependencies.prisma.task.findUnique : dependencies.prisma.project.findUnique;
    method.mockRejectedValueOnce(new Error("Database unavailable"));
    await handlers.get("typing")!({ taskId: "private-task", isTyping: true });
    expect(socketTo).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe.each(["message:edit", "message:delete"])("%s backwards protocol boundary", event => {
  it("rejects unversioned requests without querying messages or granting cached author access", async () => {
    const ack = vi.fn(); await handlers.get(event)!({ taskId: "private-task", messageId: "message-1", ...(event === "message:edit" ? { contentText: "After" } : {}) }, ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InvalidMessageCommand" }); expect(dependencies.prisma.chatMessage.findUnique).not.toHaveBeenCalled(); expect(dependencies.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("message:react authorization", () => {
  const payload: Payload = { taskId: "private-task", messageId: "message-1", emoji: "👍", action: "add" };
  it("uses the current reactions after locking, not the earlier authorization snapshot", async () => {
    dependencies.prisma.project.findFirst.mockResolvedValue({ id: "private-project" });
    dependencies.prisma.chatMessage.findUnique
      .mockResolvedValueOnce({ taskId: "private-task", reactions: {}, task: { projectId: "private-project" } })
      .mockResolvedValueOnce({ taskId: "private-task", reactions: { "👍": ["other-user"] }, task: { projectId: "private-project" } });
    const ack = vi.fn();
    await react(payload, ack);
    expect(dependencies.prisma.chatMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { reactions: { "👍": ["other-user", "user-1"] } },
    }));
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it("rejects access revoked while waiting for the message lock", async () => {
    const allowed = { id: "private-project", department: null, ownerId: "user-1", members: [] };
    dependencies.prisma.project.findUnique
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce(null);
    const ack = vi.fn();
    await react(payload, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "AccessDenied" });
    expect(dependencies.prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not emit when the message disappeared before acquiring its lock", async () => {
    dependencies.prisma.project.findFirst.mockResolvedValue({ id: "private-project" });
    const normalLock = dependencies.prisma.$queryRaw.getMockImplementation()!;
    dependencies.prisma.$queryRaw.mockImplementation(async (parts: TemplateStringsArray) =>
      parts.join("?").includes('FROM "ChatMessage"') ? [] : normalLock(parts));
    const ack = vi.fn();
    await react(payload, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "MessageNotFound" });
    expect(dependencies.prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not emit a success snapshot if the transaction fails", async () => {
    dependencies.prisma.project.findFirst.mockResolvedValue({ id: "private-project" });
    dependencies.prisma.$transaction.mockRejectedValue(new Error("Transaction failed"));
    const ack = vi.fn();
    await react(payload, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InternalError" });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "array", value: [] },
    { label: "missing message", value: { taskId: "private-task", emoji: "👍", action: "add" } },
    { label: "empty task", value: { ...payload, taskId: " " } },
    { label: "unknown action", value: { ...payload, action: "toggle" } },
    { label: "missing emoji", value: { ...payload, emoji: undefined } },
    { label: "empty emoji", value: { ...payload, emoji: " " } },
    { label: "oversized emoji", value: { ...payload, emoji: "x".repeat(65) } },
    { label: "prototype key", value: { ...payload, emoji: "__proto__" } },
    { label: "constructor key", value: { ...payload, emoji: "constructor" } },
    { label: "prototype property", value: { ...payload, emoji: "prototype" } },
  ])("rejects malformed $label reaction before accessing the database", async ({ value }) => {
    const ack = vi.fn();
    await react(value, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "InvalidReactionPayload" });
    expect(dependencies.prisma.chatMessage.findUnique).not.toHaveBeenCalled();
    expect(dependencies.prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not write or emit when the message no longer exists", async () => {
    dependencies.prisma.chatMessage.findUnique.mockResolvedValue(null);
    const ack = vi.fn();
    await react(payload, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "MessageNotFound" });
    expect(dependencies.prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a non-member without writing or disclosing the message", async () => {
    dependencies.prisma.project.findUnique.mockResolvedValue(null);
    const ack = vi.fn();
    await react(payload, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "AccessDenied" });
    expect(dependencies.prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a forged task id rather than broadcasting private text into that room", async () => {
    dependencies.prisma.project.findFirst.mockResolvedValue({ id: "private-project" });
    const ack = vi.fn();
    await react({ ...payload, taskId: "attacker-task" }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: "AccessDenied" });
    expect(dependencies.prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(dependencies.io.to).not.toHaveBeenCalled();
  });

  it("authorizes the actual message project and delivers an allowed reaction", async () => {
    const ack = vi.fn();
    await react(payload, ack);
    expect(dependencies.prisma.chatMessage.findUnique).toHaveBeenCalledWith({
      where: { id: "message-1" },
      select: { id: true, deletedAt: true, attachments: true, reactions: true, taskId: true, task: { select: { projectId: true } } },
    });
    expect(dependencies.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" }, select: { id: true, globalRole: true },
    });
    expect(dependencies.prisma.project.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "private-project" },
    }));
    expect(dependencies.prisma.chatMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "message-1" }, data: { reactions: { "👍": ["user-1"] } },
    }));
    expect(dependencies.io.to).not.toHaveBeenCalled();
    expect(dependencies.taskDispatch).toHaveBeenCalledExactlyOnceWith('private-task', 'message:updated', expect.objectContaining({ id: 'message-1' }));
    expect(emit).toHaveBeenCalledWith("message:updated", expect.objectContaining({ id: "message-1" }));
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });
});

afterEach(async () => {
  try {
    await handlers?.get("disconnect")?.(undefined);
    expect(vi.getTimerCount(), "Fixture disconnect must clear every access sweep").toBe(0);
  } finally { vi.useRealTimers(); }
});

it("keeps the fixture access sweep asynchronous across repeated ticks", async () => {
  await vi.advanceTimersByTimeAsync(5000);
  expect(dependencies.revalidate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(dependencies.revalidate).toHaveBeenCalledTimes(2);
});

it("suppresses a late message DTO after another edit or soft deletion before realtime delivery", async () => {
  dependencies.prisma.chatMessage.findUnique.mockResolvedValue({taskId:"private-task",version:2,deletedAt:null});
  expect(await dependencies.messageRead!("user-1","private-task",{id:"message-1",version:1,contentText:"Earlier text",attachments:[]})).toBe(false);
  dependencies.prisma.chatMessage.findUnique.mockResolvedValue({taskId:"private-task",version:2,deletedAt:new Date()});
  expect(await dependencies.messageRead!("user-1","private-task",{id:"message-1",version:2,contentText:"Earlier text",attachments:[]})).toBe(false);
  expect(await dependencies.messageRead!("user-1","private-task",{id:"message-1",version:2,deletedAt:new Date(),contentText:"",attachments:[]})).toBe(true);
});
