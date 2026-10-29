import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  database: { user: { findUnique: vi.fn() }, task: { findUnique: vi.fn(), findFirst: vi.fn() }, project: { findUnique: vi.fn(), findFirst: vi.fn() } },
  io: { use: vi.fn(), on: vi.fn(), to: vi.fn() },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  taskDispatch: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('./visibility-delivery', () => ({ createVisibilityDelivery: () => ({
  task: runtime.taskDispatch, revalidate: runtime.revalidate, dispatch: vi.fn(),
}) }));
vi.mock("@prisma/client", async original => ({ ...await original<typeof import("@prisma/client")>(), PrismaClient: class { constructor() { return runtime.database; } } }));
vi.mock("socket.io", () => ({ Server: class { constructor() { return runtime.io; } } }));
vi.mock("@/lib/notification-triggers", () => ({ notifyChatMessage: vi.fn() }));
vi.mock("@/lib/logger", () => ({ socketLogger: runtime.logger, dbLogger: { error: vi.fn() } }));

type Handler = (payload?: unknown) => Promise<void> | void;
let handlers: Map<string, Handler>;
let emit: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>, socketTo: ReturnType<typeof vi.fn>;
const actor = { id: "actor", globalRole: "USER" };
const input = { taskId: "task", isTyping: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules(); vi.resetAllMocks();
  runtime.database.user.findUnique.mockResolvedValue(actor);
  runtime.database.task.findUnique.mockResolvedValue({ id: "task", projectId: "project" });
  runtime.database.task.findFirst.mockResolvedValue({ id: "task", projectId: "project" });
  runtime.database.project.findUnique.mockResolvedValue({ id: "project", ownerId: "other", members: [] });
  runtime.revalidate.mockResolvedValue(true);
  await import("./server");
  handlers = new Map(); emit = vi.fn(); socketTo = vi.fn(() => ({ emit }));
  runtime.taskDispatch.mockImplementation(async (_taskId: string, event: string, data: unknown) => { emit(event, data); });
  const connection = runtime.io.on.mock.calls.find(([event]) => event === "connection")![1];
  connection({ id: "socket", data: { userId: "actor", userName: "Existing display name", globalRole: "ADMIN" }, on: (event: string, handler: Handler) => handlers.set(event, handler), to: socketTo });
});

describe("registered typing handler common fresh read policy", () => {
  it("denies typing by a project reader who cannot read the personal task", async () => {
    runtime.database.project.findUnique.mockResolvedValue({ id: "project", ownerId: "actor", members: [] });
    runtime.database.task.findFirst.mockResolvedValue(null);
    await handlers.get("typing")!(input);
    expect(runtime.database.task.findFirst).toHaveBeenCalledOnce();
    expect(runtime.taskDispatch).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it("admits a fresh nonmember ADMIN using the same read policy as HTTP", async () => {
    runtime.database.user.findUnique.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
    await handlers.get("typing")!({ ...input, userId: "forged", userName: "Forged" });
    expect(emit).toHaveBeenCalledExactlyOnceWith("typing", { ...input, userId: "actor", userName: "Existing display name" });
    expect(runtime.taskDispatch).toHaveBeenCalledExactlyOnceWith('task', 'typing', { ...input, userId: 'actor', userName: 'Existing display name' }, undefined, 'socket');
    expect(socketTo).not.toHaveBeenCalled();
    expect(runtime.database.project.findFirst).not.toHaveBeenCalled();
    expect(runtime.database.user.findUnique).toHaveBeenCalledWith({ where: { id: "actor" }, select: { id: true, globalRole: true } });
  });
  it("denies a demoted nonmember despite cached socket ADMIN", async () => {
    runtime.database.user.findUnique.mockResolvedValueOnce({ id: "actor", globalRole: "ADMIN" }).mockResolvedValueOnce(actor);
    await handlers.get("typing")!(input); emit.mockClear(); socketTo.mockClear();
    await handlers.get("typing")!({ ...input, isTyping: false });
    expect(socketTo).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  });
  it("denies a revoked member on the next typing event", async () => {
    runtime.database.project.findUnique.mockResolvedValueOnce({ id: "project", ownerId: "other", members: [{ role: "MEMBER" }] });
    await handlers.get("typing")!(input); expect(emit).toHaveBeenCalledOnce();
    emit.mockClear(); await handlers.get("typing")!({ ...input, isTyping: false });
    expect(emit).not.toHaveBeenCalled();
  });
  it("denies a missing actor before task lookup or emission", async () => {
    runtime.database.user.findUnique.mockResolvedValue(null);
    await handlers.get("typing")!(input);
    expect(runtime.database.task.findUnique).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  });
  it("cancels an in-flight check on disconnect and ignores later typing events", async () => {
    const gate = deferred<{ id: string; ownerId: string; members: { role: string }[] }>();
    runtime.database.project.findUnique.mockReturnValueOnce(gate.promise);
    const pending = handlers.get("typing")!(input);
    await vi.waitFor(() => expect(runtime.database.project.findUnique).toHaveBeenCalledOnce());
    handlers.get("disconnect")!();
    gate.resolve({ id: "project", ownerId: "actor", members: [] }); await pending;
    expect(emit).not.toHaveBeenCalled();
    runtime.database.user.findUnique.mockClear(); await handlers.get("typing")!(input);
    expect(runtime.database.user.findUnique).not.toHaveBeenCalled();
  });
  it("keeps only the newest same-task state when actor lookup completes out of order", async () => {
    const gate = deferred<typeof actor>(); runtime.database.user.findUnique.mockReturnValueOnce(gate.promise);
    runtime.database.project.findUnique.mockResolvedValue({ id: "project", ownerId: "actor", members: [] });
    const pending = handlers.get("typing")!(input);
    await handlers.get("typing")!({ ...input, isTyping: false });
    gate.resolve(actor); await pending;
    expect(emit).toHaveBeenCalledExactlyOnceWith("typing", { taskId: "task", isTyping: false, userId: "actor", userName: "Existing display name" });
  });
  it.each([undefined, null, [], { taskId: "task:other", isTyping: true }, { taskId: "x".repeat(129), isTyping: true }, { taskId: "task", isTyping: "false" }])("drops malformed payload %# without DB work", async payload => {
    await expect(Promise.resolve(handlers.get("typing")!(payload))).resolves.toBeUndefined();
    expect(runtime.database.user.findUnique).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  });
  it("contains throwing getters and throwing diagnostics without a rejected handler", async () => {
    runtime.logger.error.mockImplementation(() => { throw new Error("Synthetic diagnostic failure"); });
    const payload = { get taskId(): string { throw new Error("synthetic-private-getter"); }, isTyping: true };
    await expect(Promise.resolve(handlers.get("typing")!(payload))).resolves.toBeUndefined();
    expect(runtime.database.user.findUnique).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  });
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
  expect(runtime.revalidate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(runtime.revalidate).toHaveBeenCalledTimes(2);
});
