import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ database: {} as object, io: { use: vi.fn(), on: vi.fn(), to: vi.fn() }, delivery: { task: vi.fn(), revalidate: vi.fn(), dispatch: vi.fn() }, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const contentAdmission = vi.hoisted(() => vi.fn());
vi.mock("@/features/kanban/server/task-lifecycle-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/features/kanban/server/task-lifecycle-service")>(),
  authorizeTaskRequestContentWrite: contentAdmission,
}));
vi.mock("@prisma/client", async importOriginal => ({ ...await importOriginal<typeof import("@prisma/client")>(), PrismaClient: class { constructor() { return new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }); } } }));
vi.mock("socket.io", () => ({ Server: class { constructor() { return runtime.io; } } }));
vi.mock("@/lib/notification-triggers", () => ({ notifyChatMessage: vi.fn() }));
vi.mock("@/lib/logger", () => ({ socketLogger: runtime.logger, dbLogger: { error: vi.fn() } }));
vi.mock("./visibility-delivery", () => ({ createVisibilityDelivery: () => runtime.delivery }));

type Message = { id: string; taskId: string; authorId: string; contentText: string; attachments: unknown[]; reactions: Record<string, string[]>; task: { projectId: string } };
type Handler = (payload: unknown, ack?: (result: { ok: boolean; error?: string }) => void) => Promise<void>;
const events = ["message:edit", "message:delete", "message:react"] as const;
type Event = typeof events[number];
const payload = (event: Event) => ({ taskId: "task", messageId: "message", ...(event === "message:edit" ? { contentText: "Edited", attachments: [] } : event === "message:react" ? { emoji: "👍", action: "add" } : {}) });
function fixture() {
  const state = { message: { id: "message", taskId: "task", authorId: "actor", contentText: "synthetic-private-original", attachments: [], reactions: { "👍": ["other"] }, task: { projectId: "project" } } as Message | null, version: 5 };
  let working = state;
  const options = { role: "USER", relation: "owner", actor: true, project: true, task: true, drift: false, marker: [] as unknown,
    storageFailure: false, childLock: true, currentMissing: false, currentTaskId: "task", currentProjectId: "project", currentAuthorId: "actor",
    outerMissing: false, outerAccess: true, outerTaskId: "task", outerAuthorId: "actor", commitFailure: false,
    onParentLock: undefined as undefined | (() => Promise<void>), onChildLock: undefined as undefined | (() => Promise<void>) };
  const trace: string[] = []; let active = false;
  const check = (name: string) => { if (!active) throw new Error("TX_METHOD_OUTSIDE_TX"); trace.push(name); };
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) { check("project-lock"); return options.project ? [{ id: "project" }] : []; }
      if (sql.includes('"isInternal"')) return [];
      if (sql.includes('FROM "Task"')) { check("task-lock"); await options.onParentLock?.(); return options.task ? [{ id: "task", projectId: options.drift ? "changed" : "project", priority: "MEDIUM", version: 5 }] : []; }
      if (sql.includes('FROM "ChatMessage"')) { check("child-lock"); expect(values).toEqual(["message", "task"]); expect(sql).toContain("FOR UPDATE"); await options.onChildLock?.(); return options.childLock ? [{ id: "message" }] : []; }
      check("actor-lock"); expect(sql).toContain("FOR SHARE"); return [{ id: "actor" }];
    }),
    user: { findUnique: vi.fn(async () => { check("fresh-actor"); return options.actor ? { id: "actor", globalRole: options.role, isBlocked: false, blockedAt: null } : null; }) },
    project: {
      findUnique: vi.fn(async () => { check("access"); return { ownerId: options.relation === "owner" ? "actor" : "other", members: options.relation === "member" ? [{ role: "MEMBER", userId: "actor" }] : [] }; }),
      findMany: vi.fn(async () => [{ id: "project" }]),
    },
    task: { findFirst: vi.fn(async () => ({ id: "task", projectId: "project" })), findUnique: vi.fn(async () => ({ id: "task", projectId: "project", attachments: [] })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    taskRequest: {
      findUnique: vi.fn(async () => Array.isArray(options.marker) && options.marker.length ? { taskId: "task" } : null),
      findMany: vi.fn(async () => { check("marker"); if (options.storageFailure) throw new Error("synthetic-private-storage"); return options.marker; }),
    },
    chatMessage: {
      findUnique: vi.fn(async () => { check("current-child"); return options.currentMissing || !working.message ? null : structuredClone({ ...working.message, taskId: options.currentTaskId, authorId: options.currentAuthorId, task: { projectId: options.currentProjectId } }); }),
      update: vi.fn(async ({ data, include }: { data: { contentText?: string; attachments?: unknown[]; reactions?: Record<string, string[]> }; include: { author: { select: Record<string, boolean> } } }) => {
        check("update"); if (data.contentText !== undefined) working.message!.contentText = data.contentText;
        if (data.attachments !== undefined) working.message!.attachments = data.attachments;
        if (data.reactions !== undefined) working.message!.reactions = data.reactions;
        const author = { id: "actor", email: "actor@example.test", name: "Actor", avatarUrl: null, passwordHash: "synthetic-private-password" };
        return { ...structuredClone(working.message), author: Object.fromEntries(Object.entries(author).filter(([key]) => include.author.select[key])) };
      }),
      delete: vi.fn(async () => { check("delete"); working.message = null; }),
    },
  };
  const database = {
    chatMessage: { findUnique: vi.fn(async () => options.outerMissing ? null : { authorId: options.outerAuthorId, taskId: options.outerTaskId, reactions: {}, task: { projectId: "project" } }) },
    task: { findFirst: vi.fn(async () => options.outerAccess ? { id: "task", projectId: "project" } : null) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    project: { findMany: vi.fn(async () => [{ id: "project" }]), findUnique: vi.fn(async () => options.outerAccess ? {
      id: "project",
      ownerId: options.relation === "owner" ? "actor" : "other",
      members: options.relation === "member" ? [{ role: "MEMBER", userId: "actor" }] : [],
    } : null) },
    user: { findUnique: vi.fn(async () => ({ id: "actor", globalRole: options.role })) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>, config: { isolationLevel: string }) => {
      expect(config).toEqual({ isolationLevel: "ReadCommitted" }); active = true; working = structuredClone(state); trace.push("begin");
      try { const result = await callback(tx); if (options.commitFailure) throw new Error("synthetic-private-commit"); Object.assign(state, working); trace.push("commit"); return result; }
      finally { active = false; }
    }),
  };
  return { state, options, tx, database, trace, setReactions: (reactions: Record<string, string[]>) => { working.message!.reactions = reactions; } };
}
let handlers: Map<string, Handler>, emit: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>, f: ReturnType<typeof fixture>;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules(); vi.resetAllMocks(); contentAdmission.mockResolvedValue({ allowed: false, code: "INVALID_TRANSITION" }); f = fixture(); runtime.database = f.database; runtime.delivery.revalidate.mockResolvedValue(true); await import("./server");
  emit = vi.fn(); runtime.io.to.mockReturnValue({ emit }); handlers = new Map();
  runtime.delivery.task.mockImplementation(async (_taskId, event, data) => { emit(event, data); });
  runtime.io.on.mock.calls.find(([event]) => event === "connection")![1]({ id: "socket", data: { userId: "actor", userName: "Actor", globalRole: "ADMIN" }, on: (event: string, handler: Handler) => handlers.set(event, handler), emit: vi.fn(), to: vi.fn() });
});
const marker = (state = "DRAFT") => ({ taskId: "task", contractVersion: 1, state, authorId: "author", executorId: ["DRAFT", "SUBMITTED"].includes(state) ? null : "executor" });
function noWrites() { expect(f.tx.chatMessage.update).not.toHaveBeenCalled(); expect(f.tx.chatMessage.delete).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled(); expect(runtime.delivery.task).not.toHaveBeenCalled(); }
function noChildren() { expect(f.trace).not.toContain("child-lock"); expect(f.tx.chatMessage.findUnique).not.toHaveBeenCalled(); noWrites(); }

it("admits a submitted request reaction through content authority without scalar write authority", async () => {
  f.options.marker = [marker("IN_PROGRESS")];
  contentAdmission.mockResolvedValue({ allowed: true, marked: true, state: "IN_PROGRESS" });
  const ack = vi.fn(); await handlers.get("message:react")!(payload("message:react"), ack);
  expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  expect(contentAdmission).toHaveBeenCalledExactlyOnceWith({ tx: f.tx, actorId: "actor", taskId: "task", expectedProjectId: "project", kind: "comment" });
  expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled();
  expect(f.state.message?.reactions["👍"]).toEqual(["other", "actor"]);
});

it("denies a reaction to an internal request message for a public reader", async () => {
  f.options.marker = [marker("IN_PROGRESS")];
  contentAdmission.mockResolvedValue({ allowed: true, marked: true, state: "IN_PROGRESS" });
  const original = f.tx.$queryRaw.getMockImplementation()!;
  f.tx.$queryRaw.mockImplementation(async (parts, ...values) => parts.join("?").includes('"isInternal"')
    ? [{ id: "message" }] : original(parts, ...values));
  const ack = vi.fn(); await handlers.get("message:react")!(payload("message:react"), ack);
  expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "AccessDenied" });
  noWrites();
});

// Own edit/delete now use the shared versioned command (covered by command + socket protocol suites).
describe.each(events.filter(event => event === "message:react"))("actual guarded %s", (event: Event) => {
  it("locks parents/actor/marker before child row and mutates only after current identity", async () => {
    const ack = vi.fn(); await handlers.get(event)!(payload(event), ack);
    expect(f.trace.slice(0, 9)).toEqual(["begin", "project-lock", "task-lock", "actor-lock", "fresh-actor", "access", "marker", "child-lock", "current-child"]);
    expect(f.trace.indexOf(event === "message:delete" ? "delete" : "update")).toBeGreaterThan(f.trace.indexOf("current-child")); expect(f.trace.at(-1)).toBe("commit");
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(runtime.io.to).not.toHaveBeenCalled(); expect(f.state.version).toBe(5);
    expect(runtime.delivery.task).toHaveBeenCalledExactlyOnceWith("task", event === "message:delete" ? "message:deleted" : "message:updated", expect.objectContaining(event === "message:delete" ? { taskId: "task", messageId: "message" } : { taskId: "task", id: "message" }));
    if (event !== "message:delete") expect((emit.mock.calls[0][1] as { author: unknown }).author).toEqual({ id: "actor", email: "actor@example.test", name: "Actor", avatarUrl: null });
  });
  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CANCELLED"])("denies %s even for ADMIN before child lock", async state => {
    f.options.role = "ADMIN"; f.options.marker = [marker(state)]; const ack = vi.fn(); await handlers.get(event)!(payload(event), ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "MutationRejected" }); noChildren();
  });
  it.each([undefined, {}, [null], [{ ...marker(), state: "unknown" }]].map(value => ({ value })))("denies malformed marker result %#", async ({ value }) => {
    f.options.marker = value; const ack = vi.fn(); await handlers.get(event)!(payload(event), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "MutationRejected" }); noChildren();
  });
  it.each(["query", "delegate", "hostile"])("handles %s storage failure safely", async failure => {
    if (failure === "query") f.options.storageFailure = true;
    if (failure === "delegate") Reflect.deleteProperty(f.tx, "taskRequest");
    if (failure === "hostile") f.tx.taskRequest.findMany.mockImplementation(async () => { throw new Proxy({}, { getPrototypeOf() { throw new Error("private"); } }); });
    const ack = vi.fn(); await handlers.get(event)!(payload(event), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InternalError" }); expect(JSON.stringify(ack.mock.calls)).not.toContain("synthetic-private"); noChildren();
  });
  it("denies a current USER outsider without child data", async () => {
    f.options.role = "USER"; f.options.relation = "outsider"; const ack = vi.fn(); await handlers.get(event)!(payload(event), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "AccessDenied" }); expect(f.tx.taskRequest.findMany).not.toHaveBeenCalled(); noChildren();
  });
  it("admits a current ADMIN outsider through the same policy as HTTP while keeping author checks", async () => {
    f.options.role = "ADMIN"; f.options.relation = "outsider"; const ack = vi.fn(); await handlers.get(event)!(payload(event), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it.each(["owner", "member"])("allows actual ADMIN %s without overriding author checks", async relation => {
    f.options.role = "ADMIN"; f.options.relation = relation; const ack = vi.fn(); await handlers.get(event)!(payload(event), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });
  it.each(["actor", "project", "task", "drift"] as const)("rejects fresh %s safely", async field => {
    if (field === "drift") f.options.drift = true; else f.options[field] = false; const ack = vi.fn(); await handlers.get(event)!(payload(event), ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: field === "drift" ? "MutationRejected" : "TaskNotFound" }); noChildren();
  });
  it("rechecks access after waiting for parent lock, before child lock", async () => {
    let entered!: () => void; let release!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.options.onParentLock = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const ack = vi.fn(); const pending = handlers.get(event)!(payload(event), ack); await waiting; expect(f.tx.user.findUnique).not.toHaveBeenCalled(); f.options.relation = "outsider"; release(); await pending;
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "TaskNotFound" }); noChildren();
  });
  it.each(["childLock", "currentMissing", "currentTaskId", "currentProjectId"] as const)("checks locked child %s", async field => {
    if (field === "childLock") f.options.childLock = false; else if (field === "currentMissing") f.options.currentMissing = true; else f.options[field] = "different";
    const ack = vi.fn(); await handlers.get(event)!(payload(event), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: field === "childLock" || field === "currentMissing" ? "MessageNotFound" : "AccessDenied" }); noWrites();
  });
  it("does not disclose a success or apply fake tx state if commit fails", async () => {
    const before = structuredClone(f.state); f.options.commitFailure = true; const ack = vi.fn(); await handlers.get(event)!(payload(event), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InternalError" }); expect(f.state).toEqual(before); expect(emit).not.toHaveBeenCalled();
  });
  it.each(["emit", "logger", "ack"])("retains committed success despite %s failure", async failure => {
    const error = new Error("synthetic-private-delivery"); if (failure === "emit") emit.mockImplementation(() => { throw error; });
    if (failure === "logger") { runtime.logger.info.mockImplementation(() => { throw error; }); runtime.logger.error.mockImplementation(() => { throw error; }); }
    const ack = failure === "ack" ? vi.fn(() => { throw error; }) : vi.fn(); await handlers.get(event)!(payload(event), ack);
    expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(f.trace).toContain("commit"); expect(runtime.io.to).not.toHaveBeenCalled();
    expect(runtime.delivery.task).toHaveBeenCalledExactlyOnceWith("task", event === "message:delete" ? "message:deleted" : "message:updated", expect.objectContaining(event === "message:delete" ? { taskId: "task", messageId: "message" } : { taskId: "task", id: "message" }));
  });
  it("keeps technical diagnostics free of reaction/content fields", async () => {
    const ack = vi.fn(); await handlers.get(event)!(payload(event), ack);
    for (const [fields] of runtime.logger.info.mock.calls) { expect(fields).not.toHaveProperty("emoji"); expect(fields).not.toHaveProperty("contentText"); }
  });
});

it.each(["message:edit", "message:delete"] as const)("%s rejects obsolete unversioned commands before DB work", async event => {
  const ack = vi.fn(); await handlers.get(event)!(payload(event), ack);
  expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InvalidMessageCommand" }); noChildren();
});
it("reaction uses the latest locked map and preserves independent users", async () => {
  f.options.onChildLock = async () => { f.setReactions({ "👍": ["concurrent"], "other-emoji": ["peer"] }); };
  const ack = vi.fn(); await handlers.get("message:react")!(payload("message:react"), ack);
  expect(f.state.message!.reactions).toEqual({ "👍": ["concurrent", "actor"], "other-emoji": ["peer"] }); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
});
it("reaction does not inherit author-only edit restrictions", async () => {
  f.options.currentAuthorId = "other"; const ack = vi.fn(); await handlers.get("message:react")!(payload("message:react"), ack); expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true });
});
it.each(["empty-edit", "remove-missing"])("guards accepted %s before child effects", async mode => {
  f.options.marker = [marker()]; const ack = vi.fn(); await handlers.get(mode === "empty-edit" ? "message:edit" : "message:react")!({ taskId: "task", messageId: "message", ...(mode === "remove-missing" ? { emoji: "missing", action: "remove" } : {}) }, ack);
  expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: mode === "empty-edit" ? "InvalidMessageCommand" : "MutationRejected" }); noChildren();
});
it("rejects unversioned empty edit and arbitrary attachment JSON", async () => {
  const ack = vi.fn(); await handlers.get("message:edit")!({ taskId: "task", messageId: "message" }, ack);
  expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InvalidMessageCommand" }); expect(f.state.message!.contentText).toBe("synthetic-private-original");
  const forged = vi.fn();
  await handlers.get("message:edit")!({ taskId: "task", messageId: "message", contentText: "", attachments: [{ custom: "legacy" }] }, forged);
  expect(forged).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "InvalidMessageCommand" });
  expect(f.state.message!.contentText).toBe("synthetic-private-original");
  expect(f.state.message!.attachments).toEqual([]);
});

afterEach(async () => {
  try {
    runtime.logger.info.mockReset();
    await handlers?.get("disconnect")?.(undefined);
    expect(vi.getTimerCount(), "Fixture disconnect must clear every access sweep").toBe(0);
  } finally { vi.useRealTimers(); }
});

it("keeps the fixture access sweep asynchronous across repeated ticks", async () => {
  await vi.advanceTimersByTimeAsync(5000);
  expect(runtime.delivery.revalidate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(runtime.delivery.revalidate).toHaveBeenCalledTimes(2);
});
